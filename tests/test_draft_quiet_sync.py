"""A draft sync with nothing to send reads one snapshot instead of taking the writer lock, and answers exactly as the writer path would."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import json
import math
from pathlib import Path
import random
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from test_backend import backend


drafts = backend.session_drafts
DAY = 86400.0


def reference_sync(store, since, changes=(), sent_at=None):
	"""DraftStore.sync as it was before quiet polls got their read-only path: every sync with an existing store is a writer transaction."""
	if type(since) is not int or since < 0:
		raise ValueError("since must be a nonnegative integer")
	changes = list(changes)
	for change in changes:
		drafts.validate_session_id(change.get("session_id"))
		if type(change.get("text")) is not str or len(change["text"]) > drafts.MAX_TEXT_LENGTH:
			raise ValueError("invalid draft text")
		if change.get("cwd") is not None and type(change["cwd"]) is not str:
			raise ValueError("invalid draft folder")
		drafts._finite(change.get("edited_at"), "edited_at")
	sent_at = drafts._finite(sent_at, "sent_at") if changes else 0.0
	if not changes and not store.path.is_file():
		return {"cursor": 0, "reset": True, "drafts": []}
	store.path.parent.mkdir(parents=True, exist_ok=True)
	connection = sqlite3.connect(store.path, timeout=30, isolation_level=None)
	connection.row_factory = sqlite3.Row
	try:
		connection.execute("BEGIN IMMEDIATE")
		store.ensure_schema(connection)
		now = float(store.clock())
		if not math.isfinite(now):
			raise ValueError("clock must return a finite UTC epoch timestamp")
		seq, purged_seq = connection.execute("SELECT seq, purged_seq FROM session_drafts_sync WHERE id = 1").fetchone()
		changed = []
		for change in changes:
			sid = change["session_id"]
			edited_at = now - min(max(sent_at - float(change["edited_at"]), 0.0), drafts.SYNC_SLOT_SECONDS)
			changed.append(sid)
			current = connection.execute("SELECT edited_at FROM session_drafts WHERE session_id = ?", (sid,)).fetchone()
			if current is not None and current["edited_at"] > edited_at:
				continue
			seq += 1
			connection.execute("""
				INSERT INTO session_drafts (session_id, text, cwd, edited_at, seq, updated_at) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(session_id) DO UPDATE SET text = excluded.text, cwd = COALESCE(excluded.cwd, cwd),
					edited_at = excluded.edited_at, seq = excluded.seq, updated_at = excluded.updated_at
			""", (sid, change["text"] if change["text"].strip() else None, change.get("cwd"), edited_at, seq, now))
		purged = connection.execute("SELECT MAX(seq) FROM session_drafts WHERE text IS NULL AND updated_at < ?",
			(now - drafts.MARKER_DAYS * 86400,)).fetchone()[0]
		if purged is not None:
			connection.execute("DELETE FROM session_drafts WHERE text IS NULL AND updated_at < ?", (now - drafts.MARKER_DAYS * 86400,))
			purged_seq = max(purged_seq, purged)
		connection.execute("UPDATE session_drafts_sync SET seq = ?, purged_seq = ? WHERE id = 1", (seq, purged_seq))
		reset = since == 0 or since < purged_seq or since > seq
		rows = connection.execute(f"""
			SELECT session_id, text, cwd, edited_at, seq FROM session_drafts
			WHERE {"text IS NOT NULL" if reset else "seq > ?"} OR session_id IN (SELECT value FROM json_each(?)) ORDER BY seq
		""", ((json.dumps(changed),) if reset else (since, json.dumps(changed)))).fetchall()
		connection.execute("COMMIT")
	except BaseException:
		if connection.in_transaction:
			connection.execute("ROLLBACK")
		raise
	finally:
		connection.close()
	return {"cursor": seq, "reset": reset, "drafts": [dict(row) for row in rows]}


def dump(path):
	if not path.is_file():
		return None
	with closing(sqlite3.connect(path)) as connection:
		return (connection.execute("SELECT * FROM session_drafts ORDER BY session_id").fetchall(),
			connection.execute("SELECT * FROM session_drafts_sync").fetchall())


class Traced:
	"""Records every SQL statement and every opening of a SQLite file while active."""

	def __init__(self):
		self.statements, self.opens = [], []
		self.connect = sqlite3.connect

	def __call__(self, *args, **kwargs):
		self.opens.append((str(args[0]), kwargs.get("uri", False)))
		connection = self.connect(*args, **kwargs)
		connection.set_trace_callback(self.statements.append)
		return connection

	def __enter__(self):
		self.patch = patch.object(drafts.sqlite3, "connect", self)
		self.patch.start()
		return self

	def __exit__(self, *exc):
		self.patch.stop()

	def kinds(self):
		return [" ".join(sql.split()[:2]).upper() if sql.split()[0].upper() == "BEGIN" else sql.split()[0].upper() for sql in self.statements]


class QuietDraftSync(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="t3-quiet-drafts-")
		self.addCleanup(self.temp.cleanup)
		self.path = Path(self.temp.name) / "state.sqlite3"
		self.now = 1800000000.0
		self.store = drafts.DraftStore(self.path, lambda: self.now)
		self.store.sync(0, [{"session_id": "kept", "text": "kept text", "cwd": "/work", "edited_at": self.now}], self.now)

	def test_quiet_poll_reads_one_snapshot_without_writer_lock_or_schema_statements(self):
		before = self.path.read_bytes()
		with Traced() as traced:
			value = self.store.sync(1)
		self.assertEqual(value, {"cursor": 1, "reset": False, "drafts": []})
		self.assertEqual(self.path.read_bytes(), before)
		self.assertEqual(len(traced.opens), 1)
		self.assertIn("mode=ro", traced.opens[0][0])
		self.assertTrue(traced.opens[0][1])
		self.assertNotIn("BEGIN IMMEDIATE", traced.kinds())
		self.assertFalse(any(kind in ("CREATE", "INSERT", "UPDATE", "DELETE") for kind in traced.kinds()))

	def test_quiet_poll_is_not_blocked_by_a_reserved_writer(self):
		with closing(sqlite3.connect(self.path, isolation_level=None)) as blocker, ThreadPoolExecutor(max_workers=1) as pool:
			blocker.execute("BEGIN IMMEDIATE")
			blocker.execute("UPDATE session_drafts SET text = 'uncommitted'")
			future = pool.submit(self.store.sync, 0)
			try:
				value = future.result(timeout=5)
			finally:
				blocker.execute("ROLLBACK")
				future.result(timeout=35)
		self.assertEqual([(row["session_id"], row["text"]) for row in value["drafts"]], [("kept", "kept text")])

	def test_a_due_marker_purge_takes_the_writer_path(self):
		self.store.sync(1, [{"session_id": "gone", "text": "", "edited_at": self.now}], self.now)
		self.now += drafts.MARKER_DAYS * DAY + 1
		with Traced() as traced:
			value = self.store.sync(1)
		self.assertIn("BEGIN IMMEDIATE", traced.kinds())
		self.assertEqual(value["reset"], True)
		self.assertEqual(dump(self.path), ([("kept", "kept text", "/work", self.now - drafts.MARKER_DAYS * DAY - 1, 1, self.now - drafts.MARKER_DAYS * DAY - 1)], [(1, 2, 2)]))

	def test_a_store_missing_a_schema_object_takes_the_writer_path_once(self):
		with closing(sqlite3.connect(self.path)) as connection:
			connection.execute("DROP INDEX session_drafts_seq")
			connection.commit()
		with Traced() as traced:
			self.store.sync(1)
		self.assertIn("BEGIN IMMEDIATE", traced.kinds())
		with Traced() as traced:
			self.store.sync(1)
		self.assertNotIn("BEGIN IMMEDIATE", traced.kinds())

	def test_a_change_still_takes_the_writer_path(self):
		with Traced() as traced:
			self.store.sync(1, [{"session_id": "kept", "text": "newer", "edited_at": self.now}], self.now)
		self.assertIn("BEGIN IMMEDIATE", traced.kinds())

	def test_non_finite_clock_still_fails_a_quiet_poll(self):
		self.now = math.nan
		with self.assertRaises(ValueError):
			self.store.sync(1)


class QuietDraftSyncDifferential(unittest.TestCase):
	"""Generated sequences of syncs and deletions give the same responses and stores on the new and the reference implementation."""

	def run_sequence(self, seed):
		rng = random.Random(seed)
		with tempfile.TemporaryDirectory(prefix="t3-quiet-drafts-diff-") as temp:
			clock = [1800000000.0]
			current = drafts.DraftStore(Path(temp) / "current.sqlite3", lambda: clock[0])
			reference = drafts.DraftStore(Path(temp) / "reference.sqlite3", lambda: clock[0])
			cursors = [0, 0, 0]
			sids = [f"s{index}" for index in range(5)]
			for step in range(60):
				roll = rng.random()
				if roll < .15:
					clock[0] += drafts.MARKER_DAYS * DAY + rng.choice((-1.0, 0.0, 1.0))
				elif roll < .5:
					clock[0] += rng.choice((0.0, 0.0, 1.0, 30.0, DAY))
				if rng.random() < .08:
					ids = rng.sample(sids, rng.randint(1, 3))
					current.delete(ids)
					reference.delete(ids)
					self.assertEqual(dump(current.path), dump(reference.path), (seed, step))
					continue
				client = rng.randrange(len(cursors))
				since = rng.choice((cursors[client], cursors[client], 0, max(cursors[client] - 2, 0), cursors[client] + 3))
				changes = []
				if rng.random() < .45:
					for _ in range(rng.randint(1, 3)):
						change = {"session_id": rng.choice(sids), "text": rng.choice(("", " ", "draft a", "draft b")),
							"edited_at": clock[0] - rng.choice((0.0, 0.0, 5.0, 45.0, -10.0))}
						if rng.random() < .5:
							change["cwd"] = rng.choice(("/work", "/other"))
						changes.append(change)
				sent_at = clock[0] if changes else None
				expected = reference_sync(reference, since, changes, sent_at)
				actual = current.sync(since, changes, sent_at)
				self.assertEqual(actual, expected, (seed, step))
				stored = dump(current.path)
				self.assertEqual(stored, dump(reference.path), (seed, step))
				cursors[client] = actual["cursor"]
				self.covered["quiet"] += not changes and stored is not None
				self.covered["purged reset"] += bool(stored and since and expected["reset"] and stored[1][0][2] > since)

	def test_generated_sequences_match_the_writer_only_reference(self):
		self.covered = {"quiet": 0, "purged reset": 0}
		for seed in range(40):
			self.run_sequence(seed)
		self.assertGreater(min(self.covered.values()), 20, self.covered)


if __name__ == "__main__":
	unittest.main()
