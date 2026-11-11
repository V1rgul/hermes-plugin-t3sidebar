"""tools/test-webapp/seed_usage.py on a scratch database: a re-seed replaces only the sessions the seed wrote.

Hermes's SessionDB is replaced by a small recording stand-in over the same scratch file, so no Hermes store, home or plugin hook is reached.
"""

from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[1] / "tools" / "test-webapp" / "seed_usage.py"
SPEC = importlib.util.spec_from_file_location("hermes_t3sidebar_seed_usage", PATH)
assert SPEC is not None and SPEC.loader is not None
seed = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(seed)


def unsynced(*args, **kwargs):
	# A seed run commits a few hundred times; without fsync on the throwaway file the test takes a fraction of a second instead of half a minute.
	conn = sqlite3.connect(*args, **kwargs)
	conn.execute("PRAGMA synchronous = OFF")
	return conn


class ScratchSessionDB:
	"""The SessionDB calls the seed makes, applied to the scratch file it was opened on."""

	opened: list[Path] = []
	deleted: list[str] = []

	def __init__(self, path):
		ScratchSessionDB.opened.append(Path(path))
		self.path = path

	def _write(self, sql, params):
		with closing(unsynced(self.path)) as conn, conn:
			conn.execute(sql, params)

	def create_session(self, sid, source, model=None, cwd=None, **_):
		self._write("INSERT INTO sessions(id, source, model, cwd) VALUES (?, ?, ?, ?)", (sid, source, model, cwd))

	def append_message(self, *_, **__):
		pass

	def update_token_counts(self, sid, **_):
		self._write("INSERT INTO session_model_usage(session_id) VALUES (?)", (sid,))

	def set_session_archived(self, sid, archived):
		self._write("UPDATE sessions SET archived = ? WHERE id = ?", (int(archived), sid))

	def delete_session(self, sid):
		ScratchSessionDB.deleted.append(sid)
		self._write("DELETE FROM sessions WHERE id = ?", (sid,))


class ReseedOwnership(unittest.TestCase):
	def setUp(self):
		temp = tempfile.TemporaryDirectory(prefix="t3-seed-usage-")
		self.addCleanup(temp.cleanup)
		self.db = Path(temp.name) / "state.db"
		self.owned = Path(temp.name) / "demo" / "seed_usage_ids.json"
		self.owned.parent.mkdir()
		with closing(sqlite3.connect(self.db)) as conn, conn:
			conn.execute("CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT, model TEXT, cwd TEXT, title TEXT, title_source TEXT, started_at REAL, last_activity_at REAL, archived INTEGER DEFAULT 0)")
			conn.execute("CREATE TABLE session_model_usage(session_id TEXT, first_seen REAL, last_seen REAL)")
		ScratchSessionDB.opened, ScratchSessionDB.deleted = [], []
		for patcher in (patch.object(seed, "DB_PATH", self.db), patch.object(seed, "OWNED", self.owned), patch.object(seed, "SessionDB", ScratchSessionDB),
				patch.object(seed, "sqlite3", SimpleNamespace(connect=unsynced)), patch("builtins.print")):
			patcher.start()
			self.addCleanup(patcher.stop)

	def add(self, sid, model, title, cwd=f"{seed.W}/acme-shop", source="local"):
		with closing(sqlite3.connect(self.db)) as conn, conn:
			conn.execute("INSERT INTO sessions(id, source, model, cwd, title) VALUES (?, ?, ?, ?, ?)", (sid, source, model, cwd, title))

	def ids(self):
		with closing(sqlite3.connect(self.db)) as conn:
			return {row[0] for row in conn.execute("SELECT id FROM sessions")}

	def test_a_reseed_deletes_exactly_the_recorded_sessions(self):
		self.add("manual-on-seed-model", "gpt-5.6-sol", "My own checkout work")
		seed.main()
		first = set(json.loads(self.owned.read_text())["ids"])
		self.assertEqual(len(first), 78)
		self.assertEqual(self.ids(), first | {"manual-on-seed-model"})
		self.assertEqual(ScratchSessionDB.deleted, [])
		with patch.object(seed.time, "time", return_value=seed.time.time() + 5):
			seed.main()
		second = set(json.loads(self.owned.read_text())["ids"])
		self.assertEqual(set(ScratchSessionDB.deleted), first)
		self.assertFalse(first & second)
		self.assertEqual(self.ids(), second | {"manual-on-seed-model"})
		self.assertEqual(set(ScratchSessionDB.opened), {self.db})

	def test_sessions_from_before_the_record_are_recognised_by_every_seed_trait_together(self):
		self.add("local-earlier-seed", "claude-opus-5-5", "Follow-up: Upgrade Vite to 7")
		self.add("manual-on-seed-model", "gpt-5.6-sol", "My own checkout work")
		self.add("local-free-model", "free-model", "Upgrade Vite to 7")
		self.add("local-elsewhere", "gpt-5.6-sol", "Upgrade Vite to 7", cwd="/opt/data/workspace/scratch")
		self.add("desktop-seed-title", "gpt-5.6-sol", "Upgrade Vite to 7", source="desktop")
		seed.main()
		self.assertEqual(ScratchSessionDB.deleted, ["local-earlier-seed"])
		self.assertTrue({"manual-on-seed-model", "local-free-model", "local-elsewhere", "desktop-seed-title"} <= self.ids())


if __name__ == "__main__":
	unittest.main()
