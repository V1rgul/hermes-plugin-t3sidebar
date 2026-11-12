"""hermes-t3sidebar metadata, native listings and sanctioned native deletion.

The host mounts ``router`` in its authenticated /api/plugins/hermes-t3sidebar namespace.
This module is self-contained because Hermes loads it directly via importlib.
"""

import asyncio
import dataclasses
import importlib.util
import json
import logging
import math
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
import uuid
from typing import Annotated, Callable, Literal

from types import SimpleNamespace
from fastapi import APIRouter, HTTPException, Path as PathParameter, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


log = logging.getLogger(__name__)


# Dashboard loads this file directly, without a reliable package name. Load exactly our fixed sibling ledger; no request or profile value controls code.
_completion_spec = importlib.util.spec_from_file_location(
	"hermes_t3sidebar_completion_state", Path(__file__).resolve().parents[1] / "completion_state.py")
assert _completion_spec is not None and _completion_spec.loader is not None
_completion_module = importlib.util.module_from_spec(_completion_spec)
_completion_spec.loader.exec_module(_completion_module)
CompletionStore = _completion_module.CompletionStore


def _load_sibling(name, filename):
	# Same fixed-path loading as the completion ledger: Usage page modules live beside it and are never chosen by a request.
	spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / filename)
	assert spec is not None and spec.loader is not None
	module = importlib.util.module_from_spec(spec)
	spec.loader.exec_module(module)
	return module


usage_history = _load_sibling("hermes_t3sidebar_usage_history", "usage_history.py")
usage_limits = _load_sibling("hermes_t3sidebar_shared_modules", "shared_modules.py").load_limits_module()
banked_reset = _load_sibling("hermes_t3sidebar_banked_reset", "banked_reset.py")
session_drafts = _load_sibling("hermes_t3sidebar_session_drafts", "session_drafts.py")


def session_db_path() -> Path:
	"""The served profile's session store: routes run inside the host's profile scope, where Hermes's home is that profile's home."""
	from hermes_constants import get_hermes_home

	return get_hermes_home() / "state.db"


def open_session_db(profile, *, read_only=True):
	"""The served profile's session store through Hermes's public ``SessionDB``, read-only. ``profile`` is already asserted to be the served one by every caller; any failure to open is a generic 503."""
	from hermes_state import SessionDB

	path = session_db_path()
	try:
		# Hermes creates and migrates the store when the profile's gateway starts; an empty file was never initialized.
		if path.stat().st_size == 0:
			raise sqlite3.OperationalError("uninitialized session store")
		return SessionDB(db_path=path, read_only=True)
	except (OSError, sqlite3.Error) as exc:
		raise HTTPException(503, "session_store_unavailable") from exc


def default_history_db_path(profile) -> Path:
	# usage_history opens it strictly read-only.
	return session_db_path()


def default_limits_path() -> Path:
	from hermes_constants import get_hermes_home

	return get_hermes_home() / "plugin-data" / "hermes-t3sidebar" / "usage-limits.sqlite3"


def ensure_limits_sampler():
	"""Start (once per process and profile home) the 5-minute limits sampler; returns the running sampler.

	Started from Desktop's routine sidebar polls rather than at import, so the thread inherits the request's profile and secret scope, and test imports of this module never reach live credentials.
	"""
	return usage_limits.start_limits_sampler(usage_limits.LimitsStore(default_limits_path()))


SESSION_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$"
SessionId = Annotated[str, PathParameter(pattern=SESSION_ID_PATTERN, max_length=256)]
Action = Literal["settle", "restore", "snooze", "pin", "unpin", "ack_wake", "ack_done"]


class SessionAction(BaseModel):
	model_config = ConfigDict(extra="forbid", strict=True)

	action: Action
	wake_at: float | None = None
	woke_at: float | None = None
	done_token: str | None = Field(default=None, min_length=1, max_length=256)

	@field_validator("wake_at", "woke_at", mode="before")
	@classmethod
	def numeric_timestamp(cls, value, info):
		if value is None:
			return value
		# Reject booleans and numeric strings; avoid non-finite values appearing
		# inside FastAPI's JSON validation error payload (JSON cannot encode NaN).
		try:
			valid = type(value) in (int, float) and math.isfinite(value)
		except (OverflowError, TypeError):
			valid = False
		if not valid:
			raise HTTPException(422, f"{info.field_name} must be a finite JSON number")
		if info.field_name == "woke_at" and value <= 0:
			raise HTTPException(422, "woke_at must be positive")
		return value

	@model_validator(mode="after")
	def wake_only_for_snooze(self):
		if self.action == "snooze":
			if self.wake_at is None:
				raise ValueError("snooze requires wake_at")
		elif "wake_at" in self.model_fields_set:
			raise ValueError("wake_at is only valid for snooze")
		if self.action == "ack_wake":
			if self.woke_at is None:
				raise ValueError("ack_wake requires woke_at")
		elif "woke_at" in self.model_fields_set:
			raise ValueError("woke_at is only valid for ack_wake")
		if self.action == "ack_done":
			if self.done_token is None:
				raise ValueError("ack_done requires done_token")
		elif "done_token" in self.model_fields_set:
			raise ValueError("done_token is only valid for ack_done")
		return self


class SessionDelete(BaseModel):
	"""Keep the entire confirmed request unchanged after an ambiguous response."""
	model_config = ConfigDict(extra="forbid", strict=True)

	request_id: str = Field(pattern=SESSION_ID_PATTERN, min_length=1, max_length=256)
	expected_revision: int = Field(ge=0)
	expected_generation: int = Field(ge=0)


class ExperimentalToggle(BaseModel):
	model_config = ConfigDict(extra="forbid", strict=True)

	enabled: bool


class BankedResetRedeem(BaseModel):
	model_config = ConfigDict(extra="forbid", strict=True)

	# Only Codex banks resets; the account is a credential-pool entry id as listed by /usage/limits.
	provider: Literal["openai-codex"]
	account: str = Field(pattern=r"^[A-Za-z0-9_.:-]{1,64}$")


class DraftChange(BaseModel):
	model_config = ConfigDict(extra="forbid")

	session_id: str = Field(pattern=SESSION_ID_PATTERN, max_length=256)
	# Blank text deletes the draft.
	text: Annotated[str, Field(strict=True, max_length=session_drafts.MAX_TEXT_LENGTH)]
	# The folder a new session reopens this draft in when its own session has no stored history; absent keeps the stored one.
	cwd: Annotated[str, Field(strict=True, min_length=1, max_length=4096)] | None = None
	# When the edit happened, by the client's clock; only its distance to sent_at is used.
	edited_at: float = Field(allow_inf_nan=False)


class DraftSync(BaseModel):
	model_config = ConfigDict(extra="forbid")

	# The cursor returned by the previous sync; 0 asks for every draft.
	since: Annotated[int, Field(strict=True, ge=0)]
	# The client's clock when sending.
	sent_at: float = Field(allow_inf_nan=False)
	changes: list[DraftChange] = Field(default_factory=list, max_length=200)


class SessionTitle(BaseModel):
	model_config = ConfigDict(extra="forbid", strict=True)

	# Core enforces its own maximum; this only bounds the request.
	title: str = Field(min_length=1, max_length=1024)


class SessionMetadata(BaseModel):
	state: Literal["active", "settled", "snoozed"]
	settled_at: float | None
	wake_at: float | None
	woke_at: float | None = None
	pinned: bool
	updated_at: float


class CompletionMetadata(BaseModel):
	done_at: float = Field(gt=0, allow_inf_nan=False)
	done_token: str = Field(min_length=1, max_length=256)


class RunMetadata(BaseModel):
	started_at: float = Field(gt=0, allow_inf_nan=False)
	ended_at: float | None = Field(default=None, gt=0, allow_inf_nan=False)
	pending: bool = False


class FlowState(BaseModel):
	version: Literal[1] = 1
	sessions: dict[str, SessionMetadata]
	completions: dict[str, CompletionMetadata] = Field(default_factory=dict)
	runs: dict[str, RunMetadata] = Field(default_factory=dict)


def default_state_path() -> Path:
	# Resolve on each request, not import: Hermes can scope the active home
	# with contextvars when dispatching to a profile's plugin namespace.
	from hermes_constants import get_hermes_home

	return get_hermes_home() / "plugin-data" / "hermes-t3sidebar" / "state.sqlite3"


