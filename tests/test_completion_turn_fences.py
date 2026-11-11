"""A late or unloaded end hook cannot publish or write for a turn that is no longer current."""

from contextlib import closing
from pathlib import Path
import sqlite3
from typing import Any
import unittest
from unittest.mock import patch

# Only the module object: importing its TestCase class here would run those tests twice under discovery.
import test_completion_hooks as base


hooks = base.hooks
CompletionStore = base.CompletionStore


class TurnFenceTests(unittest.TestCase):
	ledger_path: Path
	observer: Any
	setUp = base.CompletionHookTests.setUp
	payload = base.CompletionHookTests.payload
	begin = base.CompletionHookTests.begin
	end = base.CompletionHookTests.end
	markers = base.CompletionHookTests.markers
	runs = base.CompletionHookTests.runs

	def acknowledge(self, token):
		with closing(sqlite3.connect(self.ledger_path)) as connection:
			self.assertTrue(CompletionStore.acknowledge(connection, "human", token))
			connection.commit()

	def test_late_end_of_a_superseded_turn_does_not_mark_the_running_turn_done(self):
		self.begin(turn="first")
		self.begin(turn="second")
		self.end(turn="first")
		self.assertEqual(self.markers(), {})
		self.end(turn="second")
		self.assertEqual(self.markers()["human"]["done_token"], "second")

	def test_late_end_of_a_superseded_turn_cannot_replace_the_newer_completion(self):
		self.begin(turn="first")
		self.begin(turn="second")
		self.end(turn="second")
		self.end(turn="first")
		self.assertEqual(self.markers()["human"]["done_token"], "second")

	def test_late_end_of_a_superseded_turn_cannot_recreate_an_acknowledged_done(self):
		self.begin(turn="first")
		self.begin(turn="second")
		self.end(turn="second")
		self.acknowledge("second")
		self.end(turn="first")
		self.assertEqual(self.markers(), {})

	def test_unrecorded_start_of_the_current_turn_does_not_block_its_completion(self):
		self.begin(turn="first")
		self.end(turn="first")
		self.acknowledge("first")
		# The ledger still names the previous turn: without this turn's own start it is no evidence of a newer one.
		with patch.object(self.observer.store, "begin_run", side_effect=OSError("unwritable")):
			self.begin(turn="second")
		self.end(turn="second")
		self.assertEqual(self.markers()["human"]["done_token"], "second")

	def test_unload_during_the_end_snapshot_leaves_the_ledger_untouched(self):
		self.begin()
		snapshot = hooks.native_snapshot
		def close_first(*args, **kwargs):
			self.observer.close()
			return snapshot(*args, **kwargs)
		with patch.object(hooks, "native_snapshot", side_effect=close_first):
			self.observer.on_session_end(**self.payload(completed=True, failed=False, interrupted=False))
		self.assertIsNone(self.runs()["human"]["ended_at"])
		self.assertEqual(self.markers(), {})


if __name__ == "__main__":
	unittest.main()
