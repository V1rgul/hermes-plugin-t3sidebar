"""A manual compaction that ends while a native turn runs is forgotten, so the next one is timed afresh."""

from typing import Any
import unittest
from unittest.mock import patch

from test_backend import backend
# Only the module object: importing its TestCase class here would run those tests twice under discovery.
import test_standalone_runtime as fixture


class CompactionBookkeeping(unittest.TestCase):
	registry: Any
	setUp = fixture.StandaloneRuntime.setUp
	start_patch = fixture.StandaloneRuntime.start_patch
	session = fixture.StandaloneRuntime.session
	open_db = fixture.StandaloneRuntime.open_db
	session_db = fixture.StandaloneRuntime.session_db
	runtime_row = fixture.StandaloneRuntime.runtime_row

	def test_compaction_cleared_under_a_native_turn_does_not_lend_its_start_to_the_next_one(self):
		session = self.registry["runtime-a"]
		self.start_patch(patch.dict(backend._compression_seen, clear=True))
		session["_manual_compress_active"] = True
		with patch.object(backend.time, "time", return_value=5000.0):
			self.assertEqual(self.runtime_row()["turn_started_at"], 5000.0)
		session["inflight_turn"] = {"started_at": 4000.0}
		with patch.object(backend.time, "time", return_value=5030.0):
			self.assertEqual(self.runtime_row()["turn_started_at"], 4000.0)
			session.pop("_manual_compress_active")
			self.assertEqual(self.runtime_row()["turn_started_at"], 4000.0)
		session["inflight_turn"] = None
		session["_manual_compress_active"] = True
		with patch.object(backend.time, "time", return_value=6000.0):
			self.assertEqual(self.runtime_row()["turn_started_at"], 6000.0)


if __name__ == "__main__":
	unittest.main()
