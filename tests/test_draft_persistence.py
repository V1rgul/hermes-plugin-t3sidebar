"""An unsent draft's row is written by the installed native first-prompt writer against isolated synthetic homes.

Auth/profile selection and the live registry are injected; native HTTP admission, the session writer, SQLite rows and
retirement are real. No real gateway, credentials or history are touched: the launch-profile DB handle is patched to fail.
"""
from contextlib import closing, contextmanager
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
from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from hermes_state import SessionDB
import hermes_state_runtime as runtime
import tui_gateway.server as native_server
from hermes_cli.web_server_dashboard import _plugin_route_secret_scope
from test_backend import backend

PREFIX = "/api/plugins/hermes-t3sidebar"


class DraftPersistence(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="t3-draft-persist-")
		self.addCleanup(self.temp.cleanup)
		self.root = Path(self.temp.name)
		self.homes = {name: self.root / name for name in ("exact-profile", "other-profile")}
		for home in self.homes.values():
			home.mkdir()
			with closing(SessionDB(home / "state.db")) as db:
				db.create_session("existing", "desktop")
		self.home = self.homes["exact-profile"]
		self.profile = "exact-profile"
		self.subject = SimpleNamespace(user_id="fixture-user", provider="fixture", issuer="fixture")
		self.hosted = None
		self.registry = {"rt-draft": self.session("draft")}

		self.start_patch("hermes_cli.web_server_profiles._config_profile_scope", self.scope)
		self.start_patch("hermes_cli.web_server_profiles._is_current_profile", return_value=True)
		self.start_patch("hermes_cli.web_server_plugin_profiles.in_process_router_refused", return_value=False)
		self.start_patch("hermes_constants.profile_name_for_home", side_effect=lambda home: Path(home).name)
		self.start_patch("hermes_cli.web_server_cron._cron_profile_home", side_effect=lambda profile: (profile, self.homes[profile]))
		self.start_patch("hermes_cli.web_routers.sessions._cron_profile_home", side_effect=lambda profile: (profile, self.homes[profile]))
		self.start_patch_object(native_server, "_sessions", self.registry)
		self.start_patch_object(native_server, "_sessions_lock", RLock())
		self.start_patch_object(native_server, "_launch_home", lambda: self.home)
		# A session without an explicit home would use the launch profile's shared handle; never reach the real one.
		self.start_patch_object(native_server, "_get_db", side_effect=AssertionError("launch-profile DB must not be used"))
		self.app = FastAPI()

		@self.app.middleware("http")
		async def identity(request, call_next):
			if self.subject is not None:
				request.state.session = self.subject
			if self.hosted is not None:
				request.state.hosted_http_authenticated = self.hosted
			return await call_next(request)

		self.app.include_router(backend.create_router(), prefix=PREFIX, dependencies=[Depends(_plugin_route_secret_scope)])
		self.client = TestClient(self.app)
		self.addCleanup(self.client.close)

	def start_patch(self, *args, **kwargs):
		value = (p := patch(*args, **kwargs)).start()
		self.addCleanup(p.stop)
		return value

	def start_patch_object(self, *args, **kwargs):
		value = (p := patch.object(*args, **kwargs)).start()
		self.addCleanup(p.stop)
		return value

	@contextmanager
	def scope(self, profile):
		token = set_hermes_home_override(self.homes[profile or self.profile])
		try:
			yield
		finally:
			reset_hermes_home_override(token)

	def session(self, key, home=None, **fields):
		return {"session_key": key, "profile_home": str(home or self.home), "source": "desktop", "agent": None,
			"history": [], "running": False, "cwd": "/repo/chosen", "explicit_cwd": True, "created_at": 1, **fields}

	def post(self, sid="draft", body=None, query=None):
		return self.client.post(f"{PREFIX}/sessions/{sid}/draft?{query or 'profile=' + self.profile}",
			json={"runtime_id": "rt-draft"} if body is None else body)

	def row(self, sid, home=None):
		with closing(SessionDB((home or self.home) / "state.db", read_only=True)) as db:
			return db.get_session(sid)

	def test_unsent_draft_gets_its_native_row_and_nothing_else(self):
		self.assertIsNone(self.row("draft"))
		response = self.post()
		self.assertEqual(response.status_code, 200, response.text)
		self.assertEqual(response.headers["cache-control"], "no-store")
		self.assertEqual(response.json(), {"ok": True, "profile": self.profile, "session_id": "draft", "message_count": 0})
		row = self.row("draft")
		assert row is not None
		# The native first-prompt writer's row: chosen workspace and source, no title, so auto-titling still applies.
		self.assertEqual((row["source"], row["cwd"], row["title"], row["message_count"]), ("desktop", "/repo/chosen", None, 0))
		# Idempotent: a repeat does not rewrite the row.
		self.assertEqual(self.post().status_code, 200)
		self.assertEqual(self.row("draft"), row)
		self.assertIsNone(self.row("draft", self.homes["other-profile"]))
		# The stored row is the only record: no plugin metadata store is created.
		self.assertFalse((self.home / "plugin-data").exists())

	def test_persisted_draft_is_listed_as_an_empty_desktop_row(self):
		self.assertEqual(self.post().status_code, 200)
		response = self.client.get(f"{PREFIX}/sessions?offset=0&limit=500&profile={self.profile}")
		self.assertEqual(response.status_code, 200, response.text)
		listed = {row["id"]: row for row in response.json()["sessions"]}
		self.assertEqual((listed["draft"]["source"], listed["draft"]["message_count"]), ("desktop", 0))

	def test_existing_stored_rows_need_no_runtime_and_report_their_count(self):
		response = self.post("existing", body={})
		self.assertEqual(response.status_code, 200, response.text)
		self.assertEqual(response.json()["message_count"], 0)
		with closing(SessionDB(self.home / "state.db")) as db:
			db.create_session("talked", "desktop")
			db.append_message("talked", "user", "hello")
		response = self.post("talked", body={})
		self.assertEqual(response.status_code, 200, response.text)
		self.assertEqual(response.json()["message_count"], 1)

	def test_runtime_must_be_this_homes_exact_live_draft(self):
		cases = {
			"missing": {},
			"other key": {"rt-draft": self.session("another")},
			"finalized": {"rt-draft": self.session("draft", _finalized=True)},
			"foreign home": {"rt-draft": self.session("draft", self.homes["other-profile"])},
			"rotated agent": {"rt-draft": self.session("draft", agent=SimpleNamespace(session_id="tip"))},
		}
		for name, registry in cases.items():
			with self.subTest(name), patch.object(native_server, "_sessions", registry):
				response = self.post()
				self.assertEqual(response.status_code, 404, response.text)
				self.assertEqual(response.json()["detail"], "draft_runtime_not_found")
		self.assertEqual(self.post(body={}).status_code, 404)
		for name, source in (("internal", "tool"), ("cron", "cron"), ("unknown", "")):
			with self.subTest(name), patch.object(native_server, "_sessions", {"rt-draft": self.session("draft", source=source)}):
				response = self.post()
				self.assertEqual(response.status_code, 409, response.text)
		for home in self.homes.values():
			self.assertIsNone(self.row("draft", home))

	def test_a_deleted_session_is_never_recreated(self):
		with closing(SessionDB(self.home / "state.db")) as db:
			epoch = runtime.begin_runtime_epoch(db, instance_id="scratch-owner")
			with patch("hermes_state_common.emit_session_deleted"):
				runtime.mutate_runtime_session(db, epoch=epoch, principal_id="scratch-human", session_id="existing",
					request_id="delete-once", expected_revision=0, expected_generation=0, operation="delete", payload={})
		self.registry["rt-draft"] = self.session("existing")
		for body in ({"runtime_id": "rt-draft"}, {}):
			response = self.post("existing", body=body)
			self.assertEqual(response.status_code, 409, response.text)
			self.assertEqual(response.json()["detail"], "session_retired")
		self.assertIsNone(self.row("existing"))

	def test_missing_or_silent_native_writer_fails(self):
		with patch.object(native_server, "_ensure_session_db_row", None):
			self.assertEqual(self.post().json()["detail"], "draft_persistence_unavailable")
		with patch.dict(sys.modules, {"tui_gateway.server": None}):
			self.assertEqual(self.post().json()["detail"], "draft_persistence_unavailable")
		# The native writer swallows ordinary failures and still reports success; only the stored row counts.
		with patch.object(native_server, "_ensure_session_db_row", return_value=True):
			response = self.post()
			self.assertEqual(response.status_code, 503)
			self.assertEqual(response.json()["detail"], "draft_persistence_verification_failed")
		with patch.object(native_server, "_ensure_session_db_row", return_value=False):
			self.assertEqual(self.post().json()["detail"], "draft_persistence_failed")
		self.assertIsNone(self.row("draft"))

	def test_authority_topology_and_unauthorized_requests_fail_closed(self):
		authority = SimpleNamespace(profile_id=str(self.home), db=SimpleNamespace(db_path=str(self.home / "state.db")))
		actor = Principal("fixture", str(self.home), frozenset({"session:control"}), "http")
		with patch("hermes_cli.web_server_sessions._session_mutation_context", return_value=(authority, actor)):
			self.assertEqual(self.post().json()["detail"], "draft_persistence_unavailable")
		for actor in (Principal("fixture", str(self.homes["other-profile"]), frozenset({"session:control"}), "http"),
			Principal("fixture", str(self.home), frozenset({"session:read"}), "http")):
			with patch("hermes_cli.web_server_sessions._session_mutation_context", return_value=(None, actor)):
				self.assertEqual(self.post().status_code, 403)
		self.hosted = True
		self.assertEqual(self.post().json()["detail"], "draft_persistence_context_unavailable")
		self.hosted = None
		self.subject = None
		self.assertEqual(self.post().status_code, 401)
		self.subject = SimpleNamespace(user_id="fixture-user", provider="fixture", issuer="fixture")
		for body in ({"runtime_id": 3}, {"runtime_id": "../x"}, {"runtime_id": "rt-draft", "text": "secret"}):
			with self.subTest(body=body):
				self.assertEqual(self.post(body=body).status_code, 422)
		self.assertEqual(self.post(query="profile=exact-profile&profile=other-profile").status_code, 422)
		self.assertIsNone(self.row("draft"))
		self.assertFalse((self.home / "plugin-data").exists())


if __name__ == "__main__":
	unittest.main()
