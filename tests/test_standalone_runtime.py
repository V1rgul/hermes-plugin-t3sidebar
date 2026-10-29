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
from tools.process_registry import ProcessSession, process_registry

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

	def test_runtime_rows_carry_only_the_native_in_flight_turn_start(self):
		self.assertIsNone(self.runtime_row()["turn_started_at"])
		self.registry["runtime-a"]["inflight_turn"] = {"started_at": 1234.5, "user": "private-live-prompt", "assistant": "", "streaming": True}
		row = self.runtime_row()
		self.assertEqual(row["turn_started_at"], 1234.5)
		self.assertNotIn("private-live-prompt", repr(row))
		# A failed turn is retained for resuming clients until the next one starts; it is not running.
		self.registry["runtime-a"]["inflight_turn"] = {"started_at": 1234.5, "status": "error"}
		self.assertIsNone(self.runtime_row()["turn_started_at"])
		for invalid in (0, -1, float("nan"), float("inf"), True, "1234.5"):
			self.registry["runtime-a"]["inflight_turn"] = {"started_at": invalid}
			self.assertIsNone(self.runtime_row()["turn_started_at"], invalid)

	def test_manual_compaction_is_timed_from_first_observation_and_never_replaces_a_native_turn(self):
		# Manual /compress sets running without a turn or hook; the native turn always wins when present.
		session = self.registry["runtime-a"]
		self.start_patch(patch.dict(backend._compression_seen, clear=True))
		session["_manual_compress_active"] = True
		with patch.object(backend.time, "time", return_value=5000.0):
			self.assertEqual(self.runtime_row()["turn_started_at"], 5000.0)
		with patch.object(backend.time, "time", return_value=5030.0):
			self.assertEqual(self.runtime_row()["turn_started_at"], 5000.0)
			session["inflight_turn"] = {"started_at": 4000.0, "user": "private-live-prompt"}
			self.assertEqual(self.runtime_row()["turn_started_at"], 4000.0)
			session["inflight_turn"] = None
			self.assertEqual(self.runtime_row()["turn_started_at"], 5000.0)
			session.pop("_manual_compress_active")
			self.assertIsNone(self.runtime_row()["turn_started_at"])
		# A later compaction gets its own start, as does a replaced session object under the same runtime id.
		session["_manual_compress_active"] = True
		with patch.object(backend.time, "time", return_value=6000.0):
			self.assertEqual(self.runtime_row()["turn_started_at"], 6000.0)
		self.registry["runtime-a"] = {**session}
		with patch.object(backend.time, "time", return_value=6100.0):
			self.assertEqual(self.runtime_row()["turn_started_at"], 6100.0)
		# Runtime ids that leave the snapshot are forgotten.
		del self.registry["runtime-a"]
		self.client.get("/runtime?profile=exact-profile")
		self.assertNotIn((str(self.current), "runtime-a"), backend._compression_seen)

	def test_compacting_reports_manual_compress_and_a_running_automatic_compaction_heartbeat(self):
		from agent.conversation_compression import _CompressionActivityHeartbeat
		from agent.session_activity import ActivityProvenance

		session, agent = self.registry["runtime-a"], self.registry["runtime-a"]["agent"]
		self.assertIs(self.runtime_row()["compacting"], False)
		session["_manual_compress_active"] = True
		self.assertIs(self.runtime_row()["compacting"], True)
		session.pop("_manual_compress_active")
		# Drive the native heartbeat against a recording agent: started and in-progress stamps count, its stop stamp does not.
		agent._touch_activity = lambda desc, provenance=None, force_persist=False: (
			setattr(agent, "_last_activity_desc", desc), setattr(agent, "_last_activity_provenance", provenance or ActivityProvenance.UNKNOWN))
		heartbeat = _CompressionActivityHeartbeat(agent, interval_seconds=3600).start()
		try:
			self.assertIs(self.runtime_row()["compacting"], True)
			heartbeat._touch("context compression in progress")
			self.assertIs(self.runtime_row()["compacting"], True)
		finally:
			heartbeat.stop()
		self.assertEqual(agent._last_activity_provenance, ActivityProvenance.AGENT_COMPRESSION)
		self.assertIs(self.runtime_row()["compacting"], False)
		agent._touch_activity("context compression in progress", provenance=ActivityProvenance.AGENT_COMPRESSION_TIMEOUT)
		self.assertIs(self.runtime_row()["compacting"], False, "a terminal timeout stamp is not a running compaction")
		agent._touch_activity("calling the model")
		self.assertIs(self.runtime_row()["compacting"], False)
		self.assertNotIn("compression", self.client.get("/runtime?profile=exact-profile").text)

	def test_awaited_background_processes_use_the_native_notification_predicate(self):
		# Real registry predicate with a synthetic tracked process; only notifying processes keep a session busy.
		running = {}
		self.start_patch(patch.object(process_registry, "_running", running))
		self.registry["runtime-a"]["running"] = False
		self.assertIs(self.runtime_row()["awaiting_processes"], False)
		running["proc_server"] = ProcessSession(id="proc_server", command="serve", owner_task_id="collision", started_at=1)
		self.assertIs(self.runtime_row()["awaiting_processes"], False)
		running["proc_build"] = ProcessSession(id="proc_build", command="build", owner_task_id="collision", started_at=1, notify_on_complete=True)
		# The fixture's pending approval keeps status waiting; the flag is independent of it.
		self.assertIs(self.runtime_row()["awaiting_processes"], True)
		self.assertNotIn("build", self.client.get("/runtime?profile=exact-profile").text)
		running["proc_build"].exited = True
		running["proc_build"]._completion_event.set()
		self.assertIs(self.runtime_row()["awaiting_processes"], False)
		# Another owner's work does not count; a predicate failure is unknown, never idle.
		running["proc_other"] = ProcessSession(id="proc_other", command="build", owner_task_id="someone-else", started_at=1, notify_on_complete=True)
		self.assertIs(self.runtime_row()["awaiting_processes"], False)
		with patch("tui_gateway.session_notifications._session_owns_pending_process_notification", side_effect=RuntimeError):
			self.assertIsNone(self.runtime_row()["awaiting_processes"])

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

	def test_watched_subagent_runs_are_not_sidebar_rows(self):
		# Desktop's lazy watch session on a delegated child registers it as a runtime; native listings hide it by its delegate marker.
		with closing(SessionDB(self.current / "native.sqlite3")) as db:
			db.create_session("delegate-child", "desktop", model_config={"_delegate_from": "collision"})
			db.create_session("worker-child", "subagent", model_config={"_delegate_from": "collision"})
		self.registry["runtime-delegate"] = {**self.session("delegate-child", self.current), "running": False}
		self.registry["runtime-worker"] = {**self.session("worker-child", self.current), "running": False}
		response = self.client.get("/runtime?profile=exact-profile")
		self.assertEqual(response.status_code, 200, response.text)
		self.assertEqual([row["id"] for row in response.json()["sessions"]], ["runtime-a"])

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

	def test_retired_runtime_ghosts_stay_excluded_but_absent_drafts_survive_polling(self):
		import hermes_state_mutation_retirement as retirement
		import hermes_state_runtime as runtime

		with closing(SessionDB(self.current / "native.sqlite3")) as db:
			db.create_session("deleted", "desktop")
			epoch = runtime.begin_runtime_epoch(db, instance_id="scratch-owner")
			with patch("hermes_state_common.emit_session_deleted"):
				receipt = runtime.mutate_runtime_session(db, epoch=epoch, principal_id="scratch-human",
					session_id="deleted", request_id="delete-once", expected_revision=0,
					expected_generation=0, operation="delete", payload={})
			self.assertEqual(receipt["deleted_ids"], ["deleted"])
			self.assertTrue(retirement.retired_session(db, "deleted"))
			self.assertIsNone(db.get_session("deleted"))
		self.registry["ghost"] = {**self.session("deleted", None), "source": "desktop", "history": [], "agent": None}
		self.registry["draft"] = {**self.registry["ghost"], "session_key": "never-persisted"}
		# A runtime ID can itself be the retired identity, independent of its key.
		self.registry["deleted"] = {**self.registry["draft"], "session_key": "another-draft"}
		before = (self.current / "native.sqlite3").read_bytes()
		with patch.object(retirement, "retired_session", wraps=retirement.retired_session) as retired:
			for _ in range(2):
				response = self.client.get("/runtime")
				self.assertEqual(response.status_code, 200, response.text)
				self.assertEqual({row["id"] for row in response.json()["sessions"]}, {"runtime-a", "draft"})
			self.assertTrue(retired.called)
		self.assertEqual((self.current / "native.sqlite3").read_bytes(), before)
		# A same-ID tombstone in the OTHER home cannot retire this home's draft.
		with closing(SessionDB(self.homes["other-profile"] / "native.sqlite3")) as db:
			assert db._conn is not None
			with db._conn:
				retirement.retire_routes(db._conn, ["never-persisted"])
		self.assertEqual({row["id"] for row in self.client.get("/runtime").json()["sessions"]}, {"runtime-a", "draft"})

	def test_zero_message_runtime_project_and_override_are_scoped_allowlisted_and_read_only(self):
		from hermes_cli import projects_db

		with closing(projects_db.connect(self.current / "projects.db")) as conn:
			outer = projects_db.create_project(conn, name="Outer", folders=["/repo"], icon="tools", color="#123456")
			inner = projects_db.create_project(conn, name="Chosen project", folders=["/repo/nested", "/second"], icon="beaker", color="#abcdef")
		with closing(projects_db.connect(self.homes["other-profile"] / "projects.db")) as conn:
			projects_db.create_project(conn, name="Wrong profile project", folders=["/repo/nested"], icon="bug")
		self.registry.clear()
		self.registry["draft"] = {**self.session("unsaved", None), "source": "desktop", "history": [], "agent": None,
			"running": False, "cwd": "/repo/nested/src", "explicit_cwd": True,
			"model_override": {"model": "picked-model", "provider": " OpenAI-Codex ", "api_key": "private-key"},
			"system_prompt": "private-system", "queued_prompt": "private-composer"}
		before = {path: path.read_bytes() for path in [self.current / "native.sqlite3", self.current / "projects.db"]}
		with patch.object(projects_db, "connect", side_effect=AssertionError("no schema writes")), patch.object(native_server, "_session_default_route", side_effect=AssertionError("override must win")), patch.object(backend, "card_projects", wraps=backend.card_projects) as catalog, patch.object(native_server, "_live_session_identity", wraps=native_server._live_session_identity) as identity:
			row = self.runtime_row()
			catalog.assert_called_once()
			captured = identity.call_args.args[0]
			self.assertNotIn("private-", str(captured))
			self.assertEqual(set(captured["model_override"]), {"model", "provider"})
			self.assertEqual(set(vars(captured["agent"])), {"model", "provider"})
		self.assertEqual(row["message_count"], 0)
		self.assertEqual(row["cwd"], "/repo/nested/src")
		self.assertEqual(row["project"], {"id": inner, "name": "Chosen project", "icon": "beaker", "color": "#abcdef", "cwd": "/repo/nested", "is_home": False})
		self.assertNotEqual(row["project"]["id"], outer)
		self.assertEqual(row["provider"], "openai-codex")
		self.assertEqual(row["preview"], "")
		for path, content in before.items():
			self.assertEqual(path.read_bytes(), content)
		with closing(SessionDB(self.current / "native.sqlite3", read_only=True)) as db:
			self.assertIsNone(db.get_session("unsaved"))

	def test_native_provider_precedence_and_default_route_evidence_before_first_message(self):
		self.registry.clear()
		draft = {**self.session("draft", self.current), "source": "desktop", "history": [], "agent": None, "running": False}
		self.registry["draft"] = draft
		observed = []
		@contextmanager
		def profile_scope(session, *, hydrate_secrets):
			self.assertFalse(hydrate_secrets)
			observed.append(session["profile_home"])
			yield
		with patch.object(native_server, "_session_profile_runtime_scope", profile_scope), patch.object(native_server, "_resolve_startup_runtime", return_value=("native-default", None)), patch("hermes_cli.anon_auth.free_tier_route", return_value=True):
			# Actual native precedence + native free-tier default projection.
			self.assertEqual(self.runtime_row()["provider"], "nous")
		self.assertEqual(observed, [str(self.current)])
		with patch.object(native_server, "_session_default_route", side_effect=AssertionError("picked model must not borrow global default")):
			draft["model_override"] = {"model": "anthropic/not-evidence"}
			self.assertIsNone(self.runtime_row()["provider"])
			draft["model_override"]["provider"] = "composer-provider"
			self.assertEqual(self.runtime_row()["provider"], "composer-provider")
			draft["agent"] = SimpleNamespace(session_id="draft", model="built-model", provider="agent-provider")
			self.assertEqual(self.runtime_row()["provider"], "agent-provider")
			draft["_metadata_mirror"] = {"model": "mirror", "provider": "mirror-provider", "system_prompt": "private-mirror"}
			self.assertEqual(self.runtime_row()["provider"], "mirror-provider")
			draft["pending_model_switch"] = {"display_model": "queued", "display_provider": "pending-provider", "api_key": "private-switch"}
			self.assertEqual(self.runtime_row()["provider"], "pending-provider")
			draft["pending_model_switch"]["display_provider"] = "auto"
			self.assertIsNone(self.runtime_row()["provider"])

	def test_missing_provider_helper_keeps_precedence_and_voice_route_preserves_session_provider(self):
		self.registry.clear()
		draft = {**self.session("draft", None), "source": "desktop", "history": [], "running": False,
			"agent": SimpleNamespace(session_id="draft", model="voice-model", provider="voice-provider",
				_voice_route_state={"snapshot": {"model": "chat-model", "provider": "chat-provider", "base_url": "private-endpoint"}}),
			"model_override": {"model": "override", "provider": "override-provider"}}
		self.registry["draft"] = draft
		self.assertEqual(self.runtime_row()["provider"], "chat-provider")
		with patch.object(native_server, "_live_session_identity", None):
			self.assertEqual(self.runtime_row()["provider"], "chat-provider")
			draft["pending_model_switch"] = {"display_provider": "auto"}
			self.assertIsNone(self.runtime_row()["provider"])
			draft["agent"], draft["model_override"], draft["pending_model_switch"] = None, {}, {}
			self.assertIsNone(self.runtime_row()["provider"])

	def test_detached_home_and_missing_workspace_remain_distinct_without_global_cwd(self):
		self.registry.clear()
		draft = {**self.session("draft", None), "source": "desktop", "history": [], "agent": None, "running": False,
			"model_override": {"model": "model", "provider": "auto"}}
		self.registry["draft"] = draft
		# The native mapper can resolve model/title, but metadata must not ask the
		# global completion directory or the broad _session_info scanner.
		with patch.object(native_server, "_completion_cwd", side_effect=AssertionError("global cwd forbidden")), patch.object(native_server, "_session_info", side_effect=AssertionError("broad projection forbidden")):
			row = self.runtime_row()
			self.assertIsNone(row["cwd"])
			self.assertIsNone(row["project"])
			for cwd, explicit in [(None, True), ("", True), ("/launch-artifact", False)]:
				draft.update(cwd=cwd, explicit_cwd=explicit)
				row = self.runtime_row()
				self.assertIsNone(row["cwd"])
				self.assertTrue(row["project"]["is_home"])
				draft.update(cwd="/chosen", explicit_cwd=True)
				row = self.runtime_row()
				self.assertEqual(row["project"]["name"], "chosen")
				self.assertFalse(row["project"]["is_home"])

	def test_persisted_positive_history_survives_lazy_runtime_zero_and_unknown_is_not_empty(self):
		with closing(SessionDB(self.current / "native.sqlite3")) as db:
			db.append_message("collision", "user", "private-stored-content")
		self.registry["runtime-a"]["history"] = []
		self.assertEqual(self.runtime_row()["message_count"], 1)
		self.registry.clear()
		self.registry["unknown"] = {"session_key": "unsaved", "source": "desktop", "agent": None}
		self.assertIsNone(self.runtime_row()["message_count"])

	def test_missing_retirement_helper_fails_unavailable_instead_of_resurrecting_unknown_ids(self):
		import hermes_state_mutation_retirement as retirement

		with patch.object(retirement, "retired_session", None):
			response = self.client.get("/runtime")
		self.assertEqual(response.status_code, 503, response.text)

	def test_wrong_opened_store_is_refused_before_retirement_or_catalog_reads(self):
		with patch.object(native_sessions, "_open_session_db_for_profile", side_effect=lambda *args, **kwargs: SessionDB(self.homes["other-profile"] / "native.sqlite3", read_only=True)), patch.object(backend, "runtime_retired") as retired, patch.object(backend, "card_projects") as projects:
			response = self.client.get("/runtime")
		self.assertEqual(response.status_code, 403, response.text)
		retired.assert_not_called()
		projects.assert_not_called()

	def test_metadata_io_releases_lock_and_revalidates_snapshot_before_publication(self):
		from concurrent.futures import ThreadPoolExecutor
		from threading import Event

		self.registry.clear()
		draft = {**self.session("draft", self.current), "source": "desktop", "history": [], "agent": None, "running": False,
			"cwd": "/chosen", "explicit_cwd": True, "model_override": {"model": "selected", "provider": "provider"}}
		self.registry["draft"] = draft
		actor = Principal("owner", str(self.current), frozenset({"session:read"}), "http")
		request = SimpleNamespace(state=SimpleNamespace())
		for seam in ("mapper", "catalog", "provider", "retirement", "stored"):
			with self.subTest(seam=seam):
				self.registry["draft"] = draft
				entered, release = Event(), Event()
				def blocked(fn):
					def read(*args, **kwargs):
						entered.set()
						if not release.wait(2):
							raise TimeoutError("test IO release")
						return fn(*args, **kwargs)
					return read
				owner, name = {"mapper": (native_server, "_session_live_item"), "catalog": (backend, "card_projects"),
					"provider": (native_server, "_live_session_identity"), "retirement": (backend, "runtime_retired"),
					"stored": (SessionDB, "_get_session_rich_rows_batch")}[seam]
				def run():
					token = set_hermes_home_override(str(self.current))
					try:
						return backend.standalone_runtime(request, "exact-profile", actor)
					finally:
						reset_hermes_home_override(token)
				with patch.object(owner, name, blocked(getattr(owner, name))), ThreadPoolExecutor(max_workers=1) as pool:
					future = pool.submit(run)
					try:
						self.assertTrue(entered.wait(2))
						acquired = native_server._sessions_lock.acquire(timeout=.2)
						try:
							self.assertTrue(acquired, f"{seam} IO held global sessions lock")
							self.registry["draft"] = {**draft, "cwd": "/replacement"}
						finally:
							if acquired:
								native_server._sessions_lock.release()
					finally:
						release.set()
					if seam == "mapper":
						with self.assertRaises(backend.HTTPException) as exc:
							future.result(timeout=3)
						self.assertEqual(exc.exception.status_code, 503)
					else:
						row = future.result(timeout=3)["sessions"][0]
						self.assertIsNone(row["project"])
						self.assertIsNone(row["provider"])
						self.assertIsNone(row["cwd"])

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
