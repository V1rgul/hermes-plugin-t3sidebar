"""Installed native read contracts against scratch DBs/doubles, never live history."""
import asyncio
from contextlib import closing
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace, ModuleType
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from hermes_state import SessionDB
from gateway.session_contract import Principal, SessionHandle, SessionRef
from gateway.session_live_listing import LiveEntry

import gateway.session_live_listing as listing_module

from test_backend import backend


class NativeContracts(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="flow-native-contract-")
		self.addCleanup(self.temp.cleanup)
		self.path = Path(self.temp.name)

	def client(self, **kwargs):
		app = FastAPI()
		app.include_router(backend.create_router(self.path / "flow.sqlite3", profile_reader=lambda: "exact-profile", **kwargs))
		client = TestClient(app)
		self.addCleanup(client.close)
		return client

	def test_runtime_injection_is_profile_exact_and_query_cannot_select_owner(self):
		calls = []
		async def read(request, profile):
			calls.append(profile)
			return {"sessions": [{"session_key": "collision", "status": "waiting"}]}
		client = self.client(runtime_reader=read)
		response = client.get("/runtime")
		self.assertEqual(response.status_code, 200)
		self.assertEqual(response.headers["cache-control"], "no-store")
		self.assertEqual(response.json()["profile"], "exact-profile")
		self.assertEqual(client.get("/runtime?profile=foreign").status_code, 422)
		self.assertEqual(calls, ["exact-profile"])

	def test_runtime_uses_native_waiting_and_read_only_principal(self):
		# The authority/principal resolver is injected, the active_list implementation is real.
		fake = ModuleType("hermes_cli.web_server_sessions")
		authority = object()
		actor = Principal("authenticated-subject", "profile-authority", frozenset({"session:read", "session:control"}), "http")
		setattr(fake, "_session_mutation_context", lambda request, profile: (authority, actor))
		controls = SimpleNamespace(snapshot=lambda sid, generation: [{"kind": "approval"}])
		entry = LiveEntry("collision", SimpleNamespace(controls=controls), SessionHandle(SessionRef("profile-authority", "collision"), "instance", 1, 0, 1, "running"), {"source": "cli", "title": "Owned", "started_at": 1}, [], False)
		async def entries(owner, principal):
			self.assertIs(owner, authority)
			self.assertEqual(principal.subject, actor.subject)
			self.assertEqual(principal.profile_id, actor.profile_id)
			self.assertEqual(principal.capabilities, frozenset({"session:read"}))
			return [entry]
		with patch.dict(sys.modules, {fake.__name__: fake}), patch.object(listing_module, "live_entries", entries):
			result = asyncio.run(backend.native_runtime(object(), "exact-profile"))
		self.assertEqual(result["sessions"][0]["status"], "waiting")
		self.assertEqual(result["sessions"][0]["session_key"], "collision")

	def test_runtime_no_authority_or_compatibility_returns_503(self):
		fake = ModuleType("hermes_cli.web_server_sessions")
		setattr(fake, "_session_mutation_context", lambda request, profile: (None, None))
		with patch.dict(sys.modules, {fake.__name__: fake}):
			self.assertEqual(self.client().get("/runtime").status_code, 503)
		with patch.object(backend, "native_runtime", AsyncMock(side_effect=ImportError("old core"))):
			self.assertEqual(self.client().get("/runtime").status_code, 503)

	def test_sessions_native_rich_pagination_and_organized_compression_backfill(self):
		db_path = self.path / "native.sqlite3"
		with closing(SessionDB(db_path)) as db:
			db.create_session("old-root", "cli", cwd="/old-project", system_prompt="must-not-leak", model_config={"secret": "must-not-leak"})
			db.update_session_cwd("old-root", "/old-project", git_branch="retained")
			db.end_session("old-root", "compression")
			db.create_session("old-tip", "cli", parent_session_id="old-root")
			for i in range(500):
				db.create_session(f"recent-{i:03d}", "cli", cwd="/recent")
		fake = ModuleType("hermes_cli.web_server_sessions")
		opened = []
		def open_db(profile, *, read_only):
			self.assertEqual(profile, "exact-profile")
			self.assertTrue(read_only)
			opened.append(profile)
			return SessionDB(db_path, read_only=read_only)
		setattr(fake, "_open_session_db_for_profile", open_db)
		before = db_path.read_bytes()
		with patch.dict(sys.modules, {fake.__name__: fake}):
			client = self.client()
			first = client.get("/sessions").json()
			self.assertEqual(len(first["sessions"]), 500)
			self.assertTrue(first["has_more"])
			older = client.get("/sessions?offset=500&limit=500").json()
			self.assertEqual(len(older["sessions"]), 1)
			self.assertFalse(older["has_more"])
			root = older["sessions"][0]
			self.assertEqual(root["_lineage_root_id"], "old-root")
			self.assertEqual(root["cwd"], "/old-project")
			self.assertEqual(root["git_branch"], "retained")
			self.assertNotIn("system_prompt", root)
			self.assertNotIn("model_config", root)
			self.assertEqual(client.post("/sessions/old-root", json={"action": "settle"}).status_code, 200)
			backfilled = client.get("/sessions").json()
			self.assertEqual(len(backfilled["sessions"]), 501)
			self.assertIn("old-root", {r.get("_lineage_root_id") for r in backfilled["sessions"]})
			self.assertEqual(client.get("/sessions?profile=foreign").status_code, 422)
			self.assertEqual(client.get("/sessions?limit=501").status_code, 422)
		self.assertEqual(db_path.read_bytes(), before)

	def test_backfill_exact_id_after_500_substring_collisions(self):
		fake = ModuleType("hermes_cli.web_server_sessions")
		calls = []
		class DB:
			def list_sessions_rich(self, **options):
				calls.append(options)
				if not options.get("id_query"):
					return []
				if options["offset"] == 0:
					return [{"id": f"prefix-old-{i}"} for i in range(500)]
				return [{"id": "old", "cwd": "/retained"}]
			def close(self):
				pass
		setattr(fake, "_open_session_db_for_profile", lambda *args, **kwargs: DB())
		with patch.dict(sys.modules, {fake.__name__: fake}):
			value = backend.native_sessions("exact-profile", 0, 500, ("old",))
		self.assertEqual(value["sessions"], [{"id": "old", "cwd": "/retained"}])
		self.assertEqual([c["offset"] for c in calls], [0, 0, 500])

	def test_native_internal_sources_excluded_from_pages_and_organized_backfill(self):
		from hermes_state_sessions import INTERNAL_LISTING_SOURCES

		db_path = self.path / "native-picker.sqlite3"
		with closing(SessionDB(db_path)) as db:
			db.create_session("older-human", "cli")
			for source in INTERNAL_LISTING_SOURCES:
				db.create_session(f"internal-{source}", source)
			db.create_session("recent-human", "cli")
		fake = ModuleType("hermes_cli.web_server_sessions")
		setattr(fake, "_open_session_db_for_profile", lambda profile, *, read_only: SessionDB(db_path, read_only=read_only))
		before = db_path.read_bytes()
		with patch.dict(sys.modules, {fake.__name__: fake}):
			first = backend.native_sessions("exact-profile", 0, 1, ())
			second = backend.native_sessions("exact-profile", 1, 1, ())
			self.assertEqual({row["id"] for row in first["sessions"] + second["sessions"]}, {"older-human", "recent-human"})
			self.assertEqual(backend.native_sessions("exact-profile", 2, 1, ())["sessions"], [])
			backfill = backend.native_sessions("exact-profile", 0, 1, tuple(f"internal-{source}" for source in INTERNAL_LISTING_SOURCES))
			self.assertEqual(backfill["sessions"], first["sessions"])
		self.assertEqual(db_path.read_bytes(), before)

	def test_sessions_missing_native_reader_is_503(self):
		def unavailable(*args):
			raise ImportError("unsupported core")
		self.assertEqual(self.client(sessions_reader=unavailable).get("/sessions").status_code, 503)
