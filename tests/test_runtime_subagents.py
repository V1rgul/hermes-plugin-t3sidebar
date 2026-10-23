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
from hermes_state_runtime import RuntimeStoreError
import gateway.session_ancillary as ancillary
import tools.delegate_tool_registry as registry

from test_backend import backend


class AuthoritySubagents(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="flow-subagents-")
		self.addCleanup(self.temp.cleanup)
		self.home = Path(self.temp.name)
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
		self.rows = [{"id": "durable", "session_key": "durable", "status": "idle", "source": "cli"}]
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
