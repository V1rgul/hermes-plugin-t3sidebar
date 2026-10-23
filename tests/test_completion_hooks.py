"""Native hook dispatch and isolated SessionDB fixtures, with no UI or network."""

from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
import importlib
import importlib.util
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("t3sidebar_hook_test", ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
assert SPEC is not None and SPEC.loader is not None
plugin = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = plugin
SPEC.loader.exec_module(plugin)
hooks = importlib.import_module("t3sidebar_hook_test.completion_hooks")
CompletionStore = importlib.import_module("t3sidebar_hook_test.completion_state").CompletionStore


class CompletionHookTests(unittest.TestCase):
	def setUp(self):
		try:
			from hermes_constants import set_hermes_home_override, reset_hermes_home_override
			from hermes_state import SessionDB
			from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
		except ImportError as exc:
			self.skipTest(f"Native Hermes test runtime unavailable: {exc}")
		self.temp = tempfile.TemporaryDirectory(prefix="t3sidebar-native-hooks-")
		self.addCleanup(self.temp.cleanup)
		self.home = Path(self.temp.name).resolve()
		self.token = set_hermes_home_override(self.home)
		self.addCleanup(reset_hermes_home_override, self.token)
		# No default plugin discovery, production state, credentials or API calls.
		self.db = SessionDB(db_path=self.home / "state.db")
		self.addCleanup(self.db.close)
		self.db.create_session("human", "cli")
		self.manager = PluginManager(scope_key=str(self.home))
		self.context = PluginContext(PluginManifest(name="hermes-t3sidebar", path=str(ROOT)), self.manager)
		plugin.register(self.context)
		self.observer = getattr(self.manager._hooks["on_session_end"][0], "__self__")
		self.addCleanup(self.observer.close)
		# Exercise the actual native timeout worker and its copied home context.
		self.timeout_patch = patch("hermes_cli.plugins._resolve_hook_callback_timeout", return_value=5)
		self.timeout_patch.start()
		self.addCleanup(self.timeout_patch.stop)
		self.ledger_path = self.home / "plugin-data/hermes-t3sidebar/state.sqlite3"

	def payload(self, session="human", turn="human:task:turn1", **updates):
		result = dict(session_id=session, task_id="task", turn_id=turn, platform="cli", model="test-model", telemetry_schema_version=1)
		result.update(updates)
		return result

	def begin(self, session="human", turn="human:task:turn1", **updates):
		return self.manager.invoke_hook("pre_llm_call", **self.payload(session, turn, **updates))

	def end(self, session="human", turn="human:task:turn1", **updates):
		payload = self.payload(session, turn, completed=True, failed=False, interrupted=False, turn_exit_reason="text_response(stop)")
		payload.update(updates)
		return self.manager.invoke_hook("on_session_end", **payload)

	def markers(self):
		if not self.ledger_path.exists():
			return {}
		with closing(sqlite3.connect(self.ledger_path)) as connection:
			return CompletionStore.read(connection)

	def delegate(self, name="deleg_1", session="human", state="running", owner="parent_session_id"):
		with closing(sqlite3.connect(self.home / "state.db")) as connection:
			connection.execute(f"INSERT INTO async_delegations (delegation_id, origin_session, {owner}, state, dispatched_at, updated_at) VALUES (?, '', ?, ?, ?, ?)", (name, session, state, time.time(), time.time()))
			connection.commit()

	def test_registered_hooks_are_native_observers_only(self):
		self.assertEqual(set(self.manager._hooks), {"pre_llm_call", "on_session_end"})
		self.assertEqual(self.manager._middleware, {})
		self.assertEqual(self.manager._plugin_tool_names, set())

	def test_native_pre_turn_helper_supplies_matching_turn_receipt(self):
		from agent.turn_context import _collect_pre_llm_call_context
		agent = SimpleNamespace(session_id="human", model="test", platform="cli")
		# Dispatch through this isolated manager, not native auto-discovery.
		with patch("hermes_cli.lifecycle.invoke_hook", self.manager.invoke_hook):
			context = _collect_pre_llm_call_context(agent, effective_task_id="task", turn_id="native-turn", original_user_message="ignored", messages=[], conversation_history=[])
		self.assertEqual(context, "")
		self.end(turn="native-turn")
		self.assertEqual(self.markers()["human"]["done_token"], "native-turn")

	def test_success_records_without_desktop_then_dedupes_after_ack(self):
		self.assertEqual(self.begin(), [])
		self.assertEqual(self.end(), [])
		marker = self.markers()["human"]
		self.assertEqual(marker["done_token"], "human:task:turn1")
		self.assertGreater(marker["done_at"], 0)
		with closing(sqlite3.connect(self.ledger_path)) as connection:
			self.assertTrue(CompletionStore.acknowledge(connection, "human", marker["done_token"]))
			connection.commit()
		self.end()
		self.assertEqual(self.markers(), {})
		# A new process/observer can replay both hooks; durable receipts still win.
		other = hooks.CompletionObserver(self.home)
		self.addCleanup(other.close)
		other.on_pre_llm_call(**self.payload())
		other.on_session_end(**self.payload(completed=True, failed=False, interrupted=False))
		self.assertEqual(self.markers(), {})
		self.begin(turn="human:task:turn2")
		self.end(turn="human:task:turn2")
		self.assertEqual(self.markers()["human"]["done_token"], "human:task:turn2")

	def test_flags_must_be_present_and_exact_booleans(self):
		cases = [dict(completed=False), dict(completed=1), dict(completed=None), dict(failed=True), dict(failed=0), dict(failed=None), dict(interrupted=True), dict(interrupted=0), dict(interrupted=None)]
		for index, flags in enumerate(cases):
			with self.subTest(flags=flags):
				turn = f"flags-{index}"
				self.begin(turn=turn)
				self.end(turn=turn, **flags)
		self.assertEqual(self.markers(), {})
		for field in ("completed", "failed", "interrupted"):
			turn = "missing-" + field
			self.begin(turn=turn)
			payload = self.payload(turn=turn, completed=True, failed=False, interrupted=False)
			del payload[field]
			self.assertEqual(self.manager.invoke_hook("on_session_end", **payload), [])
		self.assertEqual(self.markers(), {})

	def test_missing_or_malformed_identity_never_falls_back(self):
		for index, updates in enumerate((dict(turn_id=None), dict(turn_id=""), dict(turn_id="bad/turn"), dict(turn_id=" x "), dict(turn_id="a" * 257), dict(session_id="../human"), dict(session_id="hum"), dict(task_id=None), dict(task_id="wrong"))):
			with self.subTest(updates=updates):
				turn = f"invalid-{index}"
				self.begin(turn=turn)
				self.end(turn=turn, **updates)
		self.end(turn="no-begin")
		self.assertEqual(self.markers(), {})

	def test_source_and_worker_platform_filters(self):
		for index, source in enumerate(("cron", "kanban", "tool", "oneshot", "subagent", "internal", "unknown", "")):
			sid = f"nonhuman-{index}"
			self.db.create_session(sid, source)
			self.begin(sid, f"source-{index}")
			self.end(sid, f"source-{index}")
		for platform in ("cron", "subagent", "kanban", "internal"):
			self.begin(turn=platform, platform=platform)
			self.end(turn=platform, platform=platform)
		self.db.create_session("child", "cli", parent_session_id="human", model_config={"_delegate_from": "human"})
		self.begin("child", "child-turn")
		self.end("child", "child-turn")
		self.assertEqual(self.markers(), {})

	def test_source_changed_after_begin_is_rejected(self):
		self.begin()
		with closing(sqlite3.connect(self.home / "state.db")) as connection:
			connection.execute("UPDATE sessions SET source = 'cron' WHERE id = 'human'")
			connection.commit()
		self.end()
		self.assertEqual(self.markers(), {})

	def test_other_home_cannot_record_or_poison_begin(self):
		from hermes_constants import set_hermes_home_override, reset_hermes_home_override
		self.begin()
		other_home = self.home / "other-profile"
		other_home.mkdir()
		token = set_hermes_home_override(other_home)
		try:
			self.begin()
			self.end()
			self.assertFalse((other_home / "plugin-data").exists())
		finally:
			reset_hermes_home_override(token)
		self.assertEqual(self.markers(), {})
		self.end()
		self.assertIn("human", self.markers())

	def test_two_profile_observers_with_colliding_ids_stay_separate(self):
		from hermes_constants import set_hermes_home_override, reset_hermes_home_override
		from hermes_state import SessionDB
		other_home = self.home / "other-profile"
		other_home.mkdir()
		token = set_hermes_home_override(other_home)
		try:
			with closing(SessionDB(db_path=other_home / "state.db")) as db:
				db.create_session("human", "cli")
			other = hooks.CompletionObserver(other_home)
			self.addCleanup(other.close)
			other.on_pre_llm_call(**self.payload())
			self.begin()
			self.end()
			other.on_session_end(**self.payload(completed=True, failed=False, interrupted=False))
		finally:
			reset_hermes_home_override(token)
		self.assertEqual(self.markers(), {})
		self.begin()
		self.end()
		self.assertIn("human", self.markers())
		with closing(sqlite3.connect(other.store.path)) as connection:
			self.assertIn("human", CompletionStore.read(connection))

	def test_exact_alias_maps_compression_but_not_branch(self):
		self.db.end_session("human", "compression")
		self.db.create_session("human-tip", "cli", parent_session_id="human")
		self.db.create_session("branch", "cli", parent_session_id="human", model_config={"_branched_from": "human"})
		self.begin("human-tip", "compressed")
		self.end("human-tip", "compressed")
		self.assertEqual(set(self.markers()), {"human"})
		self.begin("branch", "branch-response")
		self.end("branch", "branch-response")
		self.assertEqual(set(self.markers()), {"human", "branch"})
		self.assertEqual(self.markers()["branch"]["done_token"], "branch-response")

	def test_mid_turn_compression_preserves_identity(self):
		self.begin()
		self.db.end_session("human", "compression")
		self.db.create_session("tip", "cli", parent_session_id="human")
		self.end("tip")
		self.assertEqual(set(self.markers()), {"human"})

	def test_ref_mismatch_and_substring_are_not_success(self):
		self.db.create_session("human-other", "cli")
		self.begin()
		self.end("human-other")
		self.begin("huma", "prefix")
		self.end("huma", "prefix")
		self.assertEqual(self.markers(), {})

	def test_live_dispatch_and_already_finished_dispatch_are_suppressed(self):
		for state in ("running", "finalizing", "stalling", "unknown", "completed"):
			with self.subTest(state=state):
				turn = "dispatch-" + state
				self.begin(turn=turn)
				self.delegate("deleg-" + state, state=state)
				self.end(turn=turn)
				self.assertEqual(self.markers(), {})
		with closing(sqlite3.connect(self.home / "state.db")) as connection:
			connection.execute("UPDATE async_delegations SET state = 'completed'")
			connection.commit()
		# Child hooks and child-stop events cannot certify parent aggregation.
		self.db.create_session("child", "cli", parent_session_id="human", model_config={"_delegate_from": "human"})
		self.begin("child", "child-result", platform="subagent")
		self.end("child", "child-result", platform="subagent")
		self.assertEqual(self.manager.invoke_hook("subagent_stop", parent_session_id="human", child_status="completed"), [])
		self.assertEqual(self.markers(), {})
		self.begin(turn="aggregation")
		self.end(turn="aggregation")
		self.assertEqual(self.markers()["human"]["done_token"], "aggregation")

	def test_existing_live_child_blocks_until_later_parent_response(self):
		self.delegate()
		self.begin()
		self.end()
		self.assertEqual(self.markers(), {})

	def test_delegation_scope_uses_compression_aliases_not_other_conversations(self):
		self.db.end_session("human", "compression")
		self.db.create_session("tip", "cli", parent_session_id="human")
		self.db.create_session("other", "cli")
		self.delegate("other-child", session="other")
		self.begin("tip")
		self.end("tip")
		self.assertIn("human", self.markers())
		for owner in ("parent_session_id", "origin_session_id", "origin_ui_session_id"):
			turn = "alias-" + owner
			self.begin("tip", turn)
			self.delegate(turn, session="human", owner=owner)
			self.end("tip", turn)
		self.assertEqual(self.markers()["human"]["done_token"], "human:task:turn1")

	def test_observer_does_not_write_native_database(self):
		with closing(sqlite3.connect(self.home / "state.db")) as connection:
			before = "\n".join(connection.iterdump())
		self.begin()
		self.end()
		with closing(sqlite3.connect(self.home / "state.db")) as connection:
			self.assertEqual("\n".join(connection.iterdump()), before)

	def test_content_payloads_are_never_inspected_or_retained(self):
		class ContentTrap:
			def __str__(self):
				raise AssertionError("content consumed")
			def __iter__(self):
				raise AssertionError("content consumed")
		trap = ContentTrap()
		self.begin(user_message=trap, conversation_history=trap, result=trap)
		self.end(final_response=trap, result=trap, messages=trap)
		self.assertIn("human", self.markers())
		self.assertNotIn("ContentTrap", repr(self.observer._receipts))

	def test_unknown_schema_and_io_errors_fail_open(self):
		with patch.object(hooks, "native_snapshot", side_effect=RuntimeError("unavailable")):
			self.assertEqual(self.begin(), [])
		self.assertEqual(self.end(), [])
		self.begin(turn="write-error")
		with patch.object(self.observer.store, "record", side_effect=OSError("unwritable")):
			self.assertEqual(self.end(turn="write-error"), [])
		self.assertEqual(self.markers(), {})
		with closing(sqlite3.connect(self.home / "state.db")) as connection:
			connection.execute("DROP TABLE async_delegations")
			connection.commit()
		self.begin(turn="unknown-schema")
		self.end(turn="unknown-schema")
		self.assertEqual(self.markers(), {})

	def test_late_begin_cannot_rearm_ended_turn(self):
		entered, release = threading.Event(), threading.Event()
		snapshot = hooks.native_snapshot(self.home, "human")
		def delayed(*args, **kwargs):
			entered.set()
			self.assertTrue(release.wait(5))
			return snapshot
		with patch.object(hooks, "native_snapshot", side_effect=delayed):
			from contextvars import copy_context
			with ThreadPoolExecutor(max_workers=1) as executor:
				future = executor.submit(copy_context().run, self.observer.on_pre_llm_call, **self.payload())
				self.assertTrue(entered.wait(5))
				self.assertIsNone(self.observer.on_session_end(**self.payload(completed=True, failed=False, interrupted=False)))
				release.set()
				self.assertIsNone(future.result(timeout=5))
		self.end()
		self.assertEqual(self.markers(), {})

	def test_slow_begin_worker_cannot_absorb_new_finished_dispatch(self):
		entered, release = threading.Event(), threading.Event()
		native_snapshot = hooks.native_snapshot
		def delayed(*args, **kwargs):
			entered.set()
			self.assertTrue(release.wait(5))
			return native_snapshot(*args, **kwargs)
		with patch.object(hooks, "native_snapshot", side_effect=delayed):
			from contextvars import copy_context
			with ThreadPoolExecutor(max_workers=1) as executor:
				future = executor.submit(copy_context().run, self.observer.on_pre_llm_call, **self.payload())
				self.assertTrue(entered.wait(5))
				# A native timeout can let tools run before the observer returns.
				self.delegate(state="completed")
				release.set()
				self.assertIsNone(future.result(timeout=5))
		self.end()
		self.assertEqual(self.markers(), {})

	def test_receipts_are_bounded_expire_and_cleanup_fences_workers(self):
		self.observer._capacity = 2
		for turn in ("one", "two", "three"):
			self.begin(turn=turn)
		self.assertEqual(len(self.observer._receipts), 2)
		self.end(turn="one")
		self.assertEqual(self.markers(), {})
		self.observer.clock = lambda: 10 ** 12
		self.end(turn="three")
		self.assertEqual(self.markers(), {})
		self.observer.close()
		self.begin(turn="after-unload")
		self.end(turn="after-unload")
		self.assertEqual(len(self.observer._receipts), 0)
		self.assertEqual(self.markers(), {})


if __name__ == "__main__":
	unittest.main()
