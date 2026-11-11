"""After a verified native deletion, the deleted sessions' drafts are cleared off the event loop, and a failed clean-up is logged."""

import asyncio
import logging
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from test_backend import backend


BODY = {"request_id": "confirmed-delete", "expected_revision": 0, "expected_generation": 0}
VALUE = {"ok": True, "profile": "default", "session_id": "target", "request_id": BODY["request_id"], "operation": "delete",
	"deleted_ids": ["target", "child"], "already_absent": False, "verified_absent": True, "revision": 1, "execution_generation": 0}


class DeleteCleanupTests(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="hermes-t3sidebar-delete-cleanup-")
		self.addCleanup(self.temp.cleanup)
		app = FastAPI()
		app.include_router(backend.create_router(Path(self.temp.name) / "state.sqlite3", lambda: 1800000000.25, profile_reader=lambda: "default"))
		self.client = TestClient(app)
		self.addCleanup(self.client.close)
		native = patch.object(backend, "native_delete", new=AsyncMock(return_value=dict(VALUE)))
		native.start()
		self.addCleanup(native.stop)

	def delete(self):
		return self.client.post("/sessions/target/delete?profile=default", json=BODY)

	def test_draft_cleanup_runs_in_a_worker_thread_before_the_response(self):
		calls = []
		def record(store, ids):
			try:
				asyncio.get_running_loop()
				calls.append(("event-loop", list(ids)))
			except RuntimeError:
				calls.append(("worker", list(ids)))
		with patch.object(backend.session_drafts.DraftStore, "delete", autospec=True, side_effect=record):
			response = self.delete()
		self.assertEqual(response.status_code, 200, response.text)
		self.assertEqual(response.json(), VALUE)
		self.assertEqual(calls, [("worker", ["target", "child"])])

	def test_failed_draft_cleanup_keeps_the_verified_deletion_and_logs_only_the_failure_class(self):
		failure = sqlite3.OperationalError("database is locked: target child")
		with self.assertLogs(level="WARNING") as logs, patch.object(backend.session_drafts.DraftStore, "delete", side_effect=failure):
			response = self.delete()
		self.assertEqual(response.status_code, 200, response.text)
		self.assertEqual(response.json(), VALUE)
		self.assertEqual([(record.levelno, record.getMessage()) for record in logs.records],
			[(logging.WARNING, "Drafts of deleted sessions were not cleared (OperationalError)")])


if __name__ == "__main__":
	unittest.main()
