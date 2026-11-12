"""Lookups that every sync or turn end repeats go through an index, and a store written before the index existed gets it on its next write."""

from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from test_backend import backend


NOW = 1800000000.0
DAY = 86400.0


def plan(path, sql):
	with closing(sqlite3.connect(path)) as connection:
		return " | ".join(row[-1] for row in connection.execute("EXPLAIN QUERY PLAN " + sql))


def indexes(path):
	with closing(sqlite3.connect(path)) as connection:
		return {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'")}


def traced(call, *args):
	"""The statements a call executes, with their parameters bound, so their query plans can be read afterwards."""
	statements = []
	connect = sqlite3.connect
	def tracing(*connect_args, **kwargs):
		connection = connect(*connect_args, **kwargs)
		connection.set_trace_callback(statements.append)
		return connection
	with patch.object(sqlite3, "connect", tracing):
		call(*args)
	return statements


class DraftMarkerPurgeIndex(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="t3-lookup-indexes-")
		self.addCleanup(self.temp.cleanup)
		self.path = Path(self.temp.name) / "state.sqlite3"
		self.now = NOW
		self.store = backend.session_drafts.DraftStore(self.path, lambda: self.now)
		self.store.sync(0, [{"session_id": "kept", "text": "kept text", "edited_at": NOW}, {"session_id": "gone", "text": "", "edited_at": NOW}], NOW)

	def marker_statements(self, *calls):
		statements = [sql for call in calls for sql in traced(*call) if "text IS NULL AND updated_at <" in sql]
		self.assertTrue(statements)
		return statements

	def test_every_expired_marker_lookup_uses_the_marker_age_index(self):
		quiet = self.marker_statements((self.store.sync, 2))
		writer = self.marker_statements((self.store.sync, 2, [{"session_id": "kept", "text": "newer", "edited_at": NOW}], NOW))
		self.now += backend.session_drafts.MARKER_DAYS * DAY + 1
		purge = self.marker_statements((self.store.sync, 3))
		self.assertEqual(len(purge), 3)
		for sql in quiet + writer + purge:
			self.assertIn("USING INDEX session_drafts_marker_age", plan(self.path, sql), sql)

	def test_a_store_from_before_the_index_gets_it_on_its_next_sync(self):
		with closing(sqlite3.connect(self.path)) as connection:
			connection.execute("DROP INDEX IF EXISTS session_drafts_marker_age")
			connection.commit()
		value = self.store.sync(2)
		self.assertEqual(value, {"cursor": 2, "reset": False, "drafts": []})
		self.assertIn("session_drafts_marker_age", indexes(self.path))


class TurnEndIndex(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="t3-lookup-indexes-")
		self.addCleanup(self.temp.cleanup)
		self.path = Path(self.temp.name) / "state.sqlite3"
		self.ledger = backend.CompletionStore(self.path, lambda: NOW)
		for index in range(3):
			self.ledger.begin_run(f"root-{index}", f"turn-{index}", NOW - 10)

	def test_a_turn_end_finds_its_run_through_a_turn_index(self):
		updates = [sql for sql in traced(self.ledger.end_run, "turn-1") if sql.lstrip().upper().startswith("UPDATE")]
		self.assertEqual(len(updates), 1)
		self.assertIn("USING INDEX session_runs_turn", plan(self.path, updates[0]))
		self.assertEqual(self.ledger.end_run("turn-1"), False)

	def test_a_store_from_before_the_index_gets_it_on_its_next_write(self):
		with closing(sqlite3.connect(self.path)) as connection:
			connection.execute("DROP INDEX IF EXISTS session_runs_turn")
			connection.commit()
		self.assertTrue(self.ledger.end_run("turn-2"))
		self.assertIn("session_runs_turn", indexes(self.path))


if __name__ == "__main__":
	unittest.main()
