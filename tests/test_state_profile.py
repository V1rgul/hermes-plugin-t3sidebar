"""/state checks the transport's profile assertion like every other listing route."""

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from test_backend import backend


class StateProfileTests(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="hermes-t3sidebar-state-profile-")
		self.addCleanup(self.temp.cleanup)
		app = FastAPI()
		app.include_router(backend.create_router(Path(self.temp.name) / "state.sqlite3", lambda: 1800000000.25, profile_reader=lambda: "workspace"))
		self.client = TestClient(app)
		self.addCleanup(self.client.close)

	def test_own_profile_or_no_assertion_reads_the_state(self):
		for query in ("", "?profile=workspace", "?profile=workspace&profile=workspace"):
			with self.subTest(query=query):
				response = self.client.get(f"/state{query}")
				self.assertEqual(response.status_code, 200, response.text)
				self.assertEqual(response.json(), {"version": 1, "sessions": {}, "completions": {}, "runs": {}})

	def test_foreign_mixed_or_unknown_parameters_are_rejected_before_any_read(self):
		with patch.object(backend.HermesT3SidebarStore, "state", side_effect=AssertionError("state read")):
			for query in ("profile=foreign", "profile=workspace&profile=foreign", "profile=foreign&profile=workspace", "home=/other", "profile=workspace&path=/other"):
				with self.subTest(query=query):
					response = self.client.get(f"/state?{query}")
					self.assertEqual(response.status_code, 422, response.text)


if __name__ == "__main__":
	unittest.main()
