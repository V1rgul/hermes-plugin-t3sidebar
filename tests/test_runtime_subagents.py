"""Read-only ancillary counts: native roster/route guard, synthetic authority and children."""
import asyncio
from contextlib import closing
from pathlib import Path
import tempfile
from threading import RLock
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from gateway.config import Platform
from gateway.session_contract import Principal, SessionRef
from hermes_state import SessionDB
from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from hermes_state_runtime import RuntimeStoreError
import gateway.session_ancillary as ancillary
import tools.delegate_tool_registry as registry

from test_backend import backend


class AuthoritySubagents(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="flow-subagents-")
		self.addCleanup(self.temp.cleanup)
		self.home = Path(self.temp.name)
		token = set_hermes_home_override(str(self.home))
		self.addCleanup(reset_hermes_home_override, token)
		with closing(SessionDB(self.home / "native.sqlite3")) as db:
			db.create_session("durable", "cli")
		self.db = SessionDB(self.home / "native.sqlite3", read_only=True)
		self.addCleanup(self.db.close)
		self.parent = SimpleNamespace(session_id="durable", _session_db=self.db)
		self.actor = Principal("owner", str(self.home), frozenset({"session:read", "session:control"}), "http")
		self.live = SimpleNamespace(route="runtime-route", source=SimpleNamespace(platform=Platform.TELEGRAM),
			event_stream=SimpleNamespace(lock=RLock()))
		self.entry = SimpleNamespace(session_id="durable")
		store = SimpleNamespace(_lock=RLock(), _entries={"runtime-route": self.entry})
		self.authority = SimpleNamespace(profile_id=str(self.home), sessions={"durable": self.live},
			db=self.db, runner=SimpleNamespace(session_store=store), agent=lambda ref: self.parent,
			authorize=self.authorize)
		self.authorizations = []
		self.rows: list[dict] = [{"id": "durable", "session_key": "durable", "status": "idle", "source": "cli"}]
		self.children = {}
		self.start_patch(patch.object(registry, "_active_subagents", self.children))
		self.start_patch(patch.object(registry, "_active_subagents_lock", RLock()))
		self.start_patch(patch("hermes_cli.web_server_sessions._session_mutation_context", return_value=(self.authority, self.actor)))
		self.start_patch(patch("gateway.session_active_list.active_list", self.active_list))
		# No local receipts/config or worker construction: the synthetic source is in process.
		self.start_patch(patch("gateway.session_managed_worker.managed_policy", return_value=None))
		self.start_patch(patch("hermes_cli.profiles.profile_matches_home", side_effect=lambda name, home: name == "exact-profile" and home == self.home))

	def start_patch(self, patcher):
		value = patcher.start()
		self.addCleanup(patcher.stop)
		return value

	def authorize(self, actor, ref, capability):
		self.assertEqual(actor.capabilities, frozenset({"session:read"}))
		self.assertEqual((actor.subject, actor.transport_id), ("owner", "http"))
		self.assertEqual(ref, SessionRef(str(self.home), "durable"))
		self.assertEqual(capability, "session:read")
		self.authorizations.append(ref)

	async def active_list(self, connection, ref, params):
		self.assertIs(connection.authority, self.authority)
		return {"sessions": [dict(row) for row in self.rows]}

	def child(self, name, *, status="running", db=None, parent=None, durable: str | None="durable"):
		agent = SimpleNamespace(_session_db=db or self.db, _delegate_parent_ref=lambda: parent)
		self.children[name] = {"subagent_id": name, "agent": agent, "status": status,
			"owner_agent_session_id": durable, "owner_session_id": "old-runtime",
			"goal": "private-goal", "owner_transport": object()}
		return agent

	def runtime(self):
		return asyncio.run(backend.native_runtime(SimpleNamespace(state=SimpleNamespace()), "exact-profile"))

	def count(self):
		value = self.runtime()
		self.assertNotIn("private-goal", str(value))
		self.assertNotIn("subagents", value)
		return value["sessions"][0]["running_subagents"]

	def test_native_read_counts_idle_parent_live_nodes_not_delegations_or_completed_children(self):
		self.child("one", parent=self.parent)
		self.child("nested", parent=self.children["one"]["agent"])
		self.child("completed", status="completed")
		self.child("cancelled", status="cancelled")
		before = (self.home / "native.sqlite3").read_bytes()
		with patch.object(ancillary, "read", wraps=ancillary.read) as read:
			self.assertEqual(self.count(), 2)
			self.assertEqual(read.call_args.kwargs, {"kind": "subagents"})
			self.assertEqual(read.call_args.args[2], {"session_id": "durable", "profile": "exact-profile"})
			self.children.pop("one")
			self.assertEqual(self.count(), 1)
			self.children["nested"]["status"] = "completed"
			self.assertEqual(self.count(), 0)
			self.children.clear()
			self.assertEqual(self.count(), 0)
		self.assertEqual(len(self.authorizations), 4)
		self.assertEqual((self.home / "native.sqlite3").read_bytes(), before)

	def test_durable_fallback_does_not_include_same_id_in_foreign_database(self):
		self.child("owned")
		self.child("foreign", db=SimpleNamespace(db_path=self.home / "foreign.sqlite3"))
		self.child("runtime-only", durable=None)
		self.assertEqual(self.count(), 1)

	def test_unsupported_failed_missing_or_malformed_projection_is_unknown(self):
		self.child("one", parent=self.parent)
		self.assertEqual(self.count(), 1)
		for reason in ("unsupported_projection", "permission_denied", "not_found", "stale_generation", "storage_unavailable"):
			with self.subTest(reason=reason), patch.object(ancillary, "read", AsyncMock(side_effect=RuntimeStoreError(reason))):
				self.assertIsNone(self.count())
		for response in ({}, {"subagents": None}, {"subagents": [{"status": None}]}, {"subagents": [object()]}):
			with self.subTest(response=response), patch.object(ancillary, "read", AsyncMock(return_value=response)):
				self.assertIsNone(self.count())
		with patch.object(ancillary, "read", None):
			self.assertIsNone(self.count())
		with patch("gateway.session_managed_worker.managed_policy", return_value=object()):
			self.assertIsNone(self.count())

	def test_real_native_stale_route_guard_reports_unknown(self):
		self.child("one", parent=self.parent)
		self.assertEqual(self.count(), 1)
		self.entry.session_id = "replacement-conversation"
		self.assertIsNone(self.count())

	def test_cancellation_propagates_instead_of_returning_old_or_zero_count(self):
		with patch.object(ancillary, "read", AsyncMock(side_effect=asyncio.CancelledError())):
			with self.assertRaises(asyncio.CancelledError):
				self.runtime()

	def test_retired_ghost_is_excluded_before_ancillary_read_but_absent_draft_is_not_deleted(self):
		import hermes_state_mutation_retirement as retirement

		with closing(SessionDB(self.home / "native.sqlite3")) as db:
			assert db._conn is not None
			with db._conn:
				retirement.retire_routes(db._conn, ["retired"])
		self.rows.extend([
			{"id": "stale-route", "session_key": "retired", "source": "desktop", "message_count": 0},
			{"id": "draft", "session_key": "never-persisted", "source": "desktop", "message_count": 0},
		])
		before = (self.home / "native.sqlite3").read_bytes()
		with patch.object(ancillary, "read", AsyncMock(return_value={"subagents": []})) as read:
			for _ in range(2):
				rows = self.runtime()["sessions"]
				self.assertEqual([row["id"] for row in rows], ["durable", "draft"])
				self.assertEqual(rows[1]["message_count"], 0)
				self.assertIsNone(rows[1]["project"])
				self.assertIsNone(rows[1]["provider"])
			self.assertEqual([call.args[1].session_id for call in read.call_args_list], ["durable", "draft"] * 2)
		self.assertEqual((self.home / "native.sqlite3").read_bytes(), before)

	def test_authority_zero_message_stored_metadata_is_allowlisted_and_never_borrows_registry(self):
		from hermes_cli import projects_db

		with closing(SessionDB(self.home / "native.sqlite3")) as db:
			db.update_session_cwd("durable", "/repo/sub")
			assert db._conn is not None
			with db._conn:
				db._conn.execute("UPDATE sessions SET model_config=? WHERE id='durable'",
					('{"provider":"openai-codex","secret":"private-config"}',))
		with closing(projects_db.connect(self.home / "projects.db")) as conn:
			pid = projects_db.create_project(conn, name="Native project", folders=["/repo"], icon="tools", color="#abcdef")
		self.rows[0].update(message_count=0, preview="private-prompt", model_config={"secret": "private-config"})
		before = {path: path.read_bytes() for path in [self.home / "native.sqlite3", self.home / "projects.db"]}
		with patch.object(backend, "standalone_runtime", side_effect=AssertionError("no unrelated registry")), patch.object(projects_db, "connect", side_effect=AssertionError("no schema write")):
			row = self.runtime()["sessions"][0]
		self.assertEqual(row["message_count"], 0)
		self.assertEqual(row["cwd"], "/repo/sub")
		self.assertEqual(row["project"], {"id": pid, "name": "Native project", "cwd": "/repo", "icon": "tools", "color": "#abcdef", "is_home": False})
		self.assertEqual(row["provider"], "openai-codex")
		self.assertEqual(row["preview"], "")
		self.assertNotIn("private-", str(row))
		self.assertNotIn("model_config", row)
		for path, content in before.items():
			self.assertEqual(path.read_bytes(), content)

	def test_authority_actor_store_and_native_grant_must_match_exact_home_before_read(self):
		for mismatch in ("actor", "authority", "store", "grant", "capabilities"):
			with self.subTest(mismatch=mismatch):
				foreign = str(self.home / "foreign")
				actor = self.actor
				authority = SimpleNamespace(**vars(self.authority))
				request = SimpleNamespace(state=SimpleNamespace())
				if mismatch == "actor":
					actor = Principal("owner", foreign, frozenset({"session:read"}), "http")
				elif mismatch == "authority":
					authority.profile_id = foreign
				elif mismatch == "store":
					authority.db = SimpleNamespace(db_path=Path(foreign) / "native.sqlite3")
				elif mismatch == "grant":
					request.state.native_http_principal = {"profile_id": foreign}
				else:
					actor = Principal("owner", str(self.home), frozenset({"session:control"}), "http")
				with patch("hermes_cli.web_server_sessions._session_mutation_context", return_value=(authority, actor)), patch("gateway.session_active_list.active_list", AsyncMock()) as read:
					with self.assertRaises(backend.HTTPException) as exc:
						asyncio.run(backend.native_runtime(request, "exact-profile"))
					self.assertEqual(exc.exception.status_code, 403)
					read.assert_not_called()

	def test_persisted_history_is_not_erased_by_authority_runtime_zero(self):
		with closing(SessionDB(self.home / "native.sqlite3")) as db:
			db.append_message("durable", "user", "private-history")
		self.rows[0]["message_count"] = 0
		self.assertEqual(self.runtime()["sessions"][0]["message_count"], 1)

	def test_active_listing_failure_does_not_return_partial_snapshot(self):
		with patch("gateway.session_active_list.active_list", AsyncMock(side_effect=RuntimeStoreError("permission_denied"))), patch.object(ancillary, "read", AsyncMock()) as read:
			with self.assertRaises(RuntimeStoreError):
				self.runtime()
			read.assert_not_called()

	def test_cron_source_is_excluded_before_ancillary_read(self):
		self.rows.append({"id": "cron", "source": "cron"})
		with patch.object(ancillary, "read", wraps=ancillary.read) as read:
			self.assertEqual(len(self.runtime()["sessions"]), 1)
			self.assertEqual(read.call_count, 1)
