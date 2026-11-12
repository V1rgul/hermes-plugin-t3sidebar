"""Content-free native activity/completion hooks; no Desktop or HTTP dependency.

Only the ordinary Agent runtime currently emits both supported hooks. In particular codex_app_server bypasses on_session_end: do not infer its success from usage, child-stop events, or persisted assistant messages.

pre_llm_call follows native turn persistence but precedes preflight compaction and codex_app_server dispatch in the installed runtime. A hook veto can therefore end the turn without inference; the receipt proves activity, not that a model ran.
Skipped/timed-out hooks remain best effort and must never block agent activity.
"""

from collections import OrderedDict
from contextlib import closing
from dataclasses import dataclass
import json
import logging
import math
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
	archived: bool
	undelivered: frozenset[str] = frozenset()


def native_snapshot(home, session_id, *, dispatched_before=None):
	"""Resolve an exact native rich-list alias and read only its owned IDs/states.

	Parentage alone is not compression: native projection distinguishes real compression continuations from /branch, reset, and delegate forks. Never initialize/migrate state.db or attach to a global session/process registry.
	"""
	from hermes_state import SessionDB
	from .usage_history import internal_listing_sources

	INTERNAL_LISTING_SOURCES = internal_listing_sources()

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
		flags = connection.execute(
			f"SELECT id, source, archived FROM sessions WHERE id IN ({placeholders})", ids,
		).fetchall()
		if {row[0] for row in flags} != aliases or any(not _human(row[1]) for row in flags):
			return None
		rows = connection.execute(
			f"SELECT delegation_id, state, dispatched_at, delivery_state FROM async_delegations WHERE "
			f"parent_session_id IN ({placeholders}) OR origin_session_id IN ({placeholders}) "
			f"OR origin_ui_session_id IN ({placeholders})", ids * 3,
		).fetchall()
	# A timed-out begin worker may finish after tools have already dispatched.
	# Its baseline must not absorb children created since this hook began.
	baseline = [row for row in rows if dispatched_before is None or row[2] < dispatched_before]
	delegations = frozenset(_identifier(row[0]) for row in baseline)
	# Finished children whose result still has to wake the parent (native _persist_completion sets delivery_state='pending').
	undelivered = frozenset(_identifier(row[0]) for row in baseline if row[1] in TERMINAL_DELEGATIONS and row[3] == "pending")
	return NativeSnapshot(root, aliases, delegations,
		any(row[1] not in TERMINAL_DELEGATIONS for row in rows), any(row[2] for row in flags), undelivered)


def heartbeat_fired_at(home, aliases):
	"""Latest /heartbeat firing across the lineage, or None.

	Native records each firing before the turn it starts (hermes_cli.heartbeat.HeartbeatManager.due_prompt) and only after claiming an idle session, so a firing newer than the previous turn's end identifies this turn as the heartbeat's.
	"""
	ids = sorted(aliases)
	try:
		with closing(sqlite3.connect((home / "state.db").as_uri() + "?mode=ro", uri=True, timeout=1)) as connection:
			values = connection.execute(f"SELECT value FROM state_meta WHERE key IN ({','.join('?' for _ in ids)})",
				[f"heartbeat:{sid}" for sid in ids]).fetchall()
		fired = [json.loads(value).get("last_fired_at") for (value,) in values]
	except Exception:
		return None
	fired = [float(value) for value in fired if type(value) in (int, float) and math.isfinite(value)]
	return max(fired, default=None)


def awaits_processes(owners):
	"""Native predicate: a background process started by these task/session ids will still report back into the conversation."""
	try:
		from tools.process_registry import process_registry
		from tools.process_registry_awaiting import awaits_notification

		return bool(awaits_notification(process_registry, owners))
	except Exception:
		return False


def restore_archived_activity(home, session_id, before):
	"""Use native archival only for a proven, exact human compression lineage.

	The public setter restores the lineage Hermes defines, which leaves independent forks archived on every supported core (0.23.0 and later), exactly as Desktop's own Unarchive does. The setter has no compare-and-set fence, so concurrent external lineage changes between preflight and commit remain a native API limitation; the result is verified afterwards.
	"""
	from hermes_state import SessionDB

	current = native_snapshot(home, session_id)
	if current is None or current.root != before.root or current.aliases != before.aliases:
		return False
	if not current.archived:
		return True
	path = home / "state.db"
	# Never call recoverable-session helpers: they also clear native end stamps.
	# Explicit False preserves messages, activity, read state, and pin/hidden flags.
	with closing(SessionDB(db_path=path)) as db:
		if not db.set_session_archived(current.root, False, notify=False):
			return False
	verified = native_snapshot(home, session_id)
	return (verified is not None and verified.root == current.root
		and verified.aliases == current.aliases and not verified.archived)


