"""An older turn's end that is already running cannot complete once the newer turn's order entry was pruned (evicted or expired)."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
from contextvars import copy_context
from pathlib import Path
import sqlite3
import threading
from typing import Any
import unittest
from unittest.mock import patch

# Only the module object: importing its TestCase class here would run those tests twice under discovery.
import test_completion_hooks as base


hooks = base.hooks
CompletionStore = base.CompletionStore


class PrunedOrderTests(unittest.TestCase):
	ledger_path: Path
	observer: Any
	db: Any
	setUp = base.CompletionHookTests.setUp
	payload = base.CompletionHookTests.payload
	begin = base.CompletionHookTests.begin
	markers = base.CompletionHookTests.markers

	def unwritable_start(self):
		return patch.object(self.observer.store, "begin_run", side_effect=OSError("unwritable"))

	@contextmanager
	def paused_end(self, turn):
		# Holds the end inside its native end snapshot, after it has taken its receipt and before it decides on Done.
		entered, release = threading.Event(), threading.Event()
		original = hooks.native_snapshot

		def snapshot(home, sid, **kwargs):
			if sid == "human" and "dispatched_before" not in kwargs:
				entered.set()
				if not release.wait(30):
					raise AssertionError("paused end was never released")
			return original(home, sid, **kwargs)

		with patch.object(hooks, "native_snapshot", side_effect=snapshot), ThreadPoolExecutor(max_workers=1) as pool:
			payload = self.payload(turn=turn, completed=True, failed=False, interrupted=False, turn_exit_reason="text_response(stop)")
			future = pool.submit(copy_context().run, self.observer.on_session_end, **payload)
			try:
				self.assertTrue(entered.wait(10), "end did not reach its native snapshot")
				yield
			finally:
				release.set()
				future.result(timeout=30)

	def test_evicting_the_newer_turn_does_not_let_the_older_end_complete(self):
		self.observer._capacity = 2
		with self.unwritable_start():
			self.begin(turn="A")
			self.begin(turn="B")
		with self.paused_end("A"):
			for sid in ("other-1", "other-2"):
				self.db.create_session(sid, "cli")
				self.begin(session=sid, turn=sid)
			self.assertNotIn(("task", "B"), self.observer._receipts)
			self.assertNotIn("human", self.observer._latest)
		self.assertEqual(self.markers(), {})

	def test_expiry_of_the_newer_turn_does_not_let_the_older_end_complete(self):
		clock = [100.0]
		self.observer.clock = lambda: clock[0]
		with self.unwritable_start():
			self.begin(turn="A")
			clock[0] = 101.0
			self.begin(turn="B")
		clock[0] = 102.0
		with self.paused_end("A"):
			# B (started at 101) has expired; A's end marker (written at 102) has not.
			clock[0] = 101.0 + self.observer._ttl + 0.5
			self.db.create_session("other", "cli")
			self.begin(session="other", turn="other")
			self.assertIn(("task", "A"), self.observer._receipts)
			self.assertNotIn(("task", "B"), self.observer._receipts)
			self.assertNotIn("human", self.observer._latest)
		self.assertEqual(self.markers(), {})

	def test_paused_end_of_the_latest_turn_still_completes_when_its_start_was_not_written(self):
		self.observer._capacity = 2
		with self.unwritable_start():
			self.begin(turn="A")
		with self.paused_end("A"):
			self.db.create_session("other", "cli")
			self.begin(session="other", turn="other")
		self.assertEqual(self.markers()["human"]["done_token"], "A")


if __name__ == "__main__":
	unittest.main()
