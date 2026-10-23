"""Native archives: real scratch SessionDB fixtures, never live history writes."""
from contextlib import closing
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from hermes_state import SessionDB
from hermes_state_sessions import INTERNAL_LISTING_SOURCES
from hermes_cli import projects_db

from test_backend import backend


class NativeArchives(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="native-archives-")
		self.addCleanup(self.temp.cleanup)
		self.home = Path(self.temp.name)
		self.db_path = self.home / "native.sqlite3"
		self.profile = "exact-profile"

	def client(self, **kwargs):
		app = FastAPI()
		app.include_router(backend.create_router(self.home / "metadata.sqlite3", profile_reader=lambda: self.profile, **kwargs))
		client = TestClient(app)
		self.addCleanup(client.close)
		return client

	def open_db(self, profile, *, read_only):
		self.assertEqual(profile, self.profile)
		self.assertIs(read_only, True)
		return SessionDB(self.db_path, read_only=read_only)

	def test_compressed_archive_rich_metadata_and_restore_readback_are_readonly(self):
		with closing(projects_db.connect(self.home / "projects.db")) as conn:
			project = projects_db.create_project(conn, name="Real project", folders=["/repo"], icon="tree", color="#123456")
		with closing(SessionDB(self.db_path)) as db:
			db.create_session("root", "cli", cwd="/repo/src", system_prompt="private-prompt", model_config={"provider": "old"})
			db.update_session_cwd("root", "/repo/src", git_branch="retained")
			db.update_token_counts("root", input_tokens=100, output_tokens=20, absolute=True)
			db.end_session("root", "compression")
			db.create_session("tip", "cli", parent_session_id="root", model_config={"provider": "actual-provider", "secret": "private-config"})
			db.update_token_counts("tip", input_tokens=200, output_tokens=30, model="tip-model", absolute=True)
			self.assertTrue(db.set_session_archived("root", True, notify=False))
			db.create_session("active", "cli")
		before = {path: path.read_bytes() for path in (self.db_path, self.home / "projects.db")}
		with patch("hermes_cli.web_server_sessions._open_session_db_for_profile", side_effect=self.open_db), patch.object(SessionDB, "get_session", side_effect=AssertionError("no full prompt reads")):
			client = self.client()
			# Old plugin settlement is not a native archive migration.
			self.assertEqual(client.post("/sessions/active", json={"action": "settle"}).status_code, 200)
			self.assertEqual(client.post("/sessions/root", json={"action": "pin"}).status_code, 200)
			regular = client.get("/sessions").json()["sessions"]
			self.assertEqual([row["id"] for row in regular], ["active"])
			self.assertIs(regular[0]["archived"], False)
			response = client.get("/archives")
			self.assertEqual(response.status_code, 200, response.text)
			self.assertEqual(response.headers["cache-control"], "no-store")
			payload = response.json()
			self.assertEqual(set(payload), {"profile", "sessions", "offset", "limit", "has_more"})
			self.assertEqual((payload["offset"], payload["limit"], payload["has_more"]), (0, 500, False))
			self.assertEqual(len(payload["sessions"]), 1)
			row = payload["sessions"][0]
			self.assertEqual((row["id"], row["_lineage_root_id"]), ("tip", "root"))
			self.assertEqual(set(row["_lineage_ids"]), {"root", "tip"})
			self.assertIs(row["archived"], True)
			self.assertEqual((row["provider"], row["model"], row["input_tokens"], row["output_tokens"], row["total_tokens"]), ("actual-provider", "tip-model", 300, 50, 350))
			self.assertEqual(row["project"]["id"], project)
			self.assertEqual(row["project"]["name"], "Real project")
			self.assertEqual((row["cwd"], row["git_branch"]), ("/repo/src", "retained"))
			self.assertNotIn("private-", json.dumps(row))
			for sid in ("root", "tip"):
				self.assertEqual(client.get(f"/sessions/{sid}/archive").json(), {"profile": self.profile, "id": sid, "archived": True})
		for path, content in before.items():
			self.assertEqual(path.read_bytes(), content)
		# Only fixture setup mutates native state, simulating the frontend's native RPC.
		with closing(SessionDB(self.db_path)) as db:
			self.assertTrue(db.set_session_archived("root", False, notify=False))
		before_restore_reads = self.db_path.read_bytes()
		with patch("hermes_cli.web_server_sessions._open_session_db_for_profile", side_effect=self.open_db):
			self.assertEqual(client.get("/archives").json()["sessions"], [])
			for sid in ("root", "tip"):
				self.assertIs(client.get(f"/sessions/{sid}/archive").json()["archived"], False)
		self.assertEqual(self.db_path.read_bytes(), before_restore_reads)

	def test_archived_elsewhere_hidden_recovery_cron_internal_filtered_before_paging(self):
		with closing(SessionDB(self.db_path)) as db:
			for sid, source in [("older", "cli"), ("hidden", "cli"), ("newer", "cli"), ("job", "cron"), *((f"internal-{source}", source) for source in INTERNAL_LISTING_SOURCES)]:
				db.create_session(sid, source)
				db.set_session_archived(sid, True, notify=False)
			db.set_session_hidden("hidden", True)
		before = self.db_path.read_bytes()
		with patch("hermes_cli.web_server_sessions._open_session_db_for_profile", side_effect=self.open_db):
			client = self.client()
			rows = []
			for offset in range(4):
				response = client.get(f"/archives?offset={offset}&limit=1")
				self.assertEqual(response.status_code, 200, response.text)
				page = response.json()
				self.assertEqual(page["has_more"], offset < 3)
				rows.extend(page["sessions"])
			self.assertEqual({row["id"] for row in rows}, {"older", "hidden", "newer"})
			self.assertEqual(len(rows), 3)
			self.assertTrue(all(row["archived"] is True for row in rows))
			self.assertEqual(client.get("/sessions").json()["sessions"], [])
		self.assertEqual(self.db_path.read_bytes(), before)
		# Archives don't need or create plugin organization metadata.
		# /sessions above creates its usual store, so exercise a distinct fresh path.
		with patch.object(backend, "native_archives", return_value={"sessions": [], "offset": 0, "limit": 500, "has_more": False}), patch.object(backend.HermesT3SidebarStore, "state", side_effect=AssertionError("no archive backfill")):
			self.assertEqual(self.client().get("/archives").status_code, 200)

	def test_exact_id_missing_alias_and_storage_failure(self):
		with closing(SessionDB(self.db_path)) as db:
			db.create_session("prefix-target-suffix", "cli")
			db.set_session_archived("prefix-target-suffix", True, notify=False)
		with patch("hermes_cli.web_server_sessions._open_session_db_for_profile", side_effect=self.open_db):
			client = self.client()
			self.assertEqual(client.get("/sessions/target/archive").status_code, 404)
			self.assertEqual(client.get("/sessions/absent/archive").json()["detail"], "session_not_found")
			self.assertEqual(client.get("/sessions/bad%20id/archive").status_code, 422)
		with patch("hermes_cli.web_server_sessions._open_session_db_for_profile", side_effect=RuntimeError("unavailable")):
			for endpoint in ("/archives", "/sessions/target/archive"):
				self.assertEqual(client.get(endpoint).status_code, 503)

	def test_exact_reader_uses_compact_batch_and_closes_on_missing(self):
		for rows in ({"exact": {"archived": 1, "system_prompt": "must-not-return"}}, {}):
			db = Mock()
			db._get_session_rich_rows_batch.return_value = rows
			with patch("hermes_cli.web_server_sessions._open_session_db_for_profile", return_value=db):
				if rows:
					self.assertEqual(backend.native_archive("profile", "exact"), {"id": "exact", "archived": True})
				else:
					with self.assertRaises(HTTPException) as error:
						backend.native_archive("profile", "exact")
					self.assertEqual(error.exception.status_code, 404)
			db._get_session_rich_rows_batch.assert_called_once_with(["exact"], compact_rows=True)
			db.close.assert_called_once()

	def test_query_policy_injections_and_per_request_profile_isolation(self):
		archives = Mock(return_value={"sessions": [], "offset": 2, "limit": 3, "has_more": False})
		archive = Mock(return_value={"id": "exact", "archived": False})
		client = self.client(archives_reader=archives, archive_reader=archive)
		for endpoint in ("/archives?offset=2&limit=3", "/sessions/exact/archive"):
			separator = "&" if "?" in endpoint else "?"
			for query in ("", "profile=exact-profile", "profile=exact-profile&profile=exact-profile"):
				response = client.get(endpoint + separator + query)
				self.assertEqual(response.status_code, 200, response.text)
				self.assertEqual(response.headers["cache-control"], "no-store")
				self.assertEqual(response.json()["profile"], "exact-profile")
			calls = (archives.call_count, archive.call_count)
			for query in ("profile=foreign", "profile=", "profile=current", "profile=exact-profile&profile=foreign", "profile=foreign&profile=exact-profile", "profile=exact-profile&profile=", "unknown=1"):
				self.assertEqual(client.get(endpoint + separator + query).status_code, 422, query)
			self.assertEqual((archives.call_count, archive.call_count), calls)
		archives.assert_called_with("exact-profile", 2, 3)
		archive.assert_called_with("exact-profile", "exact")
		for query in ("offset=-1", "limit=0", "limit=501", "limit=no"):
			self.assertEqual(client.get("/archives?" + query).status_code, 422)
		self.assertEqual(client.get("/sessions/exact/archive?offset=0").status_code, 422)
		self.profile = "other-profile"
		self.assertEqual(client.get("/archives").json()["profile"], "other-profile")
		archives.assert_called_with("other-profile", 0, 500)
		self.assertEqual(client.get("/sessions/exact/archive").json()["profile"], "other-profile")
		archive.assert_called_with("other-profile", "exact")
		self.assertFalse((self.home / "metadata.sqlite3").exists())

	def test_native_profile_home_and_colliding_ids_are_isolated(self):
		from hermes_constants import set_hermes_home_override, reset_hermes_home_override
		from hermes_cli import profiles

		homes = {name: self.home / "profiles" / name for name in ("alpha", "beta")}
		for name, home in homes.items():
			home.mkdir(parents=True)
			with closing(SessionDB(home / "state.db")) as db:
				db.create_session("collision", "cli", cwd=f"/{name}")
				db.set_session_archived("collision", name == "alpha", notify=False)
		before = {name: (home / "state.db").read_bytes() for name, home in homes.items()}
		app = FastAPI()
		active = ["alpha"]

		@app.middleware("http")
		async def scope(request, call_next):
			token = set_hermes_home_override(homes[active[0]])
			try:
				return await call_next(request)
			finally:
				reset_hermes_home_override(token)

		app.include_router(backend.create_router(self.home / "unused.sqlite3"))
		with TestClient(app) as client, patch.object(profiles, "profile_exists", side_effect=lambda name: name in homes), patch.object(profiles, "get_profile_dir", side_effect=lambda name: homes[name]):
			for name, expected in (("alpha", True), ("beta", False)):
				active[0] = name
				response = client.get("/sessions/collision/archive")
				self.assertEqual(response.status_code, 200, response.text)
				self.assertEqual(response.json(), {"profile": name, "id": "collision", "archived": expected})
				rows = client.get("/archives").json()["sessions"]
				self.assertEqual([row["cwd"] for row in rows], ["/alpha"] if expected else [])
				foreign = "beta" if name == "alpha" else "alpha"
				self.assertEqual(client.get(f"/archives?profile={foreign}").status_code, 422)
				self.assertEqual(client.get(f"/sessions/collision/archive?profile={foreign}").status_code, 422)
		for name, home in homes.items():
			self.assertEqual((home / "state.db").read_bytes(), before[name])

	def test_native_query_owns_visibility_before_limit_and_no_backfill(self):
		db = Mock()
		db.list_sessions_rich.return_value = []
		with patch("hermes_cli.web_server_sessions._open_session_db_for_profile", return_value=db):
			self.assertEqual(backend.native_sessions("profile", 7, 3, ("ignored",), archived_only=True), {"sessions": [], "offset": 7, "limit": 3, "has_more": False})
		db.list_sessions_rich.assert_called_once_with(limit=3, offset=7, compact_rows=True, order_by_last_active=True, include_archived=False, archived_only=True, include_hidden=False, exclude_sources=[*INTERNAL_LISTING_SOURCES, "cron"])
		db.close.assert_called_once()
