"""Content-free native turn observers; no Desktop, gateway, or HTTP dependency.

Only the ordinary Agent runtime currently emits both supported hooks. In particular codex_app_server bypasses on_session_end: do not infer its success from usage, child-stop events, or persisted assistant messages.
"""

from collections import OrderedDict
from contextlib import closing
from dataclasses import dataclass
import logging
from pathlib import Path
import sqlite3
from threading import RLock
import time

from .completion_state import CompletionStore, validate_session_id


log = logging.getLogger(__name__)
# Native excludes these from human listings; also reject explicit worker hooks.
NON_HUMAN = frozenset({"cron", "subagent", "delegate", "internal", "unknown", "kanban", "tool", "oneshot"})
TERMINAL_DELEGATIONS = frozenset({"completed", "success", "error", "failed", "interrupted", "cancelled", "canceled"})


def _identifier(value):
	return validate_session_id(value)


def _human(value):
	return isinstance(value, str) and bool(value.strip()) and value.strip().lower() not in NON_HUMAN


@dataclass(frozen=True)
class NativeSnapshot:
	root: str
	aliases: frozenset[str]
	delegations: frozenset[str]
	live: bool


def native_snapshot(home, session_id, *, dispatched_before=None):
	"""Resolve an exact native rich-list alias and read only its owned IDs/states.

	Parentage alone is not compression: native projection distinguishes real compression continuations from /branch, reset, and delegate forks. Never initialize/migrate state.db or attach to a global session/process registry.
	"""
	from hermes_state import SessionDB
	from hermes_state_sessions import INTERNAL_LISTING_SOURCES

	path = home / "state.db"
	if path.resolve().parent != home or not path.is_file():
		return None
	# Exact metadata-only proof; get_session would also hydrate stored prompts.
	with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=1)) as connection:
		record = connection.execute("SELECT id, source FROM sessions WHERE id = ?", (session_id,)).fetchone()
	if not record or record[0] != session_id or not _human(record[1]):
		return None
	db = SessionDB(db_path=path, read_only=True)
	try:
		# id_query itself is substring search, so require an exact projected alias.
		offset = 0
		match = None
		while True:
			rows = db.list_sessions_rich(
				id_query=session_id, limit=100, offset=offset, compact_rows=True,
				order_by_last_active=True, include_archived=True, include_hidden=True,
				exclude_sources=[*INTERNAL_LISTING_SOURCES, "cron", "subagent", "internal"],
			)
			for row in rows:
				aliases = {value for value in (row["id"], row.get("_lineage_root_id"),
						   *(row.get("_lineage_ids") or [])) if value}
				if session_id in aliases:
					if match is not None:
						return None  # ambiguous native projection is not proof
					root = _identifier(row.get("_lineage_root_id") or row["id"])
					match = (root, frozenset(_identifier(value) for value in aliases))
			if len(rows) < 100:
				break
			offset += len(rows)
		if match is None:
			return None
		root, aliases = match
	finally:
		db.close()

	# A separate explicitly read-only connection avoids private SessionDB state.
	# Durable running also covers the native in-memory 'stalling' phase.
	# Unknown states remain live conservatively; do not inspect task/result/event JSON.
	ids = sorted(aliases)
	placeholders = ",".join("?" for _ in ids)
	with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=1)) as connection:
		rows = connection.execute(
			f"SELECT delegation_id, state, dispatched_at FROM async_delegations WHERE "
			f"parent_session_id IN ({placeholders}) OR origin_session_id IN ({placeholders}) "
			f"OR origin_ui_session_id IN ({placeholders})", ids * 3,
		).fetchall()
	# A timed-out begin worker may finish after tools have already dispatched.
	# Its baseline must not absorb children created since this hook began.
	delegations = frozenset(_identifier(row[0]) for row in rows
		if dispatched_before is None or row[2] < dispatched_before)
	return NativeSnapshot(root, aliases, delegations, any(row[1] not in TERMINAL_DELEGATIONS for row in rows))


class CompletionObserver:
	"""Profile-bound observer with bounded, ephemeral, ID-only turn receipts.

	pre_llm_call exposes the real task_id and turn_id in the native contract. Missing/evicted/failed begin observations skip completion rather than guess whether already-finished children were dispatched during that turn.
	"""

	def __init__(self, home, *, clock=time.monotonic):
		self.home = Path(home).resolve()
		self.store = CompletionStore(self.home / "plugin-data/hermes-t3sidebar/state.sqlite3")
		self.clock = clock
		self._lock = RLock()
		self._receipts = OrderedDict()
		self._closed = False
		self._ttl = 24 * 60 * 60
		self._capacity = 4096

	def _same_home(self):
		from hermes_constants import get_hermes_home
		return get_hermes_home().resolve() == self.home

	def _prune(self, now):
		for key, (created, _) in list(self._receipts.items()):
			if now - created > self._ttl:
				self._receipts.pop(key, None)
		while len(self._receipts) > self._capacity:
			self._receipts.popitem(last=False)

	@staticmethod
	def _key(task_id, turn_id):
		return (_identifier(task_id), _identifier(turn_id))

	def on_pre_llm_call(self, *, session_id=None, task_id=None, turn_id=None, platform=None, **_ignored):
		# Never inspect or retain prompt, history, tool results, or extra payloads.
		try:
			started = self.clock()
			started_wall = time.time()
			if not self._same_home() or (platform and not _human(platform)):
				return None
			sid, key = _identifier(session_id), self._key(task_id, turn_id)
			with self._lock:
				if self._closed:
					return None
				self._prune(started)
				if key in self._receipts:
					return None
			snapshot = native_snapshot(self.home, sid, dispatched_before=started_wall)
			with self._lock:
				now = self.clock()
				self._prune(now)
				if not self._closed and now - started <= self._ttl:
					# End tombstones and the first begin win against late workers.
					self._receipts.setdefault(key, (started, snapshot))
					self._prune(now)
		except Exception:
			log.debug("Completion begin observation unavailable")
		return None

	def on_session_end(self, *, session_id=None, task_id=None, turn_id=None, completed=None,
					   failed=None, interrupted=None, platform=None, **_ignored):
		try:
			if not self._same_home():
				return None
			sid, key = _identifier(session_id), self._key(task_id, turn_id)
			with self._lock:
				if self._closed:
					return None
				now = self.clock()
				self._prune(now)
				receipt = self._receipts.get(key)
				# Also fence begins whose timeout worker has not returned yet.
				self._receipts[key] = (now, None)
				self._prune(now)
			if (completed is not True or failed is not False or interrupted is not False
					or (platform and not _human(platform)) or receipt is None):
				return None
			before = receipt[1]
			if before is None:
				return None
			after = native_snapshot(self.home, sid)
			if (after is None or after.root != before.root or after.live
					or not after.delegations <= before.delegations):
				return None
			with self._lock:
				if not self._closed and self._same_home():
					self.store.record(after.root, turn_id)
		except Exception:
			# Observation must never break a turn or return injectable context.
			log.debug("Completion end observation unavailable")
		return None

	def close(self):
		with self._lock:
			self._closed = True
			self._receipts.clear()


def register_completion_hooks(ctx):
	from hermes_constants import get_hermes_home

	observer = CompletionObserver(get_hermes_home())
	ctx.register_hook("pre_llm_call", observer.on_pre_llm_call)
	ctx.register_hook("on_session_end", observer.on_session_end)
	ctx.on_unload(observer.close)
