"""Plugin-owned composer drafts, shared by every Desktop client of this profile through one periodic sync call.

Each row holds the latest text of one session's composer, with the folder a new session reopens it in when that session has no stored history. Every write takes the next value of one sequence, so a client asks only for what changed after the last sequence it saw. A deleted draft stays as a marker without text, so its deletion reaches the other clients too, until it is purged after ``MARKER_DAYS``; a client whose cursor predates a purge gets a full snapshot instead.

The most recent edit wins. A client reports, by its own clock, how long before sending each edit happened; capped to one sync slot (``SYNC_SLOT_SECONDS``), that age is subtracted from this server's receive time, so clock differences between machines do not matter and an implausible age falls back to the slot.
"""

import json
import math
from pathlib import Path
import re
import sqlite3
import time


SESSION_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$"
# Bounds one draft, not the composer: anything longer is pasted content, not a draft worth syncing.
MAX_TEXT_LENGTH = 200_000
# The client's sync interval: an edit reported in a sync happened at most this long before it, unless its client was offline.
SYNC_SLOT_SECONDS = 30
MARKER_DAYS = 30
# Everything ensure_schema creates: a store missing any of them goes through the writer path once, which creates it.
SCHEMA_OBJECTS = ("session_drafts", "session_drafts_seq", "session_drafts_sync")


def validate_session_id(value):
	if type(value) is not str or re.fullmatch(SESSION_ID_PATTERN, value) is None:
		raise ValueError("invalid session id")
	return value


def _finite(value, name):
	if type(value) not in (int, float) or not math.isfinite(value):
		raise ValueError(f"{name} must be a finite number")
	return float(value)


