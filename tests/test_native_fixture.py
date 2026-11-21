"""The optimized fixture keeps real SQLite stores independent and never erases one."""

from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest

from native_fixture import native_fixture


def schema(connection):
	return connection.execute("SELECT name, sql FROM sqlite_master ORDER BY name").fetchall()


class NativeFixtureTests(unittest.TestCase):
	def test_copies_keep_native_schema_and_independent_persistent_data(self):
		from persistence_assembly import open_persistence, open_persistence_reader, profile_scope

		with tempfile.TemporaryDirectory(prefix="t3-native-fixture-test-") as directory:
			root = Path(directory)
			# Each store is its profile folder's state.db, so every store gets its own folder.
			with open_persistence(profile_scope(home=root / "reference"), eager=True):
				pass
			with closing(sqlite3.connect(root / "reference/state.db")) as reference:
				expected = schema(reference)
			with closing(native_fixture(root / "one/state.db")) as one:
				self.assertEqual(schema(one._conn), expected)
				one.create_session("only-one", "cli")
			with closing(native_fixture(root / "two/state.db")) as two:
				self.assertIsNone(two.get_session("only-one"))
				two.create_session("only-two", "cli")
			with open_persistence_reader(root / "one/state.db") as reopened:
				self.assertIsNotNone(reopened.sessions.get("only-one"))
				self.assertIsNone(reopened.sessions.get("only-two"))

	def test_an_existing_path_is_rejected_without_changing_its_contents(self):
		with tempfile.TemporaryDirectory(prefix="t3-native-fixture-test-") as directory:
			path = Path(directory) / "state.db"
			path.write_bytes(b"existing fixture must survive")
			with self.assertRaises(FileExistsError):
				native_fixture(path)
			self.assertEqual(path.read_bytes(), b"existing fixture must survive")
