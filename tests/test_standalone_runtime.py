"""Real installed standalone read seam; synthetic registry/auth and scratch DBs only."""
from contextlib import contextmanager, closing
from pathlib import Path
import sys
import tempfile
from threading import RLock
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

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
import gateway.session_ancillary as ancillary
import tools.delegate_tool_registry as subagent_registry

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

	def attach_subagents(self):
		# Real native ownership helper and descendant predicate; only records are synthetic.
		db = SessionDB(self.current / "native.sqlite3", read_only=True)
		self.addCleanup(db.close)
		parent = self.registry["runtime-a"]["agent"]
		parent._session_db = db
		parent.gateway_session_key = "runtime-a"
		self.children = {}
		self.start_patch(patch.object(subagent_registry, "_active_subagents", self.children))
		self.start_patch(patch.object(subagent_registry, "_active_subagents_lock", RLock()))
		return parent, db

	def child(self, name, parent, db, *, durable: str | None="collision", status="running", runtime="runtime-a"):
		agent = SimpleNamespace(_delegate_parent_ref=lambda: parent, _session_db=db)
		self.children[name] = {"subagent_id": name, "agent": agent, "status": status,
			"owner_session_id": runtime, "owner_agent_session_id": durable,
			"goal": "private-child-goal", "owner_transport": object()}
		return agent

	def runtime_row(self):
		response = self.client.get("/runtime?profile=exact-profile")
		self.assertEqual(response.status_code, 200, response.text)
		self.assertNotIn("private-", response.text)
		return response.json()["sessions"][0]

	def test_idle_parent_counts_live_children_and_clears_after_last_child_finishes(self):
		parent, db = self.attach_subagents()
		self.registry["runtime-a"]["running"] = False
		self.start_patch(patch.object(server_requests, "_open", {}))
		self.child("one", parent, db)
		self.child("nested", self.children["one"]["agent"], db)
		self.child("completed", parent, db, status="completed")
		self.child("cancelled", parent, db, status="cancelled")
		before = (self.current / "native.sqlite3").read_bytes()
		with patch.object(ancillary, "subagent_records", wraps=ancillary.subagent_records) as read:
			self.assertEqual((self.runtime_row()["status"], self.runtime_row()["running_subagents"]), ("idle", 2))
			self.assertIs(read.call_args.args[0], parent)
			self.assertEqual(read.call_args.kwargs["session_id"], "collision")
			self.assertEqual(read.call_args.kwargs["route"], "runtime-a")
			self.assertIs(read.call_args.kwargs["session_db"], db)
			self.children.pop("one")
			self.assertEqual(self.runtime_row()["running_subagents"], 1)
			self.children["nested"]["status"] = "completed"
			self.assertEqual(self.runtime_row()["running_subagents"], 0)
			self.children.clear()
			self.assertEqual(self.runtime_row()["running_subagents"], 0)
		self.assertEqual((self.current / "native.sqlite3").read_bytes(), before)

	def test_reminted_runtime_uses_durable_owner_and_rejects_same_id_foreign_database(self):
		parent, db = self.attach_subagents()
		old_parent = SimpleNamespace(session_id="collision", _session_db=db, gateway_session_key="old-runtime")
		self.child("owned", old_parent, db, runtime="old-runtime")
		foreign_db = SimpleNamespace(db_path=self.homes["other-profile"] / "native.sqlite3")
		foreign_parent = SimpleNamespace(session_id="collision", _session_db=foreign_db)
		self.child("foreign", foreign_parent, foreign_db, runtime="runtime-a")
		# Runtime-only ownership must never be confused with the durable owner id.
		self.child("runtime-only", None, db, durable=None)
		self.registry["runtime-reminted"] = self.registry.pop("runtime-a")
		parent.gateway_session_key = "runtime-reminted"
		row = self.runtime_row()
		self.assertEqual(row["id"], "runtime-reminted")
		self.assertEqual(row["running_subagents"], 1)

	def test_fallback_evicted_ancestor_is_qualified_by_native_route_and_database(self):
		parent, db = self.attach_subagents()
		old = SimpleNamespace(session_id="collision", _session_db=db, _evicted_on_fallback="runtime-a")
		self.child("fallback", old, db, durable=None)
		wrong = SimpleNamespace(session_id="collision", _session_db=db, _evicted_on_fallback="other-runtime")
		self.child("wrong-route", wrong, db, durable=None)
		self.assertEqual(self.runtime_row()["running_subagents"], 1)

	def test_unavailable_or_failed_subagent_projection_is_unknown_and_never_reuses_count(self):
		parent, db = self.attach_subagents()
		self.child("one", parent, db)
		self.assertEqual(self.runtime_row()["running_subagents"], 1)
		for helper in (None, Mock(side_effect=RuntimeError("projection unavailable")), Mock(return_value=None)):
			with self.subTest(helper=helper), patch.object(ancillary, "subagent_records", helper):
				self.assertIsNone(self.runtime_row()["running_subagents"])
		parent_db = parent._session_db
		del parent._session_db
		self.assertIsNone(self.runtime_row()["running_subagents"])
		parent._session_db = parent_db
		# Standalone agents need not have a gateway route attribute: the native
		# exact-home mapping supplies their runtime route. A conflicting one fails.
		del parent.gateway_session_key
		self.assertEqual(self.runtime_row()["running_subagents"], 1)
		parent.gateway_session_key = "foreign-runtime"
		self.assertIsNone(self.runtime_row()["running_subagents"])
		parent.gateway_session_key = "runtime-a"
		parent._session_db = SimpleNamespace(db_path=self.homes["other-profile"] / "native.sqlite3")
		self.assertIsNone(self.runtime_row()["running_subagents"])
		self.registry["runtime-a"]["agent"] = None
		self.assertIsNone(self.runtime_row()["running_subagents"])

	def test_blocking_native_projection_releases_global_lock_and_revalidates_identity(self):
		from concurrent.futures import ThreadPoolExecutor
		from threading import Event
		parent, db = self.attach_subagents()
		row = {"id": "runtime-a", "session_key": "collision"}
		session = self.registry["runtime-a"]
		request_snapshot = (session, parent)
		# Each mutation can happen while native fallback/lineage IO is blocked.
		changes = {
			"registry": lambda: self.registry.__setitem__("runtime-a", self.session("collision", self.current)),
			"finalized": lambda: session.__setitem__("_finalized", True),
			"agent": lambda: session.__setitem__("agent", SimpleNamespace(session_id="collision")),
			"home": lambda: session.__setitem__("profile_home", str(self.homes["other-profile"])),
			"durable": lambda: setattr(parent, "session_id", "changed"),
			"route": lambda: setattr(parent, "gateway_session_key", "changed"),
			"db_object": lambda: setattr(parent, "_session_db", SimpleNamespace(db_path=db.db_path)),
		}
		for name, change in changes.items():
			with self.subTest(change=name):
				self.registry["runtime-a"] = session
				session.update(_finalized=False, agent=parent, profile_home=str(self.current))
				parent.session_id, parent.gateway_session_key, parent._session_db = "collision", "runtime-a", db
				entered, release = Event(), Event()
				def blocked(actual_parent, **kwargs):
					self.assertIs(actual_parent, parent)
					self.assertIs(kwargs["session_db"], db)
					entered.set()
					if not release.wait(1):
						raise TimeoutError("test release timeout")
					return [{"status": "running", "goal": "private-never-publish"}]
				with patch.object(ancillary, "subagent_records", blocked), ThreadPoolExecutor(max_workers=1) as pool:
					future = pool.submit(backend.standalone_subagent_count, native_server, row, request_snapshot, db, self.current)
					try:
						self.assertTrue(entered.wait(1))
						acquired = native_server._sessions_lock.acquire(timeout=.1)
						try:
							self.assertTrue(acquired, "native projection must not hold the global sessions lock")
							change()
						finally:
							if acquired:
								native_server._sessions_lock.release()
					finally:
						release.set()
					self.assertIsNone(future.result(timeout=2))

	def test_snapshot_parent_replacement_cannot_lend_stale_subagent_count(self):
		parent, db = self.attach_subagents()
		self.child("one", parent, db)
		read = legacy._own_profile_read
		def replaced(*args):
			result = read(*args)
			self.registry["runtime-a"] = self.session("collision", self.current)
			return result
		with patch.object(legacy, "_own_profile_read", replaced):
			self.assertIsNone(self.runtime_row()["running_subagents"])

	def test_internal_sources_are_filtered_before_subagent_projection(self):
		self.attach_subagents()
		with closing(SessionDB(self.current / "native.sqlite3")) as db:
			db.create_session("cron-job", "cron")
		self.registry["runtime-cron"] = self.session("cron-job", self.current)
		with patch.object(ancillary, "subagent_records", wraps=ancillary.subagent_records) as read:
			self.runtime_row()
			self.assertEqual(read.call_count, 1)

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
