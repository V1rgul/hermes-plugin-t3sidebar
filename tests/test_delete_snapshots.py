"""Exact read-only delete snapshots and canonical deletion against scratch native storage."""
from contextlib import closing
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from persistence.authority.runtime import Delete

from test_backend import backend
from native_fixture import NativeWriter, native_fixture

NativeStore = backend.native_store.NativeStore


class DeleteSnapshots(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="t3-delete-snapshot-")
		self.addCleanup(self.temp.cleanup)
		self.path = Path(self.temp.name)
		self.db_path = self.path / "state.db"
		with closing(native_fixture(self.db_path)) as db:
			db.create_session("empty", "desktop", system_prompt="PRIVATE TEST PROMPT")
			db.create_session("empty-longer", "desktop")
		self.reader = patch.object(backend, "open_session_db", side_effect=self.open_native)
		self.reader.start()
		self.addCleanup(self.reader.stop)
		app = FastAPI()
		app.include_router(backend.create_router(self.path / "organization.sqlite3", profile_reader=lambda: "exact-profile"))
		self.client = TestClient(app)
		self.addCleanup(self.client.close)

	def open_native(self, profile, *, read_only):
		self.assertEqual(profile, "exact-profile")
		self.assertTrue(read_only)
		return NativeStore(self.db_path)

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
		with closing(NativeWriter(self.db_path)) as db:
			epoch = db.store.runtime.begin_epoch(instance_id="scratch-owner")
			before = self.client.get("/sessions/empty/snapshot").json()
			def delete():
				# The scratch rows carry no owner stamp, so no owner rule (host data Hermes builds from its config) is read.
				return db.store.runtime.mutate(epoch, principal_id="scratch-human", session_id="empty", request_id="confirmed-delete", expected_revision=before["runtime_revision"], expected_generation=before["runtime_generation"], command=Delete(), media_root=str(self.path / "media"), owner=None)
			first = delete()
			replay = delete()
			# Only the first commit deleted anything: Hermes runs the deletion hooks for ``gone`` alone, so a replay cannot fire them twice.
			self.assertFalse(first.replayed)
			self.assertEqual(first.gone.session_ids, ("empty",))
			self.assertTrue(replay.replayed)
			self.assertIsNone(replay.gone)
			receipt = first.result
			self.assertEqual(receipt, replay.result)
			self.assertEqual(receipt["session_id"], "empty")
			self.assertEqual(receipt["operation"], "delete")
			self.assertEqual(receipt["revision"], before["runtime_revision"] + 1)
			self.assertEqual(receipt["execution_generation"], before["runtime_generation"])
			self.assertIn("empty", receipt["deleted_ids"])
			for sid in receipt["deleted_ids"]:
				self.assertEqual(self.client.get(f"/sessions/{sid}/snapshot").json()["exists"], False)
			self.assertEqual(self.client.get("/sessions/empty-longer/snapshot").json()["exists"], True)
