"""The first listing page backfills organised and completed sessions from their ids alone, without building the whole sidebar state."""

from contextlib import closing
from pathlib import Path
import random
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from test_backend import backend


NOW = 1800000000.0


class OrganizedIdsBackfill(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="t3-organized-ids-")
		self.addCleanup(self.temp.cleanup)
		self.path = Path(self.temp.name) / "plugin-data/state.sqlite3"
		self.now = NOW
		self.listed = []
		def listing(profile, offset, limit, organized_ids):
			self.listed.append(organized_ids)
			return {"sessions": [], "total": 0, "offset": offset, "limit": limit}
		app = FastAPI()
		app.include_router(backend.create_router(self.path, lambda: self.now, sessions_reader=listing, profile_reader=lambda: "default"))
		self.client = TestClient(app)
		self.addCleanup(self.client.close)
		self.store = backend.HermesT3SidebarStore(self.path, lambda: self.now)
		self.ledger = backend.CompletionStore(self.path, lambda: self.now)

	def first_page(self):
		response = self.client.get("/sessions?profile=default")
		self.assertEqual(response.status_code, 200, response.text)
		return self.listed[-1]

	def expected(self):
		state = self.store.state()
		return tuple(sorted(state["sessions"].keys() | state["completions"].keys()))

	def test_the_first_page_builds_neither_the_state_nor_its_runs(self):
		self.store.mutate("pinned", backend.SessionAction(action="pin"))
		self.ledger.record("done", "turn")
		self.ledger.begin_run("running", "turn-2", NOW - 5)
		with patch.object(backend.HermesT3SidebarStore, "_state_rows", wraps=backend.HermesT3SidebarStore._state_rows) as rows, \
				patch.object(backend.CompletionStore, "read_runs", wraps=backend.CompletionStore.read_runs) as runs:
			ids = self.first_page()
		self.assertEqual(ids, ("done", "pinned"))
		self.assertEqual((rows.call_count, runs.call_count), (0, 0))

	def test_a_later_page_reads_no_ids(self):
		self.store.mutate("pinned", backend.SessionAction(action="pin"))
		response = self.client.get("/sessions?profile=default&offset=500")
		self.assertEqual(response.status_code, 200, response.text)
		self.assertEqual(self.listed, [()])

	def test_a_missing_store_is_created_as_before(self):
		self.assertEqual(self.first_page(), ())
		with closing(sqlite3.connect(self.path)) as connection:
			tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
		self.assertTrue({"session_metadata", "session_completions", "completion_receipts", "session_runs"} <= tables)

	def test_a_due_wake_is_materialised_by_the_first_page(self):
		self.store.mutate("sleeper", backend.SessionAction(action="snooze", wake_at=NOW + 10))
		self.now = NOW + 20
		self.assertEqual(self.first_page(), ("sleeper",))
		with closing(sqlite3.connect(self.path)) as connection:
			row = connection.execute("SELECT state, woke_at FROM session_metadata WHERE session_id = 'sleeper'").fetchone()
		self.assertEqual(row, ("active", NOW + 10))

	def test_a_legacy_store_is_migrated_by_the_first_page(self):
		self.path.parent.mkdir(parents=True)
		with closing(sqlite3.connect(self.path)) as connection:
			connection.execute("""CREATE TABLE session_metadata (session_id TEXT PRIMARY KEY, state TEXT NOT NULL, settled_at REAL, wake_at REAL,
				pinned INTEGER NOT NULL, updated_at REAL NOT NULL)""")
			connection.execute("INSERT INTO session_metadata VALUES ('old', 'settled', 5.0, NULL, 0, 5.0)")
			connection.execute("""CREATE TABLE session_runs (session_id TEXT PRIMARY KEY, started_at REAL NOT NULL, ended_at REAL, turn_id TEXT NOT NULL)""")
			connection.commit()
		self.assertEqual(self.first_page(), ("old",))
		with closing(sqlite3.connect(self.path)) as connection:
			metadata = {row[1] for row in connection.execute("PRAGMA table_info(session_metadata)")}
			runs = {row[1] for row in connection.execute("PRAGMA table_info(session_runs)")}
			tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
		self.assertIn("woke_at", metadata)
		self.assertIn("pending", runs)
		self.assertIn("session_completions", tables)

	def test_a_store_lacking_only_the_run_column_is_migrated_by_the_first_page(self):
		self.store.mutate("pinned", backend.SessionAction(action="pin"))
		with closing(sqlite3.connect(self.path)) as connection:
			connection.execute("DROP TABLE session_runs")
			connection.execute("""CREATE TABLE session_runs (session_id TEXT PRIMARY KEY, started_at REAL NOT NULL, ended_at REAL, turn_id TEXT NOT NULL)""")
			connection.commit()
		self.assertEqual(self.first_page(), ("pinned",))
		with closing(sqlite3.connect(self.path)) as connection:
			self.assertIn("pending", {row[1] for row in connection.execute("PRAGMA table_info(session_runs)")})

	def test_generated_stores_give_the_ids_the_full_state_gives(self):
		for seed in range(25):
			rng = random.Random(seed)
			with self.subTest(seed=seed):
				for step in range(rng.randint(0, 12)):
					sid = f"s{rng.randrange(8)}"
					roll = rng.random()
					if roll < .3:
						self.store.mutate(sid, backend.SessionAction(action=rng.choice(("pin", "unpin", "settle", "restore"))))
					elif roll < .45:
						self.store.mutate(sid, backend.SessionAction(action="snooze", wake_at=self.now + rng.choice((1.0, 50.0))))
					elif roll < .7:
						self.ledger.record(sid, f"turn-{seed}-{step}")
					elif roll < .85:
						self.ledger.begin_run(sid, f"run-{seed}-{step}", self.now - 1)
					else:
						state = self.store.state()
						if sid in state["completions"]:
							self.store.mutate(sid, backend.SessionAction(action="ack_done", done_token=state["completions"][sid]["done_token"]))
					self.now += rng.choice((0.0, 0.0, 10.0))
				ids = self.first_page()
				self.assertEqual(ids, self.expected())


if __name__ == "__main__":
	unittest.main()
