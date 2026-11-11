"""Project projection of cards and drafts degrades without Hermes's version-sensitive helpers."""

from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

import hermes_cli

from test_backend import backend


HOME = {"id": "__no_project__", "name": "Home", "icon": None, "color": None, "cwd": None, "is_home": True}


def project(pid, *folders):
	return SimpleNamespace(id=pid, name=f"Project {pid}", icon=None, color=None, folders=[SimpleNamespace(path=path) for path in folders])


class MissingProjectHelpers(unittest.TestCase):
	def setUp(self):
		# A core whose projects module lacks the helpers the plugin borrows.
		stub = ModuleType("hermes_cli.projects_db")
		for patcher in (patch.dict(sys.modules, {"hermes_cli.projects_db": stub}), patch.object(hermes_cli, "projects_db", stub, create=True)):
			patcher.start()
			self.addCleanup(patcher.stop)
		self.temp = tempfile.TemporaryDirectory(prefix="hermes-t3sidebar-projects-")
		self.addCleanup(self.temp.cleanup)
		self.root = Path(self.temp.name)
		(self.root / "projects.db").write_bytes(b"")

	def test_cards_fall_back_to_home_and_unregistered_folders(self):
		self.assertEqual(backend.card_project("", []), HOME)
		self.assertEqual(backend.card_project(None, []), HOME)
		self.assertEqual(backend.card_project(" /work/repo ", [project("p", "/work/repo")]),
			{"id": "/work/repo", "name": "repo", "icon": None, "color": None, "cwd": "/work/repo"})
		self.assertEqual(backend.card_projects(SimpleNamespace(db_path=self.root / "state.db")), [])

	def test_drafts_stay_listed_with_their_folder(self):
		db = SimpleNamespace(db_path=self.root / "state.db", close=lambda: None)
		drafts = [{"session_id": "a", "text": "kept", "cwd": "/work/repo"}, {"session_id": "b", "text": None, "cwd": "/work/repo"}]
		with patch.object(backend, "open_session_db", return_value=db):
			value = backend.native_drafts("default", drafts)
		self.assertEqual([(draft["session_id"], draft["project"]) for draft in value], [
			("a", {"id": "/work/repo", "name": "repo", "icon": None, "color": None, "cwd": "/work/repo"}), ("b", None)])


if __name__ == "__main__":
	unittest.main()
