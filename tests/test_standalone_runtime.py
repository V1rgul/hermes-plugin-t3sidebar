"""Real installed standalone read seam; synthetic registry/auth and scratch DBs only."""
from contextlib import contextmanager, closing
from pathlib import Path
import sys
import tempfile
from threading import RLock
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from gateway.session_contract import Principal
from hermes_constants import get_hermes_home, set_hermes_home_override, reset_hermes_home_override
from hermes_state import SessionDB
from hermes_state_sessions import INTERNAL_LISTING_SOURCES
import hermes_cli.web_server_sessions as native_sessions
import tui_gateway.server as native_server
import tui_gateway.server_requests as server_requests
import tui_gateway.ws_legacy_fallback as legacy

from test_backend import backend

NATIVE_PROFILE_HOME = native_server._profile_home


class StandaloneRuntime(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="flow-standalone-")
		self.addCleanup(self.temp.cleanup)
		self.root = Path(self.temp.name)
		self.homes = {name: self.root / name for name in ("exact-profile", "other-profile")}
		for home in self.homes.values():
			home.mkdir()
			with closing(SessionDB(home / "native.sqlite3")) as db:
				db.create_session("collision", "cli", system_prompt="private-system-prompt", model_config={"secret": "private-model-config"})
				for source in INTERNAL_LISTING_SOURCES:
					db.create_session(f"internal-{source}", source)
		self.current = self.homes["exact-profile"]
		self.grant_home = self.current
		self.lookups = []
		self.registry = {
			"runtime-a": self.session("collision", None),
			"runtime-b": self.session("collision", self.homes["other-profile"]),
			"finalized": {**self.session("collision", self.current), "_finalized": True},
			**{f"runtime-{source}": self.session(f"internal-{source}", self.current) for source in INTERNAL_LISTING_SOURCES},
		}
		waiting = server_requests.ServerRequest("runtime-a", "approval.request", {"secret": "private-approval"})
		self.start_patch(patch.object(native_server, "_sessions", self.registry))
		self.start_patch(patch.object(native_server, "_sessions_lock", RLock()))
		self.start_patch(patch.object(native_server, "_launch_home", lambda: self.homes["exact-profile"]))
		self.start_patch(patch.object(native_server, "_profile_home", lambda name: self.homes.get(name)))
		self.start_patch(patch.object(server_requests, "_open", {waiting.id: waiting}))
		self.start_patch(patch("hermes_constants.profile_name_for_home", side_effect=lambda home: next((n for n, h in self.homes.items() if h.resolve() == Path(home).resolve()), None)))
		self.start_patch(patch("hermes_cli.web_server_cron._cron_profile_home", side_effect=lambda profile: (profile, self.homes[profile])))
		self.start_patch(patch.object(native_sessions, "_open_session_db_for_profile", self.open_db))
		# Native title projection normally borrows the server's owner DB. Supply only
		# scratch read-only handles; the mapper/status and scoped helper stay real.
		self.start_patch(patch.object(native_server, "_session_db", self.session_db))
		self.token = set_hermes_home_override(str(self.current))
		self.addCleanup(reset_hermes_home_override, self.token)
		app = FastAPI()
		@app.middleware("http")
		async def authenticated(request, call_next):
			request.state.native_http_principal = {"subject": "synthetic-authenticated-owner", "profile_id": str(self.grant_home)}
			return await call_next(request)
		app.include_router(backend.create_router(self.root / "flow.sqlite3"))
		self.client = TestClient(app)
		self.addCleanup(self.client.close)

	def start_patch(self, patcher):
		result = patcher.start()
		self.addCleanup(patcher.stop)
		return result

	def session(self, key, home):
		return {"session_key": key, "profile_home": str(home) if home else None, "running": True,
			"agent": SimpleNamespace(session_id=key, model="synthetic-model"),
			"history": [{"role": "user", "content": "private-live-prompt"}], "created_at": 1}

	def open_db(self, profile, *, read_only):
		self.assertTrue(read_only)
		self.lookups.append(profile)
		return SessionDB(self.homes[profile] / "native.sqlite3", read_only=True)

	@contextmanager
	def session_db(self, session):
		home = Path(session.get("profile_home") or self.homes["exact-profile"])
		with closing(SessionDB(home / "native.sqlite3", read_only=True)) as db:
			yield db

	def test_native_scoped_helper_and_real_waiting_mapper_keep_colliding_owners_separate(self):
		before = {home: (home / "native.sqlite3").read_bytes() for home in self.homes.values()}
		with patch.object(legacy, "_own_profile_read", wraps=legacy._own_profile_read) as scoped:
			response = self.client.get("/runtime?profile=exact-profile")
			self.assertEqual(response.status_code, 200, response.text)
			self.assertIs(scoped.call_args.args[0]._sessions, sys.modules["tui_gateway.server"]._sessions)
			self.assertIs(scoped.call_args.args[0]._launch_home, native_server._launch_home)
			self.assertEqual(Path(scoped.call_args.args[2]), self.current)
			self.assertEqual([(r["id"], r["session_key"], r["status"]) for r in response.json()["sessions"]], [("runtime-a", "collision", "waiting")])
			self.assertNotIn("private-", response.text)
			self.assertEqual(response.headers["cache-control"], "no-store")
			# Same stored id, different runtime/status and owner; default-home rows
			# must not follow the request into a secondary profile.
			token = set_hermes_home_override(str(self.homes["other-profile"]))
			self.grant_home = self.homes["other-profile"]
			try:
				response = self.client.get("/runtime?profile=other-profile")
			finally:
				reset_hermes_home_override(token)
			self.assertEqual(response.status_code, 200, response.text)
			self.assertEqual([(r["id"], r["session_key"], r["status"]) for r in response.json()["sessions"]], [("runtime-b", "collision", "working")])
		self.assertEqual(self.lookups, ["exact-profile", "other-profile"])
		for home in self.homes.values():
			self.assertEqual((home / "native.sqlite3").read_bytes(), before[home])

	def test_real_launch_profile_none_sentinel_keeps_current_runtime_readable(self):
		with patch.object(native_server, "_profile_home", NATIVE_PROFILE_HOME), patch.object(native_server, "_hermes_home", self.current), patch.object(native_server, "_canonical_profile_request", side_effect=lambda name: name), patch("hermes_cli.profiles.get_profile_dir", side_effect=lambda name: self.homes[name]):
			self.assertIsNone(native_server._profile_home("exact-profile"))
			response = self.client.get("/runtime?profile=exact-profile")
		self.assertEqual(response.status_code, 200, response.text)
		self.assertEqual(response.json()["sessions"][0]["status"], "waiting")

	def test_unsent_drafts_use_scoped_native_source_without_disabling_other_rows(self):
		self.registry["draft"] = {**self.session("unpersisted-draft", None), "agent": None, "history": [], "running": False, "source": "cli"}
		self.registry["internal-draft"] = {**self.registry["draft"], "session_key": "internal-draft", "source": "tool"}
		self.registry["foreign-draft"] = {**self.registry["draft"], "profile_home": str(self.homes["other-profile"])}
		response = self.client.get("/runtime?profile=exact-profile")
		self.assertEqual(response.status_code, 200, response.text)
		self.assertEqual({(row["id"], row["status"]) for row in response.json()["sessions"]}, {("runtime-a", "waiting"), ("draft", "idle")})
		with closing(SessionDB(self.current / "native.sqlite3", read_only=True)) as db:
			self.assertIsNone(db.get_session("unpersisted-draft"))

	def test_missing_loaded_server_does_not_import_or_infer_idle(self):
		with patch.dict(sys.modules, {"tui_gateway.server": None}), patch.object(legacy, "_own_profile_read") as read:
			response = self.client.get("/runtime")
		self.assertEqual(response.status_code, 503, response.text)
		read.assert_not_called()

	def test_foreign_actor_is_refused_before_native_snapshot(self):
		actor = Principal("synthetic-owner", str(self.homes["other-profile"]), frozenset({"session:read"}), "http")
		with patch.object(native_sessions, "_session_mutation_context", return_value=(None, actor)), patch.object(legacy, "_own_profile_read") as read:
			response = self.client.get("/runtime")
		self.assertEqual(response.status_code, 403, response.text)
		read.assert_not_called()

	def test_standalone_native_grant_cannot_name_foreign_profile(self):
		# Installed resolver currently validates native profile_id only with an
		# authority, so the standalone adapter must also compare the native grant.
		self.grant_home = self.homes["other-profile"]
		with patch.object(legacy, "_own_profile_read") as read:
			response = self.client.get("/runtime")
		self.assertEqual(response.status_code, 403, response.text)
		read.assert_not_called()

	def test_native_read_capability_is_required_before_snapshot(self):
		actor = Principal("synthetic-owner", str(self.current), frozenset(), "http")
		with patch.object(native_sessions, "_session_mutation_context", return_value=(None, actor)), patch.object(legacy, "_own_profile_read") as read:
			response = self.client.get("/runtime")
		self.assertEqual(response.status_code, 403, response.text)
		read.assert_not_called()

	def test_legacy_helper_missing_on_older_core_is_unavailable(self):
		with patch.object(legacy, "_own_profile_read", None):
			response = self.client.get("/runtime")
		self.assertEqual(response.status_code, 503, response.text)

	def test_native_empty_scoped_registry_is_a_known_empty_snapshot(self):
		self.registry.clear()
		response = self.client.get("/runtime")
		self.assertEqual(response.status_code, 200, response.text)
		self.assertEqual(response.json(), {"sessions": [], "profile": "exact-profile"})
		self.assertEqual(self.lookups, [])

	def test_missing_source_record_cannot_hide_unknown_runtime_as_idle(self):
		self.registry["unknown"] = self.session("unpersisted", self.current)
		response = self.client.get("/runtime")
		self.assertEqual(response.status_code, 503, response.text)

	def test_native_scope_refusal_stays_unavailable(self):
		with patch.object(native_server, "_profile_home", return_value=self.homes["other-profile"]):
			response = self.client.get("/runtime")
		self.assertEqual(response.status_code, 503, response.text)

	def test_hosted_admission_is_not_a_native_actor(self):
		app = FastAPI()
		@app.middleware("http")
		async def hosted(request, call_next):
			request.state.hosted_http_authenticated = True
			return await call_next(request)
		app.include_router(backend.create_router(self.root / "hosted-flow.sqlite3"))
		with TestClient(app) as client, patch.object(legacy, "_own_profile_read") as read:
			response = client.get("/runtime")
		self.assertEqual(response.status_code, 503, response.text)
		read.assert_not_called()

	def test_unauthenticated_request_stays_unauthorized(self):
		app = FastAPI()
		app.include_router(backend.create_router(self.root / "anonymous-flow.sqlite3"))
		with TestClient(app) as client, patch("hermes_cli.web_server._has_valid_session_token", return_value=False), patch.object(legacy, "_own_profile_read") as read:
			response = client.get("/runtime")
		self.assertEqual(response.status_code, 401, response.text)
		read.assert_not_called()

	def test_production_mount_dependency_establishes_home_before_plugin_handler(self):
		from hermes_cli.web_server_dashboard import _plugin_route_secret_scope
		@contextmanager
		def synthetic_scope(profile):
			home = self.homes[profile or "exact-profile"]
			token = set_hermes_home_override(str(home))
			try:
				yield home
			finally:
				reset_hermes_home_override(token)
		async def runtime(request, profile):
			self.assertEqual(get_hermes_home(), self.homes[profile])
			self.assertEqual(backend.default_state_path(), self.homes[profile] / "plugin-data/hermes-t3sidebar/state.sqlite3")
			return {"sessions": []}
		def sessions(profile, offset, limit, ids):
			self.assertEqual(get_hermes_home(), self.homes[profile])
			return {"sessions": [], "has_more": False}
		app = FastAPI()
		app.include_router(backend.create_router(runtime_reader=runtime, sessions_reader=sessions), prefix="/api/plugins/hermes-t3sidebar", dependencies=[Depends(_plugin_route_secret_scope)])
		with patch("hermes_cli.web_server_profiles._config_profile_scope", synthetic_scope), patch("hermes_cli.web_server_profiles._is_current_profile", return_value=True), patch("hermes_cli.web_server_plugin_profiles.in_process_router_refused", return_value=False), TestClient(app) as client:
			for endpoint in ("runtime", "sessions"):
				response = client.get(f"/api/plugins/hermes-t3sidebar/{endpoint}?profile=other-profile")
				self.assertEqual(response.status_code, 200, response.text)
				self.assertEqual(response.json()["profile"], "other-profile")
				response = client.get(f"/api/plugins/hermes-t3sidebar/{endpoint}?profile=exact-profile&profile=other-profile")
				self.assertEqual(response.status_code, 422, response.text)
		self.assertEqual(get_hermes_home(), self.current)