class CompletionObserver:
	"""Profile-bound activity hook with bounded, ephemeral, ID-only turn receipts.

	pre_llm_call exposes the real task_id and turn_id in the native contract. Missing/evicted/failed begin observations skip completion rather than guess whether already-finished children were dispatched during that turn.
	"""

	def __init__(self, home, *, clock=time.monotonic):
		self.home = Path(home).resolve()
		self.store = CompletionStore(self.home / "plugin-data/hermes-t3sidebar/state.sqlite3")
		self.clock = clock
		self._lock = RLock()
		self._receipts = OrderedDict()
		# Conversation root -> receipt key of the turn that began there last. It decides which turn is current whether or not that turn's start reached the ledger, and lives no longer than that receipt.
		self._latest = {}
		self._closed = False
		self._ttl = 24 * 60 * 60
		self._capacity = 4096

	def _same_home(self):
		from hermes_constants import get_hermes_home
		return get_hermes_home().resolve() == self.home

	def _prune(self, now):
		for key, (created, *_) in list(self._receipts.items()):
			if now - created > self._ttl:
				self._receipts.pop(key, None)
		while len(self._receipts) > self._capacity:
			self._receipts.popitem(last=False)
		# Receipts leave oldest first, so a turn still holding its receipt never loses a newer turn's entry.
		for root, key in list(self._latest.items()):
			if key not in self._receipts:
				del self._latest[root]

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
				# Reserve before I/O: concurrent duplicate callbacks cannot each restore.
				pending = (started, None, False)
				self._receipts[key] = pending
			snapshot = native_snapshot(self.home, sid, dispatched_before=started_wall)
			fired = heartbeat_fired_at(self.home, snapshot.aliases) if snapshot is not None else None
			with self._lock:
				now = self.clock()
				self._prune(now)
				if (not self._closed and self._same_home() and now - started <= self._ttl
						and self._receipts.get(key) is pending):
					if snapshot is not None:
						self._latest[snapshot.root] = key
					# Viewing/resume construction never invokes this turn hook. Only a
					# real pre-loop activity receipt may restore deliberate archives.
					# Fence late workers before any write, not just before Done admission.
					if snapshot is not None and snapshot.archived:
						if not restore_archived_activity(self.home, sid, snapshot):
							snapshot = None
					# Still under the end fence: a turn that already ended can never leave a start behind.
					recorded = snapshot is not None and self._begin_run(snapshot.root, key[1], started_wall, fired)
					self._receipts[key] = (started, snapshot, recorded)
					self._prune(now)
		except Exception as exc:
			log.debug("Completion begin observation unavailable (%s)", type(exc).__name__)
		return None

	def _begin_run(self, root, turn_id, started_wall, heartbeat_fired_at):
		# Independent of Done admission: a failed timer write must not discard the receipt.
		try:
			self.store.begin_run(root, turn_id, float(started_wall), heartbeat_fired_at)
			return True
		except Exception as exc:
			log.debug("Turn start unavailable (%s)", type(exc).__name__)
			return False

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
				self._receipts[key] = (now, None, False)
				self._prune(now)
			# Background work still running wakes this conversation again, so its next turn continues the user's work time: live children, children that finished during this turn with their result still undelivered (those already undelivered at its start are what this turn consumes, or stale), and notifying processes of any lineage id, since compression rotates the owning key. A Stop suppresses those wake-ups until the user's next prompt (native _notif_claim_turn). Without a begin snapshot this turn recorded no start to continue.
			before = receipt[1] if receipt is not None else None
			after = None
			if before is not None and interrupted is not True:
				try:
					after = native_snapshot(self.home, sid)
				except Exception as exc:
					log.debug("Turn end snapshot unavailable (%s)", type(exc).__name__)
			pending = before is not None and interrupted is not True and (
				bool(after and (after.live or after.undelivered - before.undelivered))
				or awaits_processes({sid, key[0], *before.aliases}))
			# Every outcome ends this exact turn; its start stays for subagent-only Working parents.
			with self._lock:
				# Under the lock close() takes, so no write starts once it has returned.
				if self._closed or not self._same_home():
					return None
				try:
					self.store.end_run(key[1], pending)
				except Exception as exc:
					log.debug("Turn end unavailable (%s)", type(exc).__name__)
			if (completed is not True or failed is not False or interrupted is not False
					or (platform and not _human(platform)) or receipt is None):
				return None
			if before is None:
				return None
			if (after is None or after.root != before.root or after.live or after.archived
					or not after.delegations <= before.delegations):
				return None
			with self._lock:
				# A turn that began after this one in the same conversation replaced it, whether or not either start reached the ledger, so Done stays independent of timer writes.
				if not self._closed and self._same_home() and self._latest.get(after.root, key) == key:
					# A turn whose start was recorded also yields to a turn the ledger names instead, such as one another process began.
					self.store.record(after.root, turn_id, current_only=receipt[2])
		except Exception as exc:
			# Observation must never break a turn or return injectable context.
			log.debug("Completion end observation unavailable (%s)", type(exc).__name__)
		return None

	def close(self):
		with self._lock:
			self._closed = True
			self._receipts.clear()
			self._latest.clear()


def register_completion_hooks(ctx):
	from hermes_constants import get_hermes_home

	observer = CompletionObserver(get_hermes_home())
	ctx.register_hook("pre_llm_call", observer.on_pre_llm_call)
	ctx.register_hook("on_session_end", observer.on_session_end)
	ctx.on_unload(observer.close)
