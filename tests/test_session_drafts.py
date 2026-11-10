"""Composer drafts in the plugin's own store, through the one sync route Desktop calls.

Every test uses a scratch plugin store and an injected clock; Hermes's session store is never opened except where a fixture stands in for it.
"""

from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from test_backend import backend


PREFIX = "/api/plugins/hermes-t3sidebar"
SLOT = backend.session_drafts.SYNC_SLOT_SECONDS


class DraftSync(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="t3-drafts-")
		self.addCleanup(self.temp.cleanup)
		self.path = Path(self.temp.name) / "plugin-data/hermes-t3sidebar/state.sqlite3"
		self.now = 1800000000.0
		# Without a readable Hermes store, drafts still sync, with a project derived from their folder alone.
		opener = patch.object(backend, "open_session_db", side_effect=RuntimeError("no session store in this fixture"))
		opener.start()
		self.addCleanup(opener.stop)
		app = FastAPI()
		app.include_router(backend.create_router(self.path, lambda: self.now, profile_reader=lambda: "fixture"), prefix=PREFIX)
		self.client = TestClient(app)
		self.addCleanup(self.client.close)

	def sync(self, since=0, changes=(), sent_at=None):
		# A client whose clock runs a day ahead of the server: only the distance between edited_at and sent_at matters.
		sent_at = self.now + 86400 if sent_at is None else sent_at
		body = {"since": since, "sent_at": sent_at, "changes": [{"edited_at": sent_at, **change} for change in changes]}
		response = self.client.post(f"{PREFIX}/drafts/sync", json=body)
		self.assertEqual(response.status_code, 200, response.text)
		self.assertEqual(response.headers["cache-control"], "no-store")
		value = response.json()
		self.assertEqual(value["profile"], "fixture")
		return value

	@staticmethod
	def texts(value):
		return {draft["session_id"]: draft["text"] for draft in value["drafts"]}

	def test_polling_without_changes_creates_nothing(self):
		self.assertEqual(self.sync(), {"profile": "fixture", "cursor": 0, "reset": True, "drafts": []})
		self.assertEqual(self.sync(since=4)["reset"], True)
		self.assertFalse(self.path.exists())

	def test_changes_go_up_and_only_later_changes_come_back(self):
		first = self.sync(changes=[{"session_id": "a", "text": "Fix the pump\n", "cwd": "/work/robot"}])
		self.assertEqual((first["cursor"], first["reset"]), (1, True))
		(draft,) = first["drafts"]
		self.assertEqual((draft["text"], draft["cwd"], draft["seq"], draft["edited_at"]), ("Fix the pump\n", "/work/robot", 1, self.now))
		self.assertEqual(draft["project"]["name"], "robot")
		# Another client's first sync: its own change comes back with the first client's; later syncs carry only what changed after their cursor.
		other = self.sync(changes=[{"session_id": "b", "text": "Other"}])
		self.assertEqual(self.texts(other), {"a": "Fix the pump\n", "b": "Other"})
		self.assertEqual(self.texts(self.sync(since=first["cursor"])), {"b": "Other"})
		quiet = self.sync(since=other["cursor"])
		self.assertEqual((quiet["cursor"], quiet["reset"], quiet["drafts"]), (2, False, []))

	def test_deletion_reaches_other_clients_as_a_marker(self):
		cursor = self.sync(changes=[{"session_id": "a", "text": "x", "cwd": "/w"}])["cursor"]
		self.sync(since=cursor, changes=[{"session_id": "a", "text": " \n"}])
		update = self.sync(since=cursor)
		self.assertEqual(self.texts(update), {"a": None})
		self.assertIsNone(update["drafts"][0]["project"])
		# A fresh client is not told about drafts that no longer exist.
		self.assertEqual(self.sync()["drafts"], [])

	def test_the_most_recent_edit_wins_by_its_age_capped_to_one_slot(self):
		self.sync(changes=[{"session_id": "a", "text": "edited 5 s ago", "edited_at": 995.0}], sent_at=1000.0)
		# Arrives later but was typed 20 s before sending: older, so it loses, and the current text comes back.
		lost = self.sync(changes=[{"session_id": "a", "text": "edited 20 s ago", "edited_at": 50.0}], sent_at=70.0)
		self.assertEqual(self.texts(lost), {"a": "edited 5 s ago"})
		self.now += 3
		self.sync(changes=[{"session_id": "a", "text": "just now"}])
		self.assertEqual(self.texts(self.sync()), {"a": "just now"})
		# An age beyond one slot (a skewed or long-offline clock) counts as the start of the slot.
		self.now += SLOT + 1
		self.sync(changes=[{"session_id": "a", "text": "claims a week", "edited_at": 0.0}], sent_at=7 * 86400.0)
		latest = self.sync()["drafts"][0]
		self.assertEqual((latest["text"], latest["edited_at"]), ("claims a week", self.now - SLOT))

	def test_a_missing_folder_keeps_the_stored_one(self):
		self.sync(changes=[{"session_id": "a", "text": "one", "cwd": "/work/robot"}])
		self.sync(changes=[{"session_id": "a", "text": "two"}])
		self.assertEqual(self.sync()["drafts"][0]["cwd"], "/work/robot")

	def test_a_cursor_older_than_purged_markers_gets_a_full_snapshot(self):
		self.sync(changes=[{"session_id": "gone", "text": "x"}, {"session_id": "kept", "text": "y"}])
		cursor = self.sync(changes=[{"session_id": "gone", "text": ""}])["cursor"]
		self.now += backend.session_drafts.MARKER_DAYS * 86400 + 1
		value = self.sync(since=1)
		self.assertEqual((value["reset"], self.texts(value)), (True, {"kept": "y"}))
		self.assertEqual(self.sync(since=cursor)["reset"], False)
		with closing(sqlite3.connect(self.path)) as connection:
			self.assertEqual(connection.execute("SELECT session_id FROM session_drafts").fetchall(), [("kept",)])

	def test_invalid_requests_are_refused_without_writing(self):
		for body in ({"since": 0, "sent_at": 1, "extra": True}, {"since": -1, "sent_at": 1}, {"since": "0", "sent_at": 1},
			{"since": 0, "sent_at": 1, "changes": [{"session_id": "../x", "text": "x", "edited_at": 1}]},
			{"since": 0, "sent_at": 1, "changes": [{"session_id": "a", "text": 7, "edited_at": 1}]},
			{"since": 0, "sent_at": 1, "changes": [{"session_id": "a", "text": "x" * (backend.session_drafts.MAX_TEXT_LENGTH + 1), "edited_at": 1}]}):
			self.assertEqual(self.client.post(f"{PREFIX}/drafts/sync", json=body).status_code, 422, body)
		self.assertEqual(self.client.post(f"{PREFIX}/drafts/sync?profile=another", json={"since": 0, "sent_at": 1}).status_code, 422)
		self.assertFalse(self.path.exists())

	def test_projects_come_from_hermes_catalog_when_readable(self):
		catalog = [SimpleNamespace(id="p1", name="Robot", icon="tools", color="#f60", folders=[SimpleNamespace(path="/work/robot")])]
		db = SimpleNamespace(close=lambda: None)
		with patch.object(backend, "open_session_db", return_value=db), patch.object(backend, "card_projects", return_value=catalog):
			project = self.sync(changes=[{"session_id": "a", "text": "x", "cwd": "/work/robot/firmware"}])["drafts"][0]["project"]
		self.assertEqual((project["id"], project["name"], project["cwd"]), ("p1", "Robot", "/work/robot"))

	def test_deleting_a_session_marks_its_drafts_deleted(self):
		cursor = self.sync(changes=[{"session_id": sid, "text": sid} for sid in ("root", "tip", "other")])["cursor"]
		receipt = {"ok": True, "profile": "fixture", "session_id": "root", "deleted_ids": ["root", "tip"]}

		async def deleted(request, profile, sid, body):
			return receipt

		with patch.object(backend, "native_delete", side_effect=deleted):
			response = self.client.post(f"{PREFIX}/sessions/root/delete", json={"request_id": "r", "expected_revision": 0, "expected_generation": 0})
		self.assertEqual(response.status_code, 200, response.text)
		self.assertEqual(self.texts(self.sync(since=cursor)), {"root": None, "tip": None})

	def test_the_store_shares_the_plugin_file_without_touching_other_tables(self):
		with patch.object(backend, "native_archive", side_effect=lambda profile, sid: {"id": sid, "archived": False}):
			pinned = self.client.post(f"{PREFIX}/sessions/kept", json={"action": "pin"})
		self.assertEqual(pinned.status_code, 200, pinned.text)
		self.sync(changes=[{"session_id": "kept", "text": "x"}])
		with closing(sqlite3.connect(self.path)) as connection:
			tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
			pinned = connection.execute("SELECT pinned FROM session_metadata WHERE session_id = 'kept'").fetchone()
		self.assertLessEqual({"session_drafts", "session_drafts_sync", "session_metadata"}, tables)
		self.assertEqual(pinned, (1,))


if __name__ == "__main__":
	unittest.main()
