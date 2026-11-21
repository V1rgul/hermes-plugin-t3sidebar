"""Fresh file-backed native stores without repeating Hermes's empty-schema migrations."""

from contextlib import ExitStack, closing
from functools import cache
from pathlib import Path
import sqlite3
import tempfile


@cache
def _empty_schema():
	from persistence_assembly import open_persistence, profile_scope

	# Close the native writer before copying: the image must include any journal/checkpoint work, not a live connection or test data.
	with tempfile.TemporaryDirectory(prefix="t3-native-schema-") as directory:
		with open_persistence(profile_scope(home=Path(directory)), eager=True):
			pass
		path = Path(directory) / "state.db"
		# The store runs in WAL mode: fold the log into the main file so its bytes alone are the whole empty store.
		with closing(sqlite3.connect(path)) as connection:
			connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
		return path.read_bytes()


class NativeWriter:
	"""A test-only writable handle on one profile's store, through Hermes's storage interface.

	The legacy ``SessionDB`` names the tests use map to the store's repositories, as Hermes's ``hermes_state`` stand-in maps the ones it carries. ``_conn`` is a separate writable SQLite connection to the same file in autocommit mode, as the retired ``SessionDB._conn`` was, for the raw rows a test plants that no repository verb writes.
	"""

	def __init__(self, path):
		from persistence_assembly import open_persistence, profile_scope

		self.db_path = Path(path)
		self._stack = ExitStack()
		try:
			self.store = self._stack.enter_context(open_persistence(profile_scope(home=self.db_path.parent), eager=True))
			self._conn = self._stack.enter_context(closing(sqlite3.connect(self.db_path, isolation_level=None)))
		except BaseException:
			self._stack.close()
			raise

	def close(self):
		self._stack.close()

	def __enter__(self):
		return self

	def __exit__(self, *exc):
		self.close()

	def create_session(self, session_id, source, **kwargs):
		from persistence.conversation.sessions import NewSession

		return self.store.sessions.create(NewSession(session_id=session_id, source=source, **kwargs))

	def end_session(self, session_id, end_reason):
		self.store.sessions.end(session_id, end_reason)

	def get_session(self, session_id):
		record = self.store.sessions.get(session_id)
		return None if record is None else record.as_session_row()

	def set_session_title(self, session_id, title):
		return self.store.sessions.set_title(session_id, title)

	def set_session_archived(self, session_id, archived, *, notify=True):
		return self.store.sessions.set_archived(session_id, archived, notify=notify).changed

	def set_session_hidden(self, session_id, hidden):
		return self.store.sessions.set_hidden(session_id, hidden)

	def set_session_pinned(self, session_id, pinned):
		return self.store.sessions.set_pinned(session_id, pinned)

	def set_session_read(self, session_id, read=True):
		return self.store.sessions.set_read(session_id, read)

	def update_session_cwd(self, session_id, cwd, git_branch=None, git_repo_root=None, *, replace_git_meta=False):
		return self.store.sessions.update_cwd(session_id, cwd, git_branch, git_repo_root, replace_git_meta=replace_git_meta)

	def delete_session(self, session_id):
		"""Native deletion, which retires every removed id; the plugin hooks and file cleanup Hermes runs afterwards are not part of the store."""
		from gateway.session_ingress_media import native_inputs_root

		return bool(self.store.sessions.delete(session_id, media_root=str(native_inputs_root())))

	def append_message(self, session_id, role, content=None, **fields):
		from persistence.conversation.messages import NewMessage

		return self.store.messages.append(session_id, NewMessage.from_live({"role": role, "content": content, **fields}))

	def update_token_counts(self, session_id, *, input_tokens=0, output_tokens=0, cache_read_tokens=0, cache_write_tokens=0, reasoning_tokens=0, model=None, billing_provider=None, absolute=False):
		"""Account usage as Hermes core does, with one queued delta applied before returning. ``absolute`` sets the counters, as the retired gateway path did: the store accounts deltas only, so the delta is the difference from the stored counters, which must not decrease."""
		from persistence.conversation.usage import BillingRoute, TokenCounts, UsageDelta

		counts = {"input_tokens": input_tokens, "output_tokens": output_tokens, "cache_read_tokens": cache_read_tokens, "cache_write_tokens": cache_write_tokens, "reasoning_tokens": reasoning_tokens}
		if absolute:
			stored = self.get_session(session_id) or {}
			counts = {name: value - int(stored.get(name) or 0) for name, value in counts.items()}
		route = None if model is None and billing_provider is None else BillingRoute(model=model, billing_provider=billing_provider)
		self.store.usage.queue_usage(session_id, UsageDelta(tokens=TokenCounts(**counts), route=route))
		if not self.store.usage.flush_usage():
			raise TimeoutError("queued usage was not applied")

	def record_auxiliary_usage(self, session_id, task, *, model=None, billing_provider=None, input_tokens=0, output_tokens=0):
		from persistence.conversation.usage import TokenCounts

		self.store.usage.record_auxiliary_usage(session_id, task, model=model, billing_provider=billing_provider, tokens=TokenCounts(input_tokens=input_tokens, output_tokens=output_tokens))

	def set_meta(self, key, value):
		self.store.state_meta.set(key, value)

	def try_acquire_compression_lock(self, session_id, holder):
		return self.store.coordination.try_acquire_compression_lock(session_id=session_id, holder=holder)

	def try_acquire_session_turn_lease(self, session_id, holder):
		return self.store.coordination.try_acquire_turn_lease(session_id=session_id, holder=holder)


def native_fixture(path):
	"""Open an independent native writer on a new ``state.db`` path, with normal SQLite durability and locking."""
	path = Path(path)
	# The storage interface opens a profile folder's state.db; any other name would silently open a different file.
	if path.name != "state.db":
		raise ValueError(f"a native store is a profile folder's state.db, not {path.name}")
	path.parent.mkdir(parents=True, exist_ok=True)
	schema = _empty_schema()
	# Reusing a path is a fixture bug, not permission to erase an existing store.
	with path.open("xb") as destination:
		destination.write(schema)
	return NativeWriter(path)
