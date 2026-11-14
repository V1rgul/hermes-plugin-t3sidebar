"""Fresh file-backed native stores without repeating Hermes's empty-schema migrations."""

from contextlib import closing
from functools import cache
from pathlib import Path
import tempfile

@cache
def _empty_schema():
	from hermes_state import SessionDB

	# Close the native writer before copying: the image must include any journal/checkpoint work, not a live connection or test data.
	with tempfile.TemporaryDirectory(prefix="t3-native-schema-") as directory:
		path = Path(directory) / "native.sqlite3"
		with closing(SessionDB(path)):
			pass
		return path.read_bytes()


def native_fixture(path):
	"""Open an independent native writer on a new path, with normal SQLite durability and locking."""
	from hermes_state import SessionDB

	path = Path(path)
	path.parent.mkdir(parents=True, exist_ok=True)
	schema = _empty_schema()
	# Reusing a path is a fixture bug, not permission to erase an existing store.
	with path.open("xb") as destination:
		destination.write(schema)
	return SessionDB(path)
