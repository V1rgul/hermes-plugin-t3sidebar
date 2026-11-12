"""A late end yields to a newer turn of the same conversation even when a turn's start could not be written to the ledger."""

from contextlib import closing
from pathlib import Path
import sqlite3
from typing import Any
import unittest
from unittest.mock import patch

# Only the module object: importing its TestCase class here would run those tests twice under discovery.
import test_completion_hooks as base


CompletionStore = base.CompletionStore


class FailedStartOrderingTests(unittest.TestCase):
	ledger_path: Path
	observer: Any
	db: Any
	setUp = base.CompletionHookTests.setUp
	payload = base.CompletionHookTests.payload
	begin = base.CompletionHookTests.begin
	end = base.CompletionHookTests.end
	markers = base.CompletionHookTests.markers

	def acknowledge(self, token):
		with closing(sqlite3.connect(self.ledger_path)) as connection:
			self.assertTrue(CompletionStore.acknowledge(connection, "human", token))
			connection.commit()

	def unwritable_start(self):
		return patch.object(self.observer.store, "begin_run", side_effect=OSError("unwritable"))

	def test_failed_start_of_the_older_turn_does_not_mark_the_running_turn_done(self):
		with self.unwritable_start():
			self.begin(turn="first")
		self.begin(turn="second")
		self.end(turn="first")
		self.assertEqual(self.markers(), {})
		self.end(turn="second")
		self.assertEqual(self.markers()["human"]["done_token"], "second")

	def test_failed_start_of_the_older_turn_cannot_recreate_an_acknowledged_done(self):
		with self.unwritable_start():
			self.begin(turn="first")
		self.begin(turn="second")
		self.end(turn="second")
		self.acknowledge("second")
		self.end(turn="first")
		self.assertEqual(self.markers(), {})

	def test_failed_start_of_the_newer_turn_still_supersedes_the_older_one(self):
		self.begin(turn="first")
		with self.unwritable_start():
			self.begin(turn="second")
		# The ledger still names the older turn; the newer one is current and gets its Done.
		self.end(turn="second")
		self.assertEqual(self.markers()["human"]["done_token"], "second")
		self.acknowledge("second")
		self.end(turn="first")
		self.assertEqual(self.markers(), {})

	def test_both_starts_failing_still_lets_only_the_newer_turn_complete(self):
		with self.unwritable_start():
			self.begin(turn="first")
			self.begin(turn="second")
		self.end(turn="first")
		self.assertEqual(self.markers(), {})
		self.end(turn="second")
		self.assertEqual(self.markers()["human"]["done_token"], "second")

	def test_turn_order_is_kept_only_while_its_receipt_is(self):
		for sid in ("other-1", "other-2"):
			self.db.create_session(sid, "cli")
		self.observer._capacity = 2
		for sid in ("human", "other-1", "other-2"):
			with self.unwritable_start():
				self.begin(session=sid, turn=f"{sid}:turn")
		# The oldest receipt was evicted, and the order of its conversation with it.
		self.assertEqual(sorted(self.observer._latest), ["other-1", "other-2"])
		self.observer.close()
		self.assertEqual(self.observer._latest, {})


if __name__ == "__main__":
	unittest.main()