class DraftStore:
	"""Short-lived per-operation connections to the profile's plugin SQLite file; SQLite serializes writers."""

	def __init__(self, path, clock=time.time):
		self.path = Path(path)
		self.clock = clock

	@staticmethod
	def ensure_schema(connection):
		connection.execute("""
			CREATE TABLE IF NOT EXISTS session_drafts (
				session_id TEXT PRIMARY KEY,
				text TEXT,
				cwd TEXT,
				edited_at REAL NOT NULL,
				seq INTEGER NOT NULL,
				updated_at REAL NOT NULL
			)
		""")
		connection.execute("CREATE INDEX IF NOT EXISTS session_drafts_seq ON session_drafts (seq)")
		# One row: the last sequence value given out, and the highest one purged with its deletion marker.
		connection.execute("""
			CREATE TABLE IF NOT EXISTS session_drafts_sync (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				seq INTEGER NOT NULL,
				purged_seq INTEGER NOT NULL
			)
		""")
		connection.execute("INSERT OR IGNORE INTO session_drafts_sync (id, seq, purged_seq) VALUES (1, 0, 0)")

	def sync(self, since, changes=(), sent_at=None):
		"""Apply ``changes`` ({session_id, text, cwd?, edited_at}; blank text deletes) and return the drafts changed after ``since``.

		Returns {"cursor", "reset", "drafts"}: each draft is {session_id, text (None once deleted), cwd, edited_at, seq}, and the current row of every changed session is included even when an older edit lost to it. With ``reset`` (a first sync, or a cursor older than a purge or newer than this store), ``drafts`` holds every existing draft, and anything absent from it is deleted.
		"""
		if type(since) is not int or since < 0:
			raise ValueError("since must be a nonnegative integer")
		changes = list(changes)
		for change in changes:
			validate_session_id(change.get("session_id"))
			if type(change.get("text")) is not str or len(change["text"]) > MAX_TEXT_LENGTH:
				raise ValueError("invalid draft text")
			if change.get("cwd") is not None and type(change["cwd"]) is not str:
				raise ValueError("invalid draft folder")
			_finite(change.get("edited_at"), "edited_at")
		sent_at = _finite(sent_at, "sent_at") if changes else 0.0
		# Polling alone never creates the store.
		if not changes and not self.path.is_file():
			return {"cursor": 0, "reset": True, "drafts": []}
		if not changes:
			value = self._quiet(since)
			if value is not None:
				return value
		self.path.parent.mkdir(parents=True, exist_ok=True)
		connection = sqlite3.connect(self.path, timeout=30, isolation_level=None)
		connection.row_factory = sqlite3.Row
		try:
			connection.execute("BEGIN IMMEDIATE")
			self.ensure_schema(connection)
			now = float(self.clock())
			if not math.isfinite(now):
				raise ValueError("clock must return a finite UTC epoch timestamp")
			seq, purged_seq = connection.execute("SELECT seq, purged_seq FROM session_drafts_sync WHERE id = 1").fetchone()
			changed = []
			for change in changes:
				sid = change["session_id"]
				edited_at = now - min(max(sent_at - float(change["edited_at"]), 0.0), SYNC_SLOT_SECONDS)
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
				(now - MARKER_DAYS * 86400,)).fetchone()[0]
			if purged is not None:
				connection.execute("DELETE FROM session_drafts WHERE text IS NULL AND updated_at < ?", (now - MARKER_DAYS * 86400,))
				purged_seq = max(purged_seq, purged)
			connection.execute("UPDATE session_drafts_sync SET seq = ?, purged_seq = ? WHERE id = 1", (seq, purged_seq))
			reset = since == 0 or since < purged_seq or since > seq
			rows = self._changed_rows(connection, since, reset, changed)
			connection.execute("COMMIT")
		except BaseException:
			if connection.in_transaction:
				connection.execute("ROLLBACK")
			raise
		finally:
			connection.close()
		return {"cursor": seq, "reset": reset, "drafts": [dict(row) for row in rows]}

	@staticmethod
	def _changed_rows(connection, since, reset, changed):
		return connection.execute(f"""
			SELECT session_id, text, cwd, edited_at, seq FROM session_drafts
			WHERE {"text IS NOT NULL" if reset else "seq > ?"} OR session_id IN (SELECT value FROM json_each(?)) ORDER BY seq
		""", ((json.dumps(changed),) if reset else (since, json.dumps(changed)))).fetchall()

	def _quiet(self, since):
		"""The sync of a client with nothing to send, read from one read-only snapshot; None when the schema or a due purge needs the writer path.

		Every client polls every sync slot, so this must not queue behind, or block, completion hooks and organisation writes. The writer path rechecks everything under its lock.
		"""
		connection = sqlite3.connect(self.path.resolve().as_uri() + "?mode=ro", uri=True, timeout=30, isolation_level=None)
		connection.row_factory = sqlite3.Row
		try:
			connection.execute("BEGIN")
			if connection.execute("SELECT COUNT(*) FROM sqlite_master WHERE name IN (SELECT value FROM json_each(?))",
				(json.dumps(SCHEMA_OBJECTS),)).fetchone()[0] != len(SCHEMA_OBJECTS):
				return None
			state = connection.execute("SELECT seq, purged_seq FROM session_drafts_sync WHERE id = 1").fetchone()
			if state is None:
				return None
			now = float(self.clock())
			if not math.isfinite(now):
				raise ValueError("clock must return a finite UTC epoch timestamp")
			if connection.execute("SELECT 1 FROM session_drafts WHERE text IS NULL AND updated_at < ? LIMIT 1",
				(now - MARKER_DAYS * 86400,)).fetchone() is not None:
				return None
			seq, purged_seq = state
			reset = since == 0 or since < purged_seq or since > seq
			rows = self._changed_rows(connection, since, reset, [])
			connection.execute("COMMIT")
		finally:
			connection.close()
		return {"cursor": seq, "reset": reset, "drafts": [dict(row) for row in rows]}

	def delete(self, session_ids):
		"""Mark the drafts of deleted sessions deleted, so every client drops them; nothing is created when no draft was ever saved."""
		ids = [validate_session_id(sid) for sid in session_ids]
		if not ids or not self.path.is_file():
			return
		connection = sqlite3.connect(self.path, timeout=30, isolation_level=None)
		try:
			connection.execute("BEGIN IMMEDIATE")
			self.ensure_schema(connection)
			now = float(self.clock())
			(seq,) = connection.execute("SELECT seq FROM session_drafts_sync WHERE id = 1").fetchone()
			for sid in ids:
				if connection.execute("SELECT 1 FROM session_drafts WHERE session_id = ? AND text IS NOT NULL", (sid,)).fetchone():
					seq += 1
					connection.execute("UPDATE session_drafts SET text = NULL, edited_at = ?, seq = ?, updated_at = ? WHERE session_id = ?", (now, seq, now, sid))
			connection.execute("UPDATE session_drafts_sync SET seq = ? WHERE id = 1", (seq,))
			connection.execute("COMMIT")
		except BaseException:
			if connection.in_transaction:
				connection.execute("ROLLBACK")
			raise
		finally:
			connection.close()
