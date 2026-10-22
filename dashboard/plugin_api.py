"""Session Flow metadata and narrowly scoped native read-only listings.

The host mounts ``router`` in its authenticated /api/plugins/session-flow namespace.
This module is self-contained because Hermes loads it directly via importlib.
"""

import math
from pathlib import Path
import re
import sqlite3
import time
from typing import Annotated, Callable, Literal

from types import SimpleNamespace
from fastapi import APIRouter, HTTPException, Path as PathParameter, Query, Request, Response
from pydantic import BaseModel, ConfigDict, field_validator, model_validator


SESSION_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$"
SessionId = Annotated[str, PathParameter(pattern=SESSION_ID_PATTERN, max_length=256)]
Action = Literal["settle", "restore", "snooze", "pin", "unpin"]


class SessionAction(BaseModel):
	model_config = ConfigDict(extra="forbid", strict=True)

	action: Action
	wake_at: float | None = None

	@field_validator("wake_at", mode="before")
	@classmethod
	def numeric_timestamp(cls, value):
		if value is None:
			return value
		# Reject booleans and numeric strings; avoid non-finite values appearing
		# inside FastAPI's JSON validation error payload (JSON cannot encode NaN).
		try:
			valid = type(value) in (int, float) and math.isfinite(value)
		except (OverflowError, TypeError):
			valid = False
		if not valid:
			raise HTTPException(422, "wake_at must be a finite JSON number")
		return value

	@model_validator(mode="after")
	def wake_only_for_snooze(self):
		if self.action == "snooze":
			if self.wake_at is None:
				raise ValueError("snooze requires wake_at")
		elif "wake_at" in self.model_fields_set:
			raise ValueError("wake_at is only valid for snooze")
		return self


class SessionMetadata(BaseModel):
	state: Literal["active", "settled", "snoozed"]
	settled_at: float | None
	wake_at: float | None
	pinned: bool
	updated_at: float


class FlowState(BaseModel):
	version: Literal[1] = 1
	sessions: dict[str, SessionMetadata]


def default_state_path() -> Path:
	# Resolve on each request, not import: Hermes can scope the active home
	# with contextvars when dispatching to a profile's plugin namespace.
	from hermes_constants import get_hermes_home

	return get_hermes_home() / "plugin-data" / "session-flow" / "state.sqlite3"


