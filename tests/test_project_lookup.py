"""Project projection of cards and drafts: degrades without Hermes's version-sensitive helpers, and owns descendants with either separator."""

import ntpath
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

import hermes_cli
from hermes_cli import projects_db

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



class WindowsDescendants(unittest.TestCase):
	def setUp(self):
		# Hermes on Windows: its normalizer yields backslash paths and os.sep is a backslash.
		normalize = lambda path: ntpath.abspath(str(path).strip()).rstrip("/\\") or path
		for patcher in (patch.object(projects_db, "_normalize_path", normalize), patch.object(backend, "os", SimpleNamespace(sep="\\"))):
			patcher.start()
			self.addCleanup(patcher.stop)

	def test_backslash_descendant_belongs_to_the_longest_owning_folder(self):
		projects = [project("outer", "C:\\work\\repo", "D:\\second"), project("inner", "C:\\work\\repo\\nested")]
		cases = {
			"C:\\work\\repo": ("outer", "C:\\work\\repo"),
			"C:\\work\\repo\\src": ("outer", "C:\\work\\repo"),
			"C:\\work\\repo\\nested\\deep": ("inner", "C:\\work\\repo\\nested"),
			"D:\\second\\x": ("outer", "D:\\second"),
			"C:\\work\\repository": ("C:\\work\\repository", "C:\\work\\repository"),
		}
		for cwd, expected in cases.items():
			with self.subTest(cwd=cwd):
				card = backend.card_project(cwd, projects)
				self.assertEqual((card["id"], card["cwd"]), expected)

if __name__ == "__main__":
	unittest.main()
