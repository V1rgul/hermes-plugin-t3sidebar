"""Exact read-only delete snapshots and canonical deletion against scratch native storage."""
from contextlib import closing
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from hermes_state import SessionDB
import hermes_state_runtime as runtime

from test_backend import backend


class DeleteSnapshots(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="t3-delete-snapshot-")
		self.addCleanup(self.temp.cleanup)
		self.path = Path(self.temp.name)
		self.db_path = self.path / "native.sqlite3"
		with closing(SessionDB(self.db_path)) as db:
			db.create_session("empty", "desktop", system_prompt="PRIVATE TEST PROMPT")
			db.create_session("empty-longer", "desktop")
		self.reader = patch("hermes_cli.web_server_sessions._open_session_db_for_profile", side_effect=self.open_native)
		self.reader.start()
		self.addCleanup(self.reader.stop)
		app = FastAPI()
		app.include_router(backend.create_router(self.path / "organization.sqlite3", profile_reader=lambda: "exact-profile"))
		self.client = TestClient(app)
		self.addCleanup(self.client.close)

	def open_native(self, profile, *, read_only):
		self.assertEqual(profile, "exact-profile")
		self.assertTrue(read_only)
		return SessionDB(self.db_path, read_only=True)

	def test_exact_snapshot_is_allowlisted_read_only_and_distinguishes_absent(self):
		before = self.db_path.read_bytes()
		response = self.client.get("/sessions/empty/snapshot?profile=exact-profile&profile=exact-profile")
		self.assertEqual(response.status_code, 200)
		self.assertEqual(response.headers["cache-control"], "no-store")
		self.assertEqual(response.json(), {"profile": "exact-profile", "session_id": "empty", "exists": True, "runtime_revision": 0, "runtime_generation": 0})
		missing = self.client.get("/sessions/emp/snapshot").json()
		self.assertEqual(missing, {"profile": "exact-profile", "session_id": "emp", "exists": False, "runtime_revision": 0, "runtime_generation": None})
		self.assertEqual(self.db_path.read_bytes(), before)

	def test_snapshot_rejects_foreign_mixed_and_unknown_profile_selectors(self):
		for query in ("profile=foreign", "profile=", "profile=exact-profile&profile=foreign", "profile=exact-profile&unknown=1"):
			with self.subTest(query=query):
				self.assertEqual(self.client.get("/sessions/empty/snapshot?" + query).status_code, 422)

	def test_canonical_delete_receipt_fences_replay_and_exact_absent_readback(self):
		with closing(SessionDB(self.db_path)) as db:
			epoch = runtime.begin_runtime_epoch(db, instance_id="scratch-owner")
			before = self.client.get("/sessions/empty/snapshot").json()
			def delete():
				return runtime.mutate_runtime_session(db, epoch=epoch, principal_id="scratch-human", session_id="empty", request_id="confirmed-delete", expected_revision=before["runtime_revision"], expected_generation=before["runtime_generation"], operation="delete", payload={})
			# Never load this profile's real lifecycle plugins from a scratch DB.
			with patch("hermes_state_common.emit_session_deleted") as emit:
				receipt = delete()
				replay = delete()
			self.assertEqual(emit.call_count, 1)
			self.assertEqual(receipt, replay)
			self.assertEqual(receipt["session_id"], "empty")
			self.assertEqual(receipt["operation"], "delete")
			self.assertEqual(receipt["revision"], before["runtime_revision"] + 1)
			self.assertEqual(receipt["execution_generation"], before["runtime_generation"])
			self.assertIn("empty", receipt["deleted_ids"])
			for sid in receipt["deleted_ids"]:
				self.assertEqual(self.client.get(f"/sessions/{sid}/snapshot").json()["exists"], False)
			self.assertEqual(self.client.get("/sessions/empty-longer/snapshot").json()["exists"], True)
