"""The optimized fixture keeps real SQLite stores independent and never erases one."""

from contextlib import closing
from pathlib import Path
import tempfile
import unittest

from hermes_state import SessionDB
from native_fixture import native_fixture


class NativeFixtureTests(unittest.TestCase):
	def test_copies_keep_native_schema_and_independent_persistent_data(self):
		with tempfile.TemporaryDirectory(prefix="t3-native-fixture-test-") as directory:
			root = Path(directory)
			with closing(SessionDB(root / "reference.sqlite3")) as reference:
				assert reference._conn is not None
				expected = reference._conn.execute("SELECT name, sql FROM sqlite_master ORDER BY name").fetchall()
			with closing(native_fixture(root / "one.sqlite3")) as one:
				assert one._conn is not None
				self.assertEqual(one._conn.execute("SELECT name, sql FROM sqlite_master ORDER BY name").fetchall(), expected)
				one.create_session("only-one", "cli")
			with closing(native_fixture(root / "two.sqlite3")) as two:
				self.assertIsNone(two.get_session("only-one"))
				two.create_session("only-two", "cli")
			with closing(SessionDB(root / "one.sqlite3", read_only=True)) as reopened:
				self.assertIsNotNone(reopened.get_session("only-one"))
				self.assertIsNone(reopened.get_session("only-two"))

	def test_an_existing_path_is_rejected_without_changing_its_contents(self):
		with tempfile.TemporaryDirectory(prefix="t3-native-fixture-test-") as directory:
			path = Path(directory) / "existing.sqlite3"
			path.write_bytes(b"existing fixture must survive")
			with self.assertRaises(FileExistsError):
				native_fixture(path)
			self.assertEqual(path.read_bytes(), b"existing fixture must survive")
