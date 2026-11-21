"""A profile's native session store, read through Hermes's public storage interface.

Hermes 0.23.3 removed the legacy SessionDB internals (its private connection and helpers such as get_compression_lineage); its ``hermes_state`` stand-in only forwards a few listed names until v0.27. Native verbs go through ``persistence_assembly.open_persistence_reader``, which never creates, migrates or repairs a store. The columns and joins the interface does not project (token counters, usage rows, delegate trees, message counts) are read through one explicitly read-only SQLite connection owned by this object.
"""
from contextlib import ExitStack, closing
from pathlib import Path
import sqlite3


class NativeStore:
	"""One store file, read-only. Close it once; ``with`` closes it too."""

	def __init__(self, path):
		from persistence_assembly import open_persistence_reader

		self.db_path = Path(path)
		self._stack = ExitStack()
		try:
			self.store = self._stack.enter_context(open_persistence_reader(self.db_path))
		except BaseException:
			self._stack.close()
			raise
		self._connection = None

	@property
	def connection(self):
		"""This object's own read-only SQLite connection, opened on first use; its default row factory is tuples."""
		if self._connection is None:
			self._connection = self._stack.enter_context(closing(sqlite3.connect(self.db_path.as_uri() + "?mode=ro", uri=True)))
		return self._connection

	def read_snapshot(self):
		"""Native reads made inside the block see one generation of the store; ``pinned`` on the yielded check says whether the backend gave one read transaction."""
		return self.store.messages.read_snapshot()

	def get_session(self, session_id):
		"""The stored row of an exact id as the legacy dict, or None."""
		record = self.store.sessions.get(session_id)
		return None if record is None else record.as_session_row()

	def list_sessions_rich(self, *, limit, offset=0, id_query=None, include_archived=False, archived_only=False, include_hidden=False, exclude_sources=()):
		"""Native rich listing, newest activity first, with compact rows and compression tips projected onto their roots, as the retired ``SessionDB.list_sessions_rich`` returned it. ``id_query`` is a substring match."""
		from persistence.conversation.sessions import SessionOrder, SessionQuery, SessionWindow

		query = SessionQuery(exclude_sources=tuple(exclude_sources), order=SessionOrder.LAST_ACTIVE,
			include_archived=include_archived, archived_only=archived_only, id_query=id_query, include_hidden=include_hidden)
		entries = self.store.sessions.list_sessions(query, SessionWindow(limit=limit, offset=offset), compact_rows=True)
		return [entry.as_list_row() for entry in entries]

	def compression_lineage(self, session_id):
		"""The compression lineage holding the session, root first; empty for an unknown id."""
		return list(self.store.lineage.lineage(session_id))

	def retired_session(self, session_id):
		"""Whether native deletion retired this id."""
		return self.store.runtime.retired_session(session_id)

	def close(self):
		self._stack.close()

	def __enter__(self):
		return self

	def __exit__(self, *exc):
		self.close()
