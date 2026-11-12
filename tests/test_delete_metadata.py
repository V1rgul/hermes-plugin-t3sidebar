"""A verified deletion also drops the deleted sessions' organisation, Done marker and turn start, but keeps their delivery receipts."""

from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from test_backend import backend


NOW = 1800000000.25
BODY = {"request_id": "confirmed-delete", "expected_revision": 0, "expected_generation": 0}
VALUE = {"ok": True, "profile": "default", "session_id": "target", "request_id": BODY["request_id"], "operation": "delete",
	"deleted_ids": ["target", "child"], "already_absent": False, "verified_absent": True, "revision": 1, "execution_generation": 0}


class DeletedSessionMetadata(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="hermes-t3sidebar-delete-metadata-")
		self.addCleanup(self.temp.cleanup)
		self.path = Path(self.temp.name) / "plugin-data/state.sqlite3"
		app = FastAPI()
		app.include_router(backend.create_router(self.path, lambda: NOW, profile_reader=lambda: "default"))
		self.client = TestClient(app)
		self.addCleanup(self.client.close)
		native = patch.object(backend, "native_delete", new=AsyncMock(return_value=dict(VALUE)))
		native.start()
		self.addCleanup(native.stop)
		self.store = backend.HermesT3SidebarStore(self.path, lambda: NOW)
		self.ledger = backend.CompletionStore(self.path, lambda: NOW)

	def delete(self):
		response = self.client.post("/sessions/target/delete?profile=default", json=BODY)
		self.assertEqual(response.status_code, 200, response.text)
		self.assertEqual(response.json(), VALUE)

	def keys(self):
		state = self.store.state()
		return {part: sorted(state[part]) for part in ("sessions", "completions", "runs")}

	def test_only_the_verified_deleted_ids_lose_their_rows(self):
		for sid in ("target", "child", "other"):
			self.store.mutate(sid, backend.SessionAction(action="pin"))
			self.ledger.record(sid, f"{sid}-turn")
			self.ledger.begin_run(sid, f"{sid}-next", NOW - 10)
		self.delete()
		self.assertEqual(self.keys(), {"sessions": ["other"], "completions": ["other"], "runs": ["other"]})
		# The durable receipt is kept: a replayed end of the deleted session's turn cannot bring its Done back.
		self.assertFalse(self.ledger.record("target", "target-turn"))
		self.assertEqual(self.keys()["completions"], ["other"])

	def test_late_hooks_of_a_deleted_session_still_succeed(self):
		self.ledger.begin_run("target", "target-open", NOW - 10)
		self.delete()
		self.assertFalse(self.ledger.end_run("target-open"))
		self.assertTrue(self.ledger.record("target", "target-open", current_only=True))
		self.assertEqual(self.keys()["completions"], ["target"])

	def test_a_store_without_metadata_tables_gets_none(self):
		self.delete()
		self.assertFalse(self.path.exists())
		self.path.parent.mkdir(parents=True)
		with closing(sqlite3.connect(self.path)) as connection:
			connection.execute("CREATE TABLE unrelated (id INTEGER)")
			connection.commit()
		self.delete()
		with closing(sqlite3.connect(self.path)) as connection:
			tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
		self.assertEqual(tables & {"session_metadata", "session_completions", "completion_receipts", "session_runs"}, set())

	def test_failed_metadata_cleanup_keeps_the_verified_deletion_and_logs_only_the_failure_class(self):
		with self.assertLogs(level="WARNING") as logs, patch.object(backend.HermesT3SidebarStore, "forget", side_effect=sqlite3.OperationalError("locked: target child")):
			self.delete()
		self.assertEqual([record.getMessage() for record in logs.records], ["Metadata of deleted sessions was not cleared (OperationalError)"])


if __name__ == "__main__":
	unittest.main()