class SessionFlowStore:
	"""Short-lived per-operation connections; SQLite serializes writers.

	Every read/mutation and due-wakeup sweep shares one IMMEDIATE transaction.
	There are no threads or timers owned by the plugin. Wake eligibility is
	computed from UTC epoch seconds even after the app/backend was closed.
	"""

	def __init__(self, path: Path, clock: Callable[[], float] = time.time):
		self.path = Path(path)
		self.clock = clock

	def state(self) -> dict:
		return self._transaction()

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
					CHECK (
						(state = 'active' AND settled_at IS NULL AND wake_at IS NULL) OR
						(state = 'settled' AND settled_at IS NOT NULL AND wake_at IS NULL) OR
						(state = 'snoozed' AND settled_at IS NULL AND wake_at IS NOT NULL)
					)
				)
			""")
			# updated_at is the wake instant, not the time somebody next opens
			# Desktop. Reading late does not change effective wake chronology.
			connection.execute("""
				UPDATE session_metadata
				SET state = 'active', settled_at = NULL, updated_at = wake_at, wake_at = NULL
				WHERE state = 'snoozed' AND wake_at <= ?
			""", (now,))
			if body is not None:
				connection.execute("""
					INSERT INTO session_metadata VALUES (?, 'active', NULL, NULL, 0, ?)
					ON CONFLICT(session_id) DO NOTHING
				""", (session_id, now))
				if body.action == "settle":
					connection.execute("""
						UPDATE session_metadata SET state = 'settled', settled_at = ?,
						wake_at = NULL, updated_at = ? WHERE session_id = ?
					""", (now, now, session_id))
				elif body.action == "restore":
					connection.execute("""
						UPDATE session_metadata SET state = 'active', settled_at = NULL,
						wake_at = NULL, updated_at = ? WHERE session_id = ?
					""", (now, session_id))
				elif body.action == "snooze":
					connection.execute("""
						UPDATE session_metadata SET state = 'snoozed', settled_at = NULL,
						wake_at = ?, updated_at = ? WHERE session_id = ?
					""", (body.wake_at, now, session_id))
				else:
					connection.execute("""
						UPDATE session_metadata SET pinned = ?, updated_at = ? WHERE session_id = ?
					""", (int(body.action == "pin"), now, session_id))
			rows = connection.execute("SELECT * FROM session_metadata ORDER BY session_id").fetchall()
			result = {"version": 1, "sessions": {}}
			for row in rows:
				metadata = dict(row)
				key = metadata.pop("session_id")
				metadata["pinned"] = bool(metadata["pinned"])
				result["sessions"][key] = metadata
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


async def native_runtime(request, profile):
	# Version-sensitive native boundary: reuse authenticated authority + native
	# read protocol, never the process-wide legacy sidecar registry.
	from hermes_cli.web_server_sessions import _session_mutation_context
	from gateway.session_active_list import active_list
	from gateway.session_contract import Principal

	authority, actor = _session_mutation_context(request, profile)
	if authority is None:
		raise HTTPException(503, "session_authority_unavailable")
	reader = Principal(actor.subject, actor.profile_id, frozenset({"session:read"}), actor.transport_id)
	return await active_list(SimpleNamespace(authority=authority, actor=reader), None, {})


LIST_FIELDS = frozenset({"id", "resolved_id", "title", "preview", "cwd", "git_branch", "git_repo_root",
	"last_active", "started_at", "updated_at", "unread", "_lineage_root_id", "_lineage_ids"})


def native_sessions(profile, offset, limit, organized_ids):
	from hermes_cli.web_server_sessions import _open_session_db_for_profile
	from hermes_state_sessions import INTERNAL_LISTING_SOURCES

	# Read-only SessionDB disables maintenance and history writes. Native rich
	# projection owns compression roots, project/branch inheritance and visibility.
	db = _open_session_db_for_profile(profile, read_only=True)
	try:
		page = db.list_sessions_rich(limit=limit, offset=offset, compact_rows=True, order_by_last_active=True, include_archived=False, include_hidden=False, exclude_sources=list(INTERNAL_LISTING_SOURCES))
		rows = {row.get("_lineage_root_id") or row["id"]: row for row in page}
		if offset == 0:
			for sid in organized_ids:
				if sid in rows:
					continue
				# id_query is a substring query. Page its matches until the exact
				# alias is found; never silently lose a short/colliding stored ID.
				match_offset = 0
				while True:
					matches = db.list_sessions_rich(limit=500, offset=match_offset, id_query=sid, compact_rows=True, order_by_last_active=True, include_archived=False, include_hidden=False, exclude_sources=list(INTERNAL_LISTING_SOURCES))
					found = False
					for row in matches:
						ids = {row["id"], row.get("_lineage_root_id"), *(row.get("_lineage_ids") or [])}
						if sid in ids:
							rows[row.get("_lineage_root_id") or row["id"]] = row
							found = True
					if found or len(matches) < 500:
						break
					match_offset += 500
		return {"sessions": [{k: v for k, v in row.items() if k in LIST_FIELDS} for row in rows.values()],
			"offset": offset, "limit": limit, "has_more": len(page) == limit}
	finally:
		db.close()


def create_router(path: Path | None = None, clock: Callable[[], float] = time.time, *, runtime_reader=None, sessions_reader=None, profile_reader=None) -> APIRouter:
	"""Inject a temporary path and clock for tests; production accepts neither over HTTP."""
	api = APIRouter()

	def store():
		return SessionFlowStore(path if path is not None else default_state_path(), clock)

	def listing_profile(request, allowed=()):
		if set(request.query_params) - set(allowed):
			raise HTTPException(422, "Only current-profile listing parameters are accepted")
		return (profile_reader or served_profile)()

	@api.get("/runtime")
	async def get_runtime(request: Request, response: Response):
		response.headers["Cache-Control"] = "no-store"
		try:
			profile = listing_profile(request)
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
			ids = tuple(store().state()["sessions"]) if offset == 0 else ()
			value = (sessions_reader or native_sessions)(profile, offset, limit, ids)
			return {**value, "profile": profile}
		except HTTPException:
			raise
		except Exception as exc:
			raise HTTPException(503, "native_session_listing_unavailable") from exc

	@api.get("/state", response_model=FlowState)
	def get_state(response: Response):
		response.headers["Cache-Control"] = "no-store"
		return store().state()

	@api.post("/sessions/{session_id}", response_model=FlowState)
	def update_session(session_id: SessionId, body: SessionAction, response: Response):
		response.headers["Cache-Control"] = "no-store"
		return store().mutate(session_id, body)

	return api


router = create_router()