class HermesT3SidebarStore:
	"""Short-lived per-operation connections; SQLite serializes writers.

	Current-schema reads with no due wake use a read-only snapshot. Migrations,
	mutations and due sweeps serialize in an IMMEDIATE transaction and recheck
	time/state there. Exact wake acknowledgments never sweep other snoozes.
	Wake eligibility uses UTC epoch seconds even after the app/backend closed.
	"""

	def __init__(self, path: Path, clock: Callable[[], float] = time.time):
		self.path = Path(path)
		self.clock = clock

	def state(self) -> dict:
		# Probe the complete current schema and rows in ONE read-only snapshot.
		# An established, not-due GET must not queue behind an unrelated writer.
		# Close the reader before escalating: never upgrade a stale read snapshot.
		if self.path.is_file():
			connection = sqlite3.connect(self.path.resolve().as_uri() + "?mode=ro", uri=True, timeout=30, isolation_level=None)
			connection.row_factory = sqlite3.Row
			try:
				connection.execute("BEGIN")
				try:
					rows = connection.execute("""
						SELECT session_id, state, settled_at, wake_at, pinned, updated_at, woke_at
						FROM session_metadata ORDER BY session_id
					""").fetchall()
					completions = CompletionStore.read(connection)
					runs = CompletionStore.read_runs(connection)
				except sqlite3.OperationalError as exc:
					# Only absent/legacy schema needs a writer; do not hide IO/lock errors.
					if not str(exc).startswith(("no such table:", "no such column:")):
						raise
				else:
					now = float(self.clock())
					if not math.isfinite(now):
						raise ValueError("clock must return a finite UTC epoch timestamp")
					if not any(row["state"] == "snoozed" and row["wake_at"] <= now for row in rows):
						connection.execute("COMMIT")
						return self._state_rows(rows, completions, runs)
			finally:
				connection.close()
		return self._transaction()

	def organized_ids(self) -> tuple:
		"""The sorted ids of organised and completed sessions, with the same schema and due-wake handling as state(), without building it."""
		if self.path.is_file():
			connection = sqlite3.connect(self.path.resolve().as_uri() + "?mode=ro", uri=True, timeout=30, isolation_level=None)
			try:
				connection.execute("BEGIN")
				try:
					# woke_at and the run columns are probed, not used: a store that needs a migration still gets it from this request, as from state().
					rows = connection.execute("SELECT session_id, state, wake_at, woke_at FROM session_metadata").fetchall()
					completed = [sid for (sid,) in connection.execute("SELECT session_id FROM session_completions")]
					connection.execute("SELECT started_at, ended_at, pending FROM session_runs LIMIT 0").fetchall()
				except sqlite3.OperationalError as exc:
					if not str(exc).startswith(("no such table:", "no such column:")):
						raise
				else:
					now = float(self.clock())
					if not math.isfinite(now):
						raise ValueError("clock must return a finite UTC epoch timestamp")
					if not any(state == "snoozed" and wake_at <= now for _sid, state, wake_at, _woke_at in rows):
						connection.execute("COMMIT")
						return tuple(sorted({sid for sid, *_ in rows} | set(completed)))
			finally:
				connection.close()
		state = self._transaction()
		return tuple(sorted(state["sessions"].keys() | state["completions"].keys()))

	@staticmethod
	def _state_rows(rows, completions, runs) -> dict:
		result = {"version": 1, "sessions": {}, "completions": completions, "runs": runs}
		for row in rows:
			metadata = dict(row)
			key = metadata.pop("session_id")
			metadata["pinned"] = bool(metadata["pinned"])
			result["sessions"][key] = metadata
		return result

	def forget(self, session_ids) -> None:
		"""Drop the organisation, Done marker and turn start of sessions whose native deletion was verified.

		Delivery receipts stay, so a replayed end of their turns still cannot bring a Done back. Creates neither the store nor a table.
		"""
		if any(not isinstance(sid, str) or re.fullmatch(SESSION_ID_PATTERN, sid) is None for sid in session_ids):
			raise ValueError("invalid session id")
		if not session_ids or not self.path.is_file():
			return
		connection = sqlite3.connect(self.path, timeout=30, isolation_level=None)
		try:
			connection.execute("BEGIN IMMEDIATE")
			tables = {name for (name,) in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
			for table in ("session_metadata", "session_completions", "session_runs"):
				if table in tables:
					connection.executemany(f"DELETE FROM {table} WHERE session_id = ?", [(sid,) for sid in session_ids])
			connection.execute("COMMIT")
		except BaseException:
			if connection.in_transaction:
				connection.execute("ROLLBACK")
			raise
		finally:
			connection.close()

	def mutate(self, session_id: str, body: SessionAction) -> dict:
		if not isinstance(session_id, str) or re.fullmatch(SESSION_ID_PATTERN, session_id) is None:
			raise ValueError("invalid session id")
		return self._transaction(session_id, body)

	def _transaction(self, session_id=None, body=None) -> dict:
		self.path.parent.mkdir(parents=True, exist_ok=True)
		connection = sqlite3.connect(self.path, timeout=30, isolation_level=None)
		connection.row_factory = sqlite3.Row
		try:
			connection.execute("BEGIN IMMEDIATE")
			# Capture time after acquiring the lock, so a queued snooze cannot
			# become invalid while waiting and still be committed as future.
			now = float(self.clock())
			if not math.isfinite(now):
				raise ValueError("clock must return a finite UTC epoch timestamp")
			if body is not None and body.action == "snooze" and body.wake_at <= now:
				raise HTTPException(422, "wake_at must be strictly in the future")
			connection.execute("""
				CREATE TABLE IF NOT EXISTS session_metadata (
					session_id TEXT PRIMARY KEY,
					state TEXT NOT NULL CHECK (state IN ('active', 'settled', 'snoozed')),
					settled_at REAL,
					wake_at REAL,
					pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
					updated_at REAL NOT NULL,
					woke_at REAL,
					CHECK (
						(state = 'active' AND settled_at IS NULL AND wake_at IS NULL) OR
						(state = 'settled' AND settled_at IS NOT NULL AND wake_at IS NULL) OR
						(state = 'snoozed' AND settled_at IS NULL AND wake_at IS NOT NULL)
					)
				)
			""")
			# Additive migration preserves existing organization and constraints.
			# The same writer lock serializes concurrent first requests/upgrades.
			columns = {row["name"] for row in connection.execute("PRAGMA table_info(session_metadata)")}
			if "woke_at" not in columns:
				connection.execute("ALTER TABLE session_metadata ADD COLUMN woke_at REAL")
			CompletionStore.ensure_schema(connection)
			# updated_at is the wake instant, not the time somebody next opens
			# Desktop. Reading late does not change effective wake chronology.
			# Acknowledgment must not materialize a different, newly due snooze.
			if body is None or body.action not in ("ack_wake", "ack_done"):
				connection.execute("""
					UPDATE session_metadata
					SET state = 'active', settled_at = NULL, updated_at = wake_at,
					woke_at = wake_at, wake_at = NULL
					WHERE state = 'snoozed' AND wake_at <= ?
				""", (now,))
			if body is not None:
				if body.action not in ("ack_wake", "ack_done"):
					connection.execute("""
						INSERT INTO session_metadata (session_id, state, settled_at, wake_at, pinned, updated_at)
						VALUES (?, 'active', NULL, NULL, 0, ?)
						ON CONFLICT(session_id) DO NOTHING
					""", (session_id, now))
				if body.action == "settle":
					connection.execute("""
						UPDATE session_metadata SET state = 'settled', settled_at = ?,
						wake_at = NULL, woke_at = NULL, updated_at = ? WHERE session_id = ?
					""", (now, now, session_id))
				elif body.action == "restore":
					connection.execute("""
						UPDATE session_metadata SET state = 'active', settled_at = NULL,
						wake_at = NULL, woke_at = NULL, updated_at = ? WHERE session_id = ?
					""", (now, session_id))
				elif body.action == "snooze":
					connection.execute("""
						UPDATE session_metadata SET state = 'snoozed', settled_at = NULL,
						wake_at = ?, woke_at = NULL, updated_at = ? WHERE session_id = ?
					""", (body.wake_at, now, session_id))
				elif body.action == "ack_wake":
					# Compare-and-clear: a delayed read cannot acknowledge a newer wake.
					# Do not create absent rows or alter organization/updated_at.
					connection.execute("""
						UPDATE session_metadata SET woke_at = NULL
						WHERE session_id = ? AND woke_at = ?
					""", (session_id, body.woke_at))
				elif body.action == "ack_done":
					CompletionStore.acknowledge(connection, session_id, body.done_token)
				else:
					connection.execute("""
						UPDATE session_metadata SET pinned = ?, updated_at = ? WHERE session_id = ?
					""", (int(body.action == "pin"), now, session_id))
			rows = connection.execute("SELECT * FROM session_metadata ORDER BY session_id").fetchall()
			result = self._state_rows(rows, CompletionStore.read(connection), CompletionStore.read_runs(connection))
			connection.execute("COMMIT")
			return result
		except BaseException:
			if connection.in_transaction:
				connection.execute("ROLLBACK")
			raise
		finally:
			connection.close()


def served_profile():
	from hermes_constants import get_hermes_home, profile_name_for_home

	profile = profile_name_for_home(get_hermes_home())
	if not profile:
		raise HTTPException(503, "profile_context_unavailable")
	return profile


def running_subagent_count(records):
	"""Reduce a native, ownership-qualified live roster; missing status is not zero."""
	if not isinstance(records, list) or any(not isinstance(row, dict) or not isinstance(row.get("status"), str) for row in records):
		return None
	return sum(row["status"] == "running" for row in records)


def standalone_subagent_count(server, row, snapshot, db, home):
	# Reuse ONLY the object admitted by the native exact-home snapshot. A runtime
	# replacement/rebuild must not lend its parent's children to a stale row.
	try:
		from gateway.session_ancillary import subagent_records

		session, parent = snapshot

		def admitted_db():
			# Called only under the registry lock, before and after native IO.
			if (server._sessions.get(row["id"]) is not session or session.get("_finalized")
				or parent is None or session.get("agent") is not parent
				or session.get("session_key") != row["session_key"]
				or getattr(parent, "session_id", None) != row["session_key"]
				or Path(session.get("profile_home") or server._launch_home()).resolve() != home):
				return None
			owner_db = getattr(parent, "_session_db", None)
			owner_path, expected_path = getattr(owner_db, "db_path", None), getattr(db, "db_path", None)
			if (owner_path is None or expected_path is None
				or Path(owner_path).resolve() != Path(expected_path).resolve()
				or getattr(parent, "gateway_session_key", None) not in (None, row["id"])):
				return None
			return owner_db

		with server._sessions_lock:
			owner_db = admitted_db()
		if owner_db is None:
			return None
		# Native lineage reads may wait for token flushing. Never hold the global
		# registry lock across them, and retain the actual DB object's fallback identity.
		count = running_subagent_count(subagent_records(parent, session_id=row["session_key"],
			session_db=owner_db, route=row["id"], include_fallback_evicted=True))
		with server._sessions_lock:
			return count if admitted_db() is owner_db else None
	except Exception as exc:
		# Older cores, stale objects and failed projections are unknown per row.
		log.debug("Running subagent count unavailable (%s)", type(exc).__name__)
		return None


def subagent_run(record):
	"""Delegated subagent runs are never sidebar conversations. Desktop's lazy watch session on a child puts it in the runtime registry, while native listings hide it by the same `model_config._delegate_from` marker (worker children also store source `subagent`)."""
	if not record:
		return False
	if str(record.get("source") or "").strip().lower() == "subagent":
		return True
	config = record.get("model_config")
	if isinstance(config, str):
		try:
			config = json.loads(config)
		except (ValueError, RecursionError):
			return False
	return isinstance(config, dict) and config.get("_delegate_from") is not None


def stored_rows(db, session_ids):
	"""Exact stored rows by id through Hermes's public ``get_session``, one read each; missing ids are absent. Only plain session columns are read from them: the list's own query carries preview and recency."""
	rows = {}
	for sid in dict.fromkeys(sid for sid in session_ids if sid):
		row = db.get_session(sid)
		if row is not None:
			rows[sid] = row
	return rows


def runtime_retired(db, row):
	"""A missing row can be an unsaved draft; only native retirement proves deletion."""
	from hermes_state_mutation_retirement import retired_session

	return any(retired_session(db, sid) for sid in {row.get("session_key"), row.get("id")} if sid)


# Manual /compress holds a session busy without a native turn or plugin hook, and records no start time. Remember when this process first saw each compaction so its Working time is shown and continuous; keyed by home and runtime id, and owned by the session object observed.
_compression_lock = threading.Lock()
_compression_seen: dict[tuple[str, str], tuple[int, float]] = {}


def runtime_compression_started_at(home, sid, session, compressing, now=None):
	"""First observation of the session's current manual compaction, or None. Call once per snapshot row."""
	key = (str(home), sid)
	with _compression_lock:
		if not compressing:
			_compression_seen.pop(key, None)
			return None
		seen = _compression_seen.get(key)
		if seen is None or seen[0] != id(session):
			seen = _compression_seen[key] = (id(session), time.time() if now is None else now)
		return seen[1]


def forget_compressions(home, present):
	"""Drop compaction observations for runtime ids absent from this home's snapshot."""
	with _compression_lock:
		for key in [key for key in _compression_seen if key[0] == str(home) and key[1] not in present]:
			del _compression_seen[key]


def runtime_awaits_processes(session):
	"""Native predicate: a background process this session started (notify_on_complete or watch_patterns) is running, or its notice is still on the way back into the session. Plain background servers that never report back do not count. Unknown is None."""
	try:
		from tui_gateway.session_notifications import _session_owns_pending_process_notification

		return bool(_session_owns_pending_process_notification(session))
	except Exception:
		return None


# The automatic compaction heartbeat stamps the agent's activity with these descriptions under the agent.compression provenance while it runs. Stopping writes "completed" or "failed" under the same provenance, and the next ordinary activity replaces it, so neither counts.
_COMPACTION_RUNNING = frozenset({"context compression started", "context compression in progress"})


def runtime_compacting(session, agent):
	"""Manual /compress (session flag) or an automatic compaction whose heartbeat is still running on the live agent. Call under the registry lock."""
	if session.get("_manual_compress_active"):
		return True
	provenance = getattr(agent, "_last_activity_provenance", None)
	return (getattr(provenance, "value", provenance) == "agent.compression"
		and getattr(agent, "_last_activity_desc", None) in _COMPACTION_RUNNING)


def runtime_turn_started_at(session):
	"""Native in-flight turn start (Desktop's own elapsed-timer source), never a retained failed turn.

	Call under the registry lock. Unlike the plugin hook, this exists before ``message.start`` is emitted, so the runtime refresh that reveals Working already carries it.
	"""
	turn = session.get("inflight_turn")
	if not isinstance(turn, dict) or turn.get("status") == "error":
		return None
	started = turn.get("started_at")
	if type(started) not in (int, float) or not math.isfinite(started) or started <= 0:
		return None
	return float(started)


def runtime_session_facts(session):
	"""Copy only per-session display evidence, never history, prompts or credentials.

	Call under the registry lock; native route/default resolution and catalog IO
	happen later, against this copy, with ownership revalidated before publication.
	"""
	facts = {key: session[key] for key in ("session_key", "source", "cwd", "explicit_cwd", "profile_home") if key in session}
	for key, fields in (("model_override", ("model", "provider")),
		("pending_model_switch", ("display_model", "display_provider")),
		("_metadata_mirror", ("model", "provider"))):
		value = session.get(key)
		facts[key] = {field: value[field] for field in fields if field in value} if isinstance(value, dict) else {}
	from agent.voice_turn_route import session_runtime_view

	agent = session_runtime_view(session.get("agent"))
	facts["agent"] = {key: getattr(agent, key, None) for key in ("model", "provider")}
	facts["history_known"] = isinstance(session.get("history"), list)
	return facts


def runtime_display_metadata(server, facts, projects):
	item: dict = {"cwd": None, "project": None, "provider": None}
	if "cwd" in facts:
		cwd = facts["cwd"]
		# Desktop's implicit launch directory is not a chosen workspace. A
		# missing cwd is unknown; an explicit empty/null cwd is detached/Home.
		if facts.get("source") == "desktop" and facts.get("explicit_cwd") is False:
			cwd = None
		if cwd is None or isinstance(cwd, str):
			item["cwd"] = cwd if isinstance(cwd, str) and cwd.strip() else None
			item["project"] = card_project(item["cwd"], projects)
			item["project"].setdefault("is_home", False)
	try:
		# Never pass the real agent or call _session_info: that broad projection
		# reads prompts, credentials and process-wide workspace defaults.
		snapshot = {**facts, "agent": SimpleNamespace(**facts["agent"])}
		item["provider"] = provider_name(server._live_session_identity(snapshot)[1])
	except Exception:
		# Older cores may lack the read helper. Explicit evidence is still safe;
		# a failed default resolver is unknown, never a model-name inference.
		candidates = (facts["pending_model_switch"].get("display_provider"),
			facts["_metadata_mirror"].get("provider"), facts["agent"].get("provider"),
			facts["model_override"].get("provider"))
		# A higher-priority automatic/unknown selection masks older evidence.
		item["provider"] = provider_name(next((value for value in candidates
			if isinstance(value, str) and value.strip()), None))
	return item


def runtime_message_count(live_count, stored_count=None):
	# Do not let a lazy resume's empty in-memory history erase persisted history.
	counts = [value for value in (live_count, stored_count) if type(value) is int and value >= 0]
	return max(counts) if counts else None


def standalone_runtime(request, profile, actor):
	# Version-sensitive standalone seam: use ONLY this process's already-loaded
	# server and the native exact-home snapshot, never import a fresh registry or
	# dispatch the unqualified legacy RPC. Authentication still comes from core.
	import sys
	from hermes_constants import get_hermes_home

	home = get_hermes_home().resolve()
	if actor is None:
		raise HTTPException(503, "session_authority_unavailable")
	owner = Path(actor.profile_id)
	if not owner.is_absolute() or owner.resolve() != home:
		raise HTTPException(403, "profile_mismatch")
	# The installed standalone resolver does not check a native grant's home
	# (its authority-backed branch does), so retain that boundary here too.
	native = getattr(request.state, "native_http_principal", None)
	if native is not None and native.get("profile_id") != str(home):
		raise HTTPException(403, "profile_mismatch")
	if "session:read" not in actor.capabilities:
		raise HTTPException(403, "permission_denied")
	server = sys.modules.get("tui_gateway.server")
	if server is None:
		raise HTTPException(503, "standalone_runtime_unavailable")
	from tui_gateway.ws_legacy_fallback import _own_profile_read
	INTERNAL_LISTING_SOURCES = usage_history.internal_listing_sources()

	facts, parents, turn_starts, compressing, compacting, awaiting = {}, {}, {}, {}, {}, {}

	def profile_home(name):
		resolved = server._profile_home(name)
		# Native None means the launch home, not an unresolved profile.
		return Path(server._launch_home()) if resolved is None else resolved

	def admitted(sid, session, parent, key):
		return (server._sessions.get(sid) is session and not session.get("_finalized")
			and session.get("agent") is parent
			and str(getattr(parent, "session_id", None) or session.get("session_key") or sid) == key
			and Path(session.get("profile_home") or server._launch_home()).resolve() == home)

	def live_item(sid, session, current):
		with server._sessions_lock:
			parent = session.get("agent")
			key = str(getattr(parent, "session_id", None) or session.get("session_key") or sid)
			if not admitted(sid, session, parent, key):
				raise HTTPException(503, "standalone_snapshot_changed")
			captured = runtime_session_facts(session)
			turn_starts[(sid, key)] = runtime_turn_started_at(session)
			compressing[(sid, key)] = bool(session.get("_manual_compress_active"))
			compacting[(sid, key)] = runtime_compacting(session, parent)
		# The native mapper can read titles from SQLite. It must run outside
		# the global registry lock, just like catalog/default-route/lineage IO.
		item = server._session_live_item(sid, session, current)
		# The native predicate refreshes detached processes and takes registry locks of its own.
		awaiting[(sid, key)] = runtime_awaits_processes(session)
		with server._sessions_lock:
			if (not admitted(sid, session, parent, key) or item["session_key"] != key
				or runtime_session_facts(session) != captured):
				raise HTTPException(503, "standalone_snapshot_changed")
		facts[(item["id"], key)] = captured
		parents[(item["id"], key)] = (session, parent)
		return item

	# Adapt only the native launch sentinel; capture metadata during the same
	# exact-home native mapping, never walk another registry.
	scoped_server = SimpleNamespace(_profile_home=profile_home, _launch_home=server._launch_home,
		_sessions_lock=server._sessions_lock, _sessions=server._sessions, _session_live_item=live_item)
	snapshot = _own_profile_read(scoped_server, {"jsonrpc": "2.0", "id": "hermes-t3sidebar-runtime",
		"method": "session.active_list", "params": {"profile": profile}}, str(home))
	if "error" in snapshot:
		raise HTTPException(503, "standalone_profile_unavailable")
	rows = snapshot["result"]["sessions"]
	forget_compressions(home, {row["id"] for row in rows})
	if not rows:
		return {"sessions": []}
	# Persisted source facts win; native empty drafts have no DB row yet, so retain their source captured during the same exact-home native mapping.
	db = open_session_db(profile, read_only=True)
	try:
		if Path(db.db_path).resolve().parent != home:
			raise HTTPException(403, "profile_mismatch")
		stored = stored_rows(db, {row["session_key"] for row in rows})
		projects = card_projects(db)
		visible = []
		for row in rows:
			if runtime_retired(db, row):
				continue
			identity = (row["id"], row["session_key"])
			captured = facts[identity]
			record = stored.get(row["session_key"])
			source = record.get("source") if record is not None else captured.get("source")
			if not isinstance(source, str) or not source.strip():
				raise HTTPException(503, "standalone_session_source_unavailable")
			if source.strip().lower() in {*INTERNAL_LISTING_SOURCES, "cron", "subagent"} or subagent_run(record):
				continue
			item = {k: row[k] for k in ("id", "session_key", "status", "current", "last_active", "started_at", "model", "title")}
			item["message_count"] = runtime_message_count(
				row.get("message_count") if captured["history_known"] else None,
				record.get("message_count") if record else None)
			metadata = runtime_display_metadata(server, captured, projects)
			# Native legacy previews may contain pending prompts. Runtime needs
			# liveness/identity only; do not return that text or any extra fields.
			# Compaction is transparent: a turn's own compaction keeps its native start, and a manual one counts from when it was first seen. Called even under a native turn, so a compaction that ends meanwhile is forgotten.
			compaction_started_at = runtime_compression_started_at(
				home, row["id"], parents[identity][0], compressing.get(identity, False))
			item["turn_started_at"] = turn_starts.get(identity) or compaction_started_at
			item["awaiting_processes"] = awaiting.get(identity)
			item["compacting"] = compacting.get(identity, False)
			item["running_subagents"] = standalone_subagent_count(server, row,
				parents[identity], db, home)
			# All catalog/default-route/lineage IO ran outside the registry lock.
			# An object/owner/identity change cannot publish stale workspace picks.
			session, parent = parents[identity]
			with server._sessions_lock:
				valid = (admitted(row["id"], session, parent, row["session_key"])
					and runtime_session_facts(session) == captured)
			item.update(metadata if valid else {"cwd": None, "project": None, "provider": None})
			visible.append({**item, "preview": "", "source": source.strip().lower()})
		return {"sessions": visible}
	finally:
		db.close()


def authority_runtime_rows(db_path, rows):
	"""Read only the admitted authority's store, never another runtime registry."""
	from hermes_state import SessionDB
	INTERNAL_LISTING_SOURCES = usage_history.internal_listing_sources()

	with_db = SessionDB(db_path, read_only=True)
	try:
		rows = [row for row in rows if row.get("source") not in {*INTERNAL_LISTING_SOURCES, "cron", "subagent"}
			and not runtime_retired(with_db, row)]
		stored = stored_rows(with_db, {row.get("session_key") or row["id"] for row in rows})
		rows = [row for row in rows if not subagent_run(stored.get(row.get("session_key") or row["id"]))]
		projects = card_projects(with_db) if rows else []
		result = []
		for row in rows:
			record = stored.get(row.get("session_key") or row["id"], {})
			item = {k: row[k] for k in RUNTIME_FIELDS if k in row}
			item.update(cwd=None, project=None, provider=card_provider(record.get("model_config")), preview="")
			if "cwd" in record:
				item["cwd"] = record["cwd"]
				item["project"] = card_project(record["cwd"], projects)
				item["project"].setdefault("is_home", False)
			item["message_count"] = runtime_message_count(row.get("message_count"), record.get("message_count"))
			result.append(item)
		return result
	finally:
		with_db.close()


RUNTIME_FIELDS = frozenset({"id", "session_key", "status", "current", "last_active", "started_at", "message_count", "model", "title", "source"})


async def native_runtime(request, profile):
	# Hosted admission carries no parent actor/authority or same-process chats.
	# Do not invent a principal or probe private loopbacks from the plugin host.
	if getattr(request.state, "hosted_http_authenticated", False) is True:
		raise HTTPException(503, "session_authority_unavailable")
	from hermes_cli.web_server_sessions import _session_mutation_context
	from gateway.session_active_list import active_list
	from gateway.session_contract import SessionRef

	authority, actor = _session_mutation_context(request, profile)
	if authority is None:
		# Copy the profile context into the worker; no new registry, loop or DB
		# authority is created. Native mapper/lineage waits must not stall HTTP.
		return await asyncio.to_thread(standalone_runtime, request, profile, actor)
	from hermes_constants import get_hermes_home

	home = get_hermes_home().resolve()
	db_path = Path(authority.db.db_path).resolve()
	if (actor is None or not Path(actor.profile_id).is_absolute()
		or Path(actor.profile_id).resolve() != home or authority.profile_id != str(home)
		or db_path.parent != home):
		raise HTTPException(403, "profile_mismatch")
	native = getattr(request.state, "native_http_principal", None)
	if native is not None and native.get("profile_id") != str(home):
		raise HTTPException(403, "profile_mismatch")
	if "session:read" not in actor.capabilities:
		raise HTTPException(403, "permission_denied")
	# Narrow the native actor instead of naming its class, which Hermes renamed (Principal -> SessionActor) without an alias.
	reader = dataclasses.replace(actor, capabilities=frozenset({"session:read"}))
	connection = SimpleNamespace(authority=authority, actor=reader)
	value = await active_list(connection, None, {})
	value["sessions"] = await asyncio.to_thread(authority_runtime_rows, db_path, value["sessions"])
	for row in value["sessions"]:
		row["running_subagents"] = None
		# Authority rows expose no process ownership; unknown never means idle.
		row["awaiting_processes"] = None
		# Nor any agent activity: compaction is unknown.
		row["compacting"] = None
		# Authority rows carry no turn start; Desktop falls back to the hook-recorded open turn.
		row["turn_started_at"] = None
		try:
			from gateway.session_ancillary import read

			projection = await read(connection, SessionRef(reader.profile_id, row["id"]),
				{"session_id": row["id"], "profile": profile}, kind="subagents")
			row["running_subagents"] = running_subagent_count(projection.get("subagents"))
		except Exception as exc:
			# Unsupported worker projections, stale generations, missing seams or
			# authority failures cannot turn unknown into idle or retain an old count.
			# Cancellation (BaseException) still cancels the request.
			log.debug("Subagent projection unavailable (%s)", type(exc).__name__)
	return value


LIST_FIELDS = frozenset({"id", "source", "archived", "resolved_id", "title", "preview", "cwd", "git_branch", "git_repo_root",
	"last_active", "started_at", "updated_at", "message_count", "unread", "_lineage_root_id", "_lineage_ids"})


def card_projects(db):
	"""Read this SessionDB's catalog once, without schema initialization or home lookup."""
	db_path = getattr(db, "db_path", None)
	if db_path is None:
		return []
	path = Path(db_path).resolve().parent / "projects.db"
	if not path.is_file():
		return []
	try:
		from hermes_cli.projects_db import list_projects
	except ImportError:
		# A core without this helper still lists every chat, just without registered projects.
		return []
	try:
		connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
		try:
			connection.row_factory = sqlite3.Row
			return list_projects(connection, include_archived=False)
		finally:
			connection.close()
	except sqlite3.Error:
		# Missing/legacy/unreadable catalogs must not trigger migrations or hide chats.
		return []


def card_project(cwd, projects):
	if not isinstance(cwd, str) or not cwd.strip():
		return {"id": "__no_project__", "name": "Home", "icon": None, "color": None, "cwd": None, "is_home": True}
	try:
		from hermes_cli.projects_db import _normalize_path
	except ImportError:
		# Without Hermes's own normalizer no folder can be proven to own this one: show it unregistered rather than guess.
		target = cwd.strip()
		return {"id": target, "name": Path(target).name or target, "icon": None, "color": None, "cwd": target}
	target = _normalize_path(cwd)
	# Match project_for_path's longest owning folder, including secondary folders, and its descendant test: either the OS separator or "/".
	owners = [(folder.path, project) for project in projects for folder in project.folders
		if target == folder.path or any(target.startswith(folder.path.rstrip("/\\") + separator) for separator in (os.sep, "/"))]
	if owners:
		folder, project = max(owners, key=lambda owner: len(owner[0]))
		return {"id": project.id, "name": project.name, "icon": project.icon, "color": project.color, "cwd": folder}
	return {"id": target, "name": Path(target).name or target, "icon": None, "color": None, "cwd": target}


def provider_name(value):
	if not isinstance(value, str):
		return None
	value = value.strip().lower()
	return value if value and value not in {"auto", "unknown", "default", "none"} else None


def card_provider(config):
	if isinstance(config, str):
		try:
			config = json.loads(config)
		except (ValueError, RecursionError):
			return None
	if not isinstance(config, dict):
		return None
	provider = config.get("provider")
	if provider_name(provider):
		return provider_name(provider)
	runtime = config.get("gateway_runtime")
	provider = runtime.get("provider") if isinstance(runtime, dict) else None
	return provider_name(provider)


def card_billing_providers(db, session_ids):
	"""Read main-loop route evidence, never auxiliary model usage."""
	connection = getattr(db, "_conn", None)
	if not isinstance(connection, sqlite3.Connection):
		return {}
	result = {}
	try:
		# One JSON parameter, as in card_subagent_usage, has no bound-variable limit to batch around.
		rows = connection.execute("SELECT DISTINCT session_id, billing_provider FROM session_model_usage WHERE task = '' AND session_id IN (SELECT value FROM json_each(?))",
			(json.dumps(sorted(session_ids)),))
		for sid, value in rows:
			if provider := provider_name(value):
				result.setdefault(sid, set()).add(provider)
	except sqlite3.Error:
		# Older stores may have no task-attributed usage table; unknown is safer than a guess.
		return {}
	return result


def card_subagent_usage(db, seed_ids):
	"""Delegated subagent sessions below each seed, with their stored token counters: {seed: {child_id: (input, output)}}.

	Mirrors native cascade deletion (`_collect_delegate_child_ids`): a delegate's row names its spawning session in `parent_session_id` and carries the `_delegate_from` marker, which nested delegates and a subagent's own compression continuations (they inherit `model_config` verbatim) also carry, so following only marked children of a seed reaches every subagent segment without entering the conversation's branch/reset forks. One recursive read per batch walks the parent index instead of scanning each card's marker.
	"""
	connection = getattr(db, "_conn", None)
	if not isinstance(connection, sqlite3.Connection) or not seed_ids:
		return {}
	result = {}
	try:
		rows = connection.execute("""
			WITH RECURSIVE tree(seed, id) AS (
				SELECT value, value FROM json_each(?)
				UNION
				SELECT tree.seed, child.id FROM tree
				JOIN sessions child ON child.parent_session_id = tree.id
				WHERE CASE WHEN json_valid(child.model_config) THEN json_extract(child.model_config, '$._delegate_from') END IS NOT NULL
			)
			SELECT tree.seed, s.id, s.input_tokens, s.output_tokens FROM tree JOIN sessions s ON s.id = tree.id WHERE tree.id != tree.seed
		""", (json.dumps(sorted(seed_ids)),))
		for seed, sid, inp, out in rows:
			result.setdefault(seed, {})[sid] = (inp, out)
	except sqlite3.Error:
		# Legacy stores without the marker column keep the conversation's own counts rather than failing the listing.
		return {}
	return result


def card_rows(db, rows):
	"""Allowlisted card metadata; usage is summed once per native compression segment and delegated subagent session."""
	rows = list(rows)
	segment_ids = {sid for row in rows if row.get("_lineage_ids")
		for sid in [row["id"], *row["_lineage_ids"]]}
	segments = stored_rows(db, segment_ids) if segment_ids else {}
	subagents = card_subagent_usage(db, {row["id"] for row in rows} | segment_ids)
	tips = [segments.get(row["id"], {}) if row.get("_lineage_ids") else row for row in rows]
	providers = [card_provider(tip.get("model_config")) for tip in tips]
	# Explicit tip configuration wins over historical billing evidence; unresolved cards still need their complete lineage to detect conflicts.
	billing_ids = {sid for row, provider in zip(rows, providers) if provider is None
		for sid in [row["id"], *(row.get("_lineage_ids") or [])]}
	billing = card_billing_providers(db, billing_ids) if billing_ids else {}
	projects = card_projects(db) if rows else []
	result = []
	for row, tip, provider in zip(rows, tips, providers):
		chain = list(dict.fromkeys([row["id"], *(row.get("_lineage_ids") or [])]))
		compressed = bool(row.get("_lineage_ids"))
		usage = [segments.get(sid, {}) for sid in chain] if compressed else [row]
		# A subagent reached from several segments of this conversation counts once.
		children = {sid: counts for seed in chain for sid, counts in subagents.get(seed, {}).items() if sid not in chain}
		if provider is None:
			candidates = set().union(*(billing.get(sid, set()) for sid in chain))
			evidence = {name for segment in usage for name in (card_provider(segment.get("model_config")), provider_name(segment.get("billing_provider"))) if name}
			if len(candidates) == 1 and evidence <= candidates:
				provider = next(iter(candidates))
		counts = {}
		for index, key in enumerate(("input_tokens", "output_tokens")):
			values = [segment.get(key) for segment in usage] + [child[index] for child in children.values()]
			counts[key] = sum(values) if all(type(value) is int and value >= 0 for value in values) else None
		item = {k: row[k] for k in LIST_FIELDS if k in row}
		item["archived"] = bool(row.get("archived", False))
		item.update(project=card_project(row.get("cwd"), projects), provider=provider,
			model=tip.get("model"), source=tip.get("source", row.get("source")), **counts)
		item["total_tokens"] = counts["input_tokens"] + counts["output_tokens"] if all(value is not None for value in counts.values()) else None
		result.append(item)
	return result


def native_sessions(profile, offset, limit, organized_ids, archived_only=False):
	INTERNAL_LISTING_SOURCES = usage_history.internal_listing_sources()

	# Read-only SessionDB disables maintenance and history writes. Native rich
	# projection owns compression roots, project/branch inheritance and visibility.
	db = open_session_db(profile, read_only=True)
	try:
		# Native read-only SessionDB routes every _read_ctx through this same connection (no pooled readers). Keep admission, lookahead and card enrichment in one request-local snapshot so a concurrent archive/reset cannot invalidate exhaustion halfway through the response.
		# Adapters without a native connection retain the exact-ID fallback.
		connection = getattr(db, "_conn", None)
		snapshot = False
		if organized_ids and offset == 0 and not archived_only and isinstance(connection, sqlite3.Connection):
			connection.execute("BEGIN")
			snapshot = True
		page = db.list_sessions_rich(limit=limit, offset=offset, compact_rows=True, order_by_last_active=True, include_archived=False, archived_only=archived_only, include_hidden=False, exclude_sources=[*INTERNAL_LISTING_SOURCES, "cron"])
		rows = {row.get("_lineage_root_id") or row["id"]: row for row in page}
		# Organization may be stored under any native compression/reset alias,
		# not only the root used to deduplicate output. Cover newly backfilled
		# aliases too, so multiple organized segments do not repeat rich queries.
		covered = {sid for row in page for sid in
			(row["id"], row.get("_lineage_root_id"), *(row.get("_lineage_ids") or [])) if sid}
		if offset == 0 and not archived_only:
			pending = set(organized_ids) - covered
			# Native visibility/reset filtering happens before LIMIT and compression projection preserves row count, so a short initial page is complete.
			lookahead_matches, exhausted = {}, snapshot and len(page) < limit
			# Many retained archive/deleted IDs otherwise cause one full native
			# rich search each. Inspect ONE additional native page, not an
			# unbounded history scan or a raw-ID visibility approximation.
			if len(page) == limit and len(pending) >= 32:
				lookahead = db.list_sessions_rich(limit=500, offset=limit, compact_rows=True, order_by_last_active=True, include_archived=False, include_hidden=False, exclude_sources=[*INTERNAL_LISTING_SOURCES, "cron"])
				lookahead_matches = {sid: row for row in lookahead for sid in
					(row["id"], row.get("_lineage_root_id"), *(row.get("_lineage_ids") or [])) if sid in pending}
				# A short page exhausts this same native filtered listing. Full
				# pages retain exact-ID recovery beyond the bounded lookahead.
				exhausted = len(lookahead) < 500
			for sid in organized_ids:
				if sid in covered:
					continue
				# Preserve organized-ID insertion order for both lookup paths.
				# id_query is a substring query. Page its matches until the exact
				# alias is found; never silently lose a short/colliding stored ID.
				match_offset = 0
				while True:
					if sid in lookahead_matches:
						matches = [lookahead_matches[sid]]
					elif exhausted:
						break
					else:
						matches = db.list_sessions_rich(limit=500, offset=match_offset, id_query=sid, compact_rows=True, order_by_last_active=True, include_archived=False, include_hidden=False, exclude_sources=[*INTERNAL_LISTING_SOURCES, "cron"])
					found = False
					for row in matches:
						ids = {row["id"], row.get("_lineage_root_id"), *(row.get("_lineage_ids") or [])}
						if sid in ids:
							rows[row.get("_lineage_root_id") or row["id"]] = row
							covered.update(value for value in ids if value)
							found = True
					if found or len(matches) < 500:
						break
					match_offset += 500
		return {"sessions": card_rows(db, rows.values()),
			"offset": offset, "limit": limit, "has_more": len(page) == limit}
	finally:
		db.close()


def native_archives(profile, offset, limit):
	return native_sessions(profile, offset, limit, (), archived_only=True)


def native_archive(profile, session_id):
	"""Read an exact stored ID, never a title/key/substring or lineage alias."""

	db = open_session_db(profile, read_only=True)
	try:
		row = db.get_session(session_id)
		if row is None:
			raise HTTPException(404, "session_not_found")
		return {"id": session_id, "archived": bool(row["archived"])}
	finally:
		db.close()


def native_workspace(profile, session_id):
	"""Exact stored segment facts after a native move; no resume/title/alias resolution."""

	db = open_session_db(profile, read_only=True)
	try:
		row = db.get_session(session_id)
		if row is None:
			raise HTTPException(404, "session_not_found")
		return {"id": session_id, **{key: row.get(key) for key in ("cwd", "git_branch", "git_repo_root")},
			"project": card_project(row.get("cwd"), card_projects(db))}
	finally:
		db.close()


def native_control_guard(request, profile, unavailable):
	"""Require a real native actor with session control over exactly this served home.

	Hosted admission is not an actor; those topologies must use core HTTP itself.
	"""
	if getattr(request.state, "hosted_http_authenticated", None) is not None:
		raise HTTPException(503, unavailable)
	from hermes_constants import get_hermes_home
	from hermes_cli.web_server_sessions import _session_mutation_context

	home = get_hermes_home().resolve()
	authority, actor = _session_mutation_context(request, profile)
	if actor is None:
		raise HTTPException(503, unavailable)
	owner = Path(actor.profile_id)
	if not owner.is_absolute() or owner.resolve() != home:
		raise HTTPException(403, "profile_mismatch")
	native = getattr(request.state, "native_http_principal", None)
	if native is not None and native.get("profile_id") != str(home):
		raise HTTPException(403, "profile_mismatch")
	if "session:control" not in actor.capabilities:
		raise HTTPException(403, "permission_denied")
	if authority is not None and (authority.profile_id != str(home)
		or Path(authority.db.db_path).resolve().parent != home):
		raise HTTPException(403, "profile_mismatch")
	return authority


def native_title(profile, session_id):
	"""Exact read-only stored title; never resolve titles, prefixes or aliases."""

	db = open_session_db(profile, read_only=True)
	try:
		row = db.get_session(session_id)
		return None if row is None else row.get("title")
	finally:
		db.close()


def native_delete_snapshot(profile, session_id):
	"""Exact read-only CAS counters/absence; never resolve titles, prefixes or aliases."""

	return native_delete_snapshots(profile, [session_id])[0]


def native_delete_snapshots(profile, session_ids):
	"""native_delete_snapshot of each id, in order, through one opening of the store."""

	db = open_session_db(profile, read_only=True)
	try:
		snapshots = []
		for session_id in session_ids:
			row = db.get_session(session_id)
			snapshots.append({"session_id": session_id, "exists": row is not None,
				"runtime_revision": row["runtime_revision"] if row else 0,
				"runtime_generation": row["runtime_generation"] if row else None})
		return snapshots
	finally:
		db.close()


async def native_delete(request, profile, session_id, body):
	"""Delegate to core HTTP deletion, never legacy RPC or a second native writer.

	Core owns actor/history authorization, exact receipts, revision/generation,
	busy/lease/worker/lineage guards, owner forwarding and artifact cleanup.
	Hosted admission is not an actor; those topologies must use core HTTP itself.
	"""
	native_control_guard(request, profile, "native_delete_context_unavailable")
	from hermes_cli.web_routers.sessions import delete_session_endpoint

	result = await delete_session_endpoint(session_id=session_id, request=request, profile=profile,
		request_id=body.request_id, expected_revision=body.expected_revision,
		expected_generation=body.expected_generation)
	# Never equate a refreshed page/event with deletion. Validate the exact native
	# receipt, then independently read every returned ID in this same profile.
	absent = isinstance(result, dict) and result.get("already_absent") is True
	if not isinstance(result, dict) or result.get("ok") is not True:
		raise HTTPException(503, "native_delete_receipt_invalid")
	if absent:
		deleted_ids = [session_id]
	else:
		deleted_ids = result.get("deleted_ids")
		if (result.get("session_id") != session_id or result.get("operation") != "delete"
			or type(result.get("revision")) is not int or result["revision"] != body.expected_revision + 1
			or type(result.get("execution_generation")) is not int
			or result["execution_generation"] != body.expected_generation
			or not isinstance(deleted_ids, list) or session_id not in deleted_ids
			or any(not isinstance(sid, str) or re.fullmatch(SESSION_ID_PATTERN, sid) is None for sid in deleted_ids)
			or len(set(deleted_ids)) != len(deleted_ids)):
			raise HTTPException(503, "native_delete_receipt_invalid")
	snapshots = await asyncio.to_thread(native_delete_snapshots, profile, deleted_ids)
	if ([snapshot["session_id"] for snapshot in snapshots] != deleted_ids
		or any(snapshot["exists"] is not False for snapshot in snapshots)):
		raise HTTPException(503, "native_delete_verification_failed")
	# Allowlist the response: no native session payloads/configuration escape.
	value = {"ok": True, "profile": profile, "session_id": session_id,
		"request_id": body.request_id, "operation": "delete", "deleted_ids": deleted_ids,
		"already_absent": absent, "verified_absent": True}
	if not absent:
		value.update(revision=result["revision"], execution_generation=result["execution_generation"])
	return value


def native_drafts(profile, drafts):
	"""Attach each existing draft's project the way session cards get theirs; drafts stay listed when Hermes's catalog cannot be read."""
	if not any(draft["text"] is not None and draft["cwd"] for draft in drafts):
		return [{**draft, "project": None} for draft in drafts]
	try:
		db = open_session_db(profile)
		try:
			projects = card_projects(db)
		finally:
			db.close()
	except Exception:
		projects = []
	return [{**draft, "project": card_project(draft["cwd"], projects) if draft["text"] is not None and draft["cwd"] else None} for draft in drafts]


async def native_rename(request, profile, session_id, body):
	"""Rename stored history through core's authenticated HTTP rename, as the native sidebar does.

	The live-runtime RPC cannot reach a session without a runtime (typically archived or old
	history). A title write is idempotent, so a fresh request fenced on the current revision
	is safe to retry after an ambiguous failure; core still enforces owner and busy guards.
	"""
	native_control_guard(request, profile, "native_rename_context_unavailable")
	from hermes_cli.web_models import SessionRename
	from hermes_cli.web_routers.sessions import rename_session_endpoint

	snapshot = await asyncio.to_thread(native_delete_snapshot, profile, session_id)
	if snapshot["session_id"] != session_id or snapshot["exists"] is not True:
		raise HTTPException(404, "session_not_found")
	result = await rename_session_endpoint(session_id=session_id, request=request, body=SessionRename(
		title=body.title, request_id=f"t3sidebar-rename-{uuid.uuid4().hex}", profile=profile,
		expected_revision=snapshot["runtime_revision"], expected_generation=snapshot["runtime_generation"]))
	if not isinstance(result, dict) or result.get("ok") is not True or not isinstance(result.get("title"), str) or not result["title"]:
		raise HTTPException(503, "native_rename_receipt_invalid")
	# Core sanitizes titles (whitespace collapse), so verify the stored value against the receipt.
	title = await asyncio.to_thread(native_title, profile, session_id)
	if title != result["title"]:
		raise HTTPException(503, "native_rename_verification_failed")
	return {"ok": True, "profile": profile, "session_id": session_id, "title": title}


def create_router(path: Path | None = None, clock: Callable[[], float] = time.time, *, runtime_reader=None, sessions_reader=None, archives_reader=None, archive_reader=None, profile_reader=None, history_db_path=None, limits_path=None, limits_sampler=None, limits_redeemer=None, pool_credits_available=None) -> APIRouter:
	"""Inject a temporary path and clock for tests; production accepts neither over HTTP.

	``limits_sampler`` is a zero-argument starter returning the running sampler. Only the module-level production router passes one, so routers built by tests never sample live provider limits. ``limits_redeemer`` replaces the banked-reset redemption, so tests never reach Codex.
	"""
	api = APIRouter()
	# Exposed so tests can assert which router samples without starting it.
	api.t3sidebar_limits_sampler = limits_sampler

	def store():
		return HermesT3SidebarStore(path if path is not None else default_state_path(), clock)

	def drafts():
		return session_drafts.DraftStore(path if path is not None else default_state_path(), clock)

	def sampler():
		if limits_sampler is None:
			return None
		try:
			return limits_sampler()
		except Exception as exc:
			# Sampling is best-effort telemetry; it must never fail the sidebar request that happened to start it.
			log.debug("Limits sampler unavailable (%s)", type(exc).__name__)
			return None

	def listing_profile(request, allowed=()):
		if set(request.query_params) - {"profile", *allowed}:
			raise HTTPException(422, "Only current-profile listing parameters are accepted")
		# Desktop appends its route's profile at the transport layer. The host
		# mount has already established home; this is an assertion, not a selector.
		profile = (profile_reader or served_profile)()
		if any(value != profile for value in request.query_params.getlist("profile")):
			raise HTTPException(422, "Only current-profile listing parameters are accepted")
		return profile

	@api.get("/environment")
	def get_environment(request: Request, response: Response):
		response.headers["Cache-Control"] = "no-store"
		return {"profile": listing_profile(request), "home": str(Path.home())}

	@api.get("/runtime")
	async def get_runtime(request: Request, response: Response):
		response.headers["Cache-Control"] = "no-store"
		try:
			profile = listing_profile(request)
			# Desktop polls this route constantly, so the sampler starts with the first connected client after a backend restart and then keeps sampling while Desktop is closed.
			sampler()
			value = await (runtime_reader or native_runtime)(request, profile)
			return {**value, "profile": profile}
		except HTTPException:
			raise
		except Exception as exc:
			raise HTTPException(503, "native_runtime_unavailable") from exc

	@api.get("/sessions")
	def get_sessions(request: Request, response: Response, offset: int = Query(0, ge=0), limit: int = Query(500, ge=1, le=500)):
		response.headers["Cache-Control"] = "no-store"
		try:
			profile = listing_profile(request, ("offset", "limit"))
			if offset == 0:
				ids = store().organized_ids()
			else:
				ids = ()
			value = (sessions_reader or native_sessions)(profile, offset, limit, ids)
			return {**value, "profile": profile}
		except HTTPException:
			raise
		except Exception as exc:
			raise HTTPException(503, "native_session_listing_unavailable") from exc

	@api.get("/archives")
	def get_archives(request: Request, response: Response, offset: int = Query(0, ge=0), limit: int = Query(500, ge=1, le=500)):
		response.headers["Cache-Control"] = "no-store"
		try:
			profile = listing_profile(request, ("offset", "limit"))
			value = (archives_reader or native_archives)(profile, offset, limit)
			return {**value, "profile": profile}
		except HTTPException:
			raise
		except Exception as exc:
			raise HTTPException(503, "native_archive_listing_unavailable") from exc

	@api.get("/sessions/{session_id}/archive")
	def get_archive(session_id: SessionId, request: Request, response: Response):
		response.headers["Cache-Control"] = "no-store"
		try:
			profile = listing_profile(request)
			value = (archive_reader or native_archive)(profile, session_id)
			return {"profile": profile, "id": session_id, "archived": value["archived"]}
		except HTTPException:
			raise
		except Exception as exc:
			raise HTTPException(503, "native_archive_state_unavailable") from exc

	@api.get("/sessions/{session_id}/snapshot")
	def get_delete_snapshot(session_id: SessionId, request: Request, response: Response):
		response.headers["Cache-Control"] = "no-store"
		try:
			profile = listing_profile(request)
			return {**native_delete_snapshot(profile, session_id), "profile": profile}
		except HTTPException:
			raise
		except Exception as exc:
			raise HTTPException(503, "native_session_snapshot_unavailable") from exc

	@api.get("/sessions/{session_id}/workspace")
	def get_workspace(session_id: SessionId, request: Request, response: Response):
		response.headers["Cache-Control"] = "no-store"
		try:
			profile = listing_profile(request)
			return {**native_workspace(profile, session_id), "profile": profile}
		except HTTPException:
			raise
		except Exception as exc:
			raise HTTPException(503, "native_workspace_state_unavailable") from exc

	@api.post("/sessions/{session_id}/delete")
	async def delete_session(session_id: SessionId, body: SessionDelete, request: Request, response: Response):
		response.headers["Cache-Control"] = "no-store"
		try:
			profile = listing_profile(request)
			value = await native_delete(request, profile, session_id, body)
		except HTTPException:
			raise
		except Exception as exc:
			# Ambiguous failures must retain the original request for exact retry.
			raise HTTPException(503, "native_delete_unavailable") from exc
		try:
			# A deleted session's draft would otherwise come back as a card that reopens it in a new session.
			await asyncio.to_thread(drafts().delete, value["deleted_ids"])
		except Exception as exc:
			# The verified deletion is still reported as such; the drafts left behind are only logged.
			log.warning("Drafts of deleted sessions were not cleared (%s)", type(exc).__name__)
		try:
			# Otherwise read on every state poll, and kept as organised ids to backfill, for good.
			await asyncio.to_thread(store().forget, value["deleted_ids"])
		except Exception as exc:
			log.warning("Metadata of deleted sessions was not cleared (%s)", type(exc).__name__)
		return value

	@api.post("/drafts/sync")
	def sync_drafts(body: DraftSync, request: Request, response: Response):
		# One call per client every sync slot: its changes go up, everything changed since its cursor comes back.
		response.headers["Cache-Control"] = "no-store"
		try:
			profile = listing_profile(request)
			value = drafts().sync(body.since, [change.model_dump(exclude_none=True) for change in body.changes], body.sent_at)
			return {**value, "profile": profile, "drafts": native_drafts(profile, value["drafts"])}
		except HTTPException:
			raise
		except Exception as exc:
			raise HTTPException(503, "drafts_sync_failed") from exc

	@api.post("/sessions/{session_id}/title")
	async def rename_session(session_id: SessionId, body: SessionTitle, request: Request, response: Response):
		response.headers["Cache-Control"] = "no-store"
		try:
			profile = listing_profile(request)
			return await native_rename(request, profile, session_id, body)
		except HTTPException:
			raise
		except Exception as exc:
			raise HTTPException(503, "native_rename_unavailable") from exc

	@api.get("/state", response_model=FlowState)
	def get_state(request: Request, response: Response):
		response.headers["Cache-Control"] = "no-store"
		listing_profile(request)
		return store().state()

	@api.post("/sessions/{session_id}", response_model=FlowState)
	def update_session(session_id: SessionId, body: SessionAction, request: Request, response: Response):
		response.headers["Cache-Control"] = "no-store"
		profile = listing_profile(request)
		if body.action in ("pin", "snooze"):
			try:
				archive = (archive_reader or native_archive)(profile, session_id)
			except HTTPException:
				raise
			except Exception as exc:
				raise HTTPException(503, "native_archive_state_unavailable") from exc
			if archive.get("id") != session_id or type(archive.get("archived")) is not bool:
				raise HTTPException(503, "native_archive_state_unavailable")
			if archive["archived"]:
				raise HTTPException(409, "native_session_archived")
		return store().mutate(session_id, body)

	@api.get("/usage/history")
	async def get_usage_history(request: Request, response: Response, days: int = Query(7), tz: str = Query("UTC", min_length=1, max_length=64)):
		response.headers["Cache-Control"] = "no-store"
		profile = listing_profile(request, ("days", "tz"))
		db_path = history_db_path if history_db_path is not None else default_history_db_path(profile)
		try:
			# The first cold read takes about a second on a large store and Hermes pricing may load its catalog; keep it off the event loop.
			value = await asyncio.to_thread(usage_history.history_payload, db_path, days=days, tz=tz, now=clock())
		except ValueError as exc:
			raise HTTPException(422, str(exc)) from exc
		except Exception as exc:
			raise HTTPException(503, "usage_history_unavailable") from exc
		return {**value, "profile": profile}

	@api.get("/usage/limits")
	def get_usage_limits(request: Request, response: Response, hours: int = Query(168, ge=1, le=usage_limits.MAX_HOURS)):
		response.headers["Cache-Control"] = "no-store"
		profile = listing_profile(request, ("hours",))
		running = sampler()
		limits_store = usage_limits.LimitsStore(limits_path if limits_path is not None else default_limits_path(), clock)
		try:
			value = usage_limits.limits_payload(limits_store, hours=hours, now=clock(), sampler_status=running.status() if running is not None else None)
		except ValueError as exc:
			raise HTTPException(422, str(exc)) from exc
		except Exception as exc:
			raise HTTPException(503, "usage_limits_unavailable") from exc
		return {**value, "profile": profile}

	# Experimental features by wire name: their store key and whether this Hermes still has the internals they need. Availability is per feature, so one missing internal never turns off the others.
	experimental = {
		"pool_credits": (usage_limits.POOL_CREDITS_SETTING, pool_credits_available or usage_limits.pool_credits_available),
	}

	def experimental_state():
		limits_store = usage_limits.LimitsStore(limits_path if limits_path is not None else default_limits_path(), clock)
		features = {}
		for name, (key, available) in experimental.items():
			ok = bool(available())
			# Without its internals a feature is off whatever was saved, and comes back on if a later Hermes restores them.
			features[name] = {"enabled": ok and limits_store.read_setting(key), "available": ok}
		return {"features": features}

	@api.get("/settings/experimental")
	def get_experimental(request: Request, response: Response):
		response.headers["Cache-Control"] = "no-store"
		profile = listing_profile(request)
		try:
			value = experimental_state()
		except Exception as exc:
			raise HTTPException(503, "settings_unavailable") from exc
		return {**value, "profile": profile}

	@api.put("/settings/experimental/{feature}")
	def put_experimental(feature: str, body: ExperimentalToggle, request: Request, response: Response):
		response.headers["Cache-Control"] = "no-store"
		profile = listing_profile(request)
		if feature not in experimental:
			raise HTTPException(404, "unknown_feature")
		key, available = experimental[feature]
		if body.enabled and not available():
			raise HTTPException(409, "incompatible_hermes")
		try:
			usage_limits.LimitsStore(limits_path if limits_path is not None else default_limits_path(), clock).write_setting(key, body.enabled)
			# The other mode's credit lists are due at once instead of after the hourly throttle.
			usage_limits.forget_credit_reads()
			value = experimental_state()
		except Exception as exc:
			raise HTTPException(503, "settings_unavailable") from exc
		return {**value, "profile": profile}

	@api.post("/usage/limits/redeem")
	async def redeem_banked_reset(body: BankedResetRedeem, request: Request, response: Response):
		response.headers["Cache-Control"] = "no-store"
		profile = listing_profile(request)
		try:
			# Hermes's redemption makes two blocking HTTP calls to Codex.
			value = await asyncio.to_thread(limits_redeemer or (lambda account: banked_reset.redeem(account, limits=usage_limits)), body.account)
		except LookupError as exc:
			raise HTTPException(404, "account_not_found") from exc
		except banked_reset.Busy as exc:
			raise HTTPException(409, "redeem_in_progress") from exc
		except Exception as exc:
			raise HTTPException(503, "redeem_unavailable") from exc
		running = sampler()
		if value.get("status") in banked_reset.REDEEMED and running is not None:
			try:
				# Record the account's new reading now, so the page's next read shows the reset instead of waiting for the five-minute tick.
				await asyncio.to_thread(running.run_once)
			except Exception:
				pass
		return {**value, "profile": profile}

	return api


router = create_router(limits_sampler=ensure_limits_sampler)
