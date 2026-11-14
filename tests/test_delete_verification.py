"""A cascade deletion's returned ids are each verified absent through one read of the native store."""

import asyncio
from contextlib import closing
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from hermes_state import SessionDB

from test_backend import backend
from native_fixture import native_fixture


BODY = SimpleNamespace(request_id="confirmed-delete", expected_revision=0, expected_generation=0)
IDS = ["target", "compressed-1", "compressed-2", "delegate-1"]


class DeleteVerificationTests(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="hermes-t3sidebar-delete-verify-")
		self.addCleanup(self.temp.cleanup)
		self.db_path = Path(self.temp.name) / "state.db"
		with closing(native_fixture(self.db_path)) as db:
			db.create_session("unrelated", "cli")
		self.opened = 0
		def open_db(profile, *, read_only=True):
			assert profile == "default" and read_only is True
			self.opened += 1
			return SessionDB(self.db_path, read_only=True)
		for name, value in (("open_session_db", open_db), ("native_control_guard", lambda *args: None)):
			started = patch.object(backend, name, value)
			started.start()
			self.addCleanup(started.stop)

	def delete(self, deleted_ids):
		receipt = {"ok": True, "session_id": "target", "operation": "delete", "revision": 1, "execution_generation": 0, "deleted_ids": deleted_ids}
		with patch("hermes_cli.web_routers.sessions.delete_session_endpoint", new=AsyncMock(return_value=receipt)):
			return asyncio.run(backend.native_delete(SimpleNamespace(), "default", "target", BODY))

	def test_every_returned_id_is_verified_through_one_store_read(self):
		value = self.delete(IDS)
		self.assertEqual((value["deleted_ids"], value["verified_absent"]), (IDS, True))
		self.assertEqual(self.opened, 1)

	def test_any_returned_id_still_present_fails_verification(self):
		for survivor in IDS:
			with self.subTest(survivor=survivor):
				with closing(SessionDB(self.db_path)) as db:
					db.create_session(survivor, "cli")
				with self.assertRaises(HTTPException) as raised:
					self.delete(IDS)
				self.assertEqual((raised.exception.status_code, raised.exception.detail), (503, "native_delete_verification_failed"))
				with closing(SessionDB(self.db_path)) as db:
					db.delete_session(survivor)


if __name__ == "__main__":
	unittest.main()
