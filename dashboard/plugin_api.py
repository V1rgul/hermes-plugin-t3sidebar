"""hermes-t3sidebar metadata, native listings and sanctioned native deletion.

The host mounts ``router`` in its authenticated /api/plugins/hermes-t3sidebar namespace.
This module is self-contained because Hermes loads it directly via importlib.
"""

import asyncio
import importlib.util
import json
import math
from pathlib import Path
import re
import sqlite3
import time
from typing import Annotated, Callable, Literal

from types import SimpleNamespace
from fastapi import APIRouter, HTTPException, Path as PathParameter, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


# Dashboard loads this file directly, without a reliable package name. Load exactly our fixed sibling ledger; no request or profile value controls code.
_completion_spec = importlib.util.spec_from_file_location(
	"hermes_t3sidebar_completion_state", Path(__file__).resolve().parents[1] / "completion_state.py")
assert _completion_spec is not None and _completion_spec.loader is not None
_completion_module = importlib.util.module_from_spec(_completion_spec)
_completion_spec.loader.exec_module(_completion_module)
CompletionStore = _completion_module.CompletionStore


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


class FlowState(BaseModel):
	version: Literal[1] = 1
	sessions: dict[str, SessionMetadata]
	completions: dict[str, CompletionMetadata] = Field(default_factory=dict)


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
						return self._state_rows(rows, completions)
			finally:
				connection.close()
		return self._transaction()

	@staticmethod
	def _state_rows(rows, completions) -> dict:
		result = {"version": 1, "sessions": {}, "completions": completions}
		for row in rows:
			metadata = dict(row)
			key = metadata.pop("session_id")
			metadata["pinned"] = bool(metadata["pinned"])
			result["sessions"][key] = metadata
		return result

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
			result = self._state_rows(rows, CompletionStore.read(connection))
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
	except Exception:
		# Older cores, stale objects and failed projections are unknown per row.
		return None


def runtime_retired(db, row):
	"""A missing row can be an unsaved draft; only native retirement proves deletion."""
	from hermes_state_mutation_retirement import retired_session

	return any(retired_session(db, sid) for sid in {row.get("session_key"), row.get("id")} if sid)


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
	from hermes_cli.web_server_sessions import _open_session_db_for_profile
	from hermes_state_sessions import INTERNAL_LISTING_SOURCES

	facts, parents = {}, {}

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
		# The native mapper can read titles from SQLite. It must run outside
		# the global registry lock, just like catalog/default-route/lineage IO.
		item = server._session_live_item(sid, session, current)
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
	if not rows:
		return {"sessions": []}
	# Persisted source facts win; native empty drafts have no DB row yet, so retain their source captured during the same exact-home native mapping.
	db = _open_session_db_for_profile(profile, read_only=True)
	try:
		if Path(db.db_path).resolve().parent != home:
			raise HTTPException(403, "profile_mismatch")
		stored = db._get_session_rich_rows_batch({row["session_key"] for row in rows}, compact_rows=True)
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
			if source.strip().lower() in {*INTERNAL_LISTING_SOURCES, "cron"}:
				continue
			item = {k: row[k] for k in ("id", "session_key", "status", "current", "last_active", "started_at", "model", "title")}
			item["message_count"] = runtime_message_count(
				row.get("message_count") if captured["history_known"] else None,
				record.get("message_count") if record else None)
			metadata = runtime_display_metadata(server, captured, projects)
			# Native legacy previews may contain pending prompts. Runtime needs
			# liveness/identity only; do not return that text or any extra fields.
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
	from hermes_state_sessions import INTERNAL_LISTING_SOURCES

	with_db = SessionDB(db_path, read_only=True)
	try:
		rows = [row for row in rows if row.get("source") not in {*INTERNAL_LISTING_SOURCES, "cron"}
			and not runtime_retired(with_db, row)]
		stored = with_db._get_session_rich_rows_batch(
			{row.get("session_key") or row["id"] for row in rows}, compact_rows=True)
		projects = card_projects(with_db) if rows else []
		result = []
		for row in rows:
			record = stored.get(row.get("session_key") or row["id"], {})
			item = {k: v for k, v in row.items() if k in RUNTIME_FIELDS}
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
	from gateway.session_contract import Principal, SessionRef

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
	reader = Principal(actor.subject, actor.profile_id, frozenset({"session:read"}), actor.transport_id)
	connection = SimpleNamespace(authority=authority, actor=reader)
	value = await active_list(connection, None, {})
	value["sessions"] = await asyncio.to_thread(authority_runtime_rows, db_path, value["sessions"])
	for row in value["sessions"]:
		row["running_subagents"] = None
		try:
			from gateway.session_ancillary import read

			projection = await read(connection, SessionRef(reader.profile_id, row["id"]),
				{"session_id": row["id"], "profile": profile}, kind="subagents")
			row["running_subagents"] = running_subagent_count(projection.get("subagents"))
		except Exception:
			# Unsupported worker projections, stale generations, missing seams or
			# authority failures cannot turn unknown into idle or retain an old count.
			# Cancellation (BaseException) still cancels the request.
			pass
	return value


LIST_FIELDS = frozenset({"id", "source", "archived", "resolved_id", "title", "preview", "cwd", "git_branch", "git_repo_root",
	"last_active", "started_at", "updated_at", "message_count", "unread", "_lineage_root_id", "_lineage_ids"})


def card_projects(db):
	"""Read this SessionDB's catalog once, without schema initialization or home lookup."""
	from hermes_cli import projects_db

	db_path = getattr(db, "db_path", None)
	if db_path is None:
		return []
	path = Path(db_path).resolve().parent / "projects.db"
	if not path.is_file():
		return []
	try:
		connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
		try:
			connection.row_factory = sqlite3.Row
			return projects_db.list_projects(connection, include_archived=False)
		finally:
			connection.close()
	except sqlite3.Error:
		# Missing/legacy/unreadable catalogs must not trigger migrations or hide chats.
		return []


def card_project(cwd, projects):
	from hermes_cli.projects_db import _normalize_path

	if not isinstance(cwd, str) or not cwd.strip():
		return {"id": "__no_project__", "name": "Home", "icon": None, "color": None, "cwd": None, "is_home": True}
	target = _normalize_path(cwd)
	# Match project_for_path's longest owning folder, including secondary folders.
	owners = [(folder.path, project) for project in projects for folder in project.folders
		if target == folder.path or target.startswith(folder.path.rstrip("/\\") + "/")]
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
	"""Read main-loop route evidence in bounded batches, never auxiliary model usage."""
	connection = getattr(db, "_conn", None)
	if not isinstance(connection, sqlite3.Connection):
		return {}
	ids, result = sorted(session_ids), {}
	try:
		for start in range(0, len(ids), 500):
			batch = ids[start:start + 500]
			placeholders = ",".join("?" for _ in batch)
			rows = connection.execute(f"SELECT DISTINCT session_id, billing_provider FROM session_model_usage WHERE task = '' AND session_id IN ({placeholders})", batch)
			for sid, value in rows:
				if provider := provider_name(value):
					result.setdefault(sid, set()).add(provider)
	except sqlite3.Error:
		# Older stores may have no task-attributed usage table; unknown is safer than a guess.
		return {}
	return result


def card_rows(db, rows):
	"""Allowlisted card metadata; compression usage is summed once per native segment."""
	rows = list(rows)
	segment_ids = {sid for row in rows if row.get("_lineage_ids")
		for sid in [row["id"], *row["_lineage_ids"]]}
	segments = db._get_session_rich_rows_batch(segment_ids, compact_rows=True) if segment_ids else {}
	billing = card_billing_providers(db, segment_ids | {row["id"] for row in rows})
	projects = card_projects(db) if rows else []
	result = []
	for row in rows:
		chain = list(dict.fromkeys([row["id"], *(row.get("_lineage_ids") or [])]))
		compressed = bool(row.get("_lineage_ids"))
		tip = segments.get(row["id"], {}) if compressed else row
		usage = [segments.get(sid, {}) for sid in chain] if compressed else [row]
		provider = card_provider(tip.get("model_config"))
		if provider is None:
			candidates = set().union(*(billing.get(sid, set()) for sid in chain))
			evidence = {name for segment in usage for name in (card_provider(segment.get("model_config")), provider_name(segment.get("billing_provider"))) if name}
			if len(candidates) == 1 and evidence <= candidates:
				provider = next(iter(candidates))
		counts = {}
		for key in ("input_tokens", "output_tokens"):
			values = [segment.get(key) for segment in usage]
			counts[key] = sum(values) if all(type(value) is int and value >= 0 for value in values) else None
		item = {k: v for k, v in row.items() if k in LIST_FIELDS}
		item["archived"] = bool(row.get("archived", False))
		item.update(project=card_project(row.get("cwd"), projects), provider=provider,
			model=tip.get("model"), source=tip.get("source", row.get("source")), **counts)
		item["total_tokens"] = counts["input_tokens"] + counts["output_tokens"] if all(value is not None for value in counts.values()) else None
		result.append(item)
	return result


def native_sessions(profile, offset, limit, organized_ids, archived_only=False):
	from hermes_cli.web_server_sessions import _open_session_db_for_profile
	from hermes_state_sessions import INTERNAL_LISTING_SOURCES

	# Read-only SessionDB disables maintenance and history writes. Native rich
	# projection owns compression roots, project/branch inheritance and visibility.
	db = _open_session_db_for_profile(profile, read_only=True)
	try:
		page = db.list_sessions_rich(limit=limit, offset=offset, compact_rows=True, order_by_last_active=True, include_archived=False, archived_only=archived_only, include_hidden=False, exclude_sources=[*INTERNAL_LISTING_SOURCES, "cron"])
		rows = {row.get("_lineage_root_id") or row["id"]: row for row in page}
		# Organization may be stored under any native compression/reset alias,
		# not only the root used to deduplicate output. Cover newly backfilled
		# aliases too, so multiple organized segments do not repeat rich queries.
		covered = {sid for row in page for sid in
			(row["id"], row.get("_lineage_root_id"), *(row.get("_lineage_ids") or [])) if sid}
		if offset == 0 and not archived_only:
			pending = set(organized_ids) - covered
			lookahead_matches, exhausted = {}, False
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
	from hermes_cli.web_server_sessions import _open_session_db_for_profile

	db = _open_session_db_for_profile(profile, read_only=True)
	try:
		row = db._get_session_rich_rows_batch([session_id], compact_rows=True).get(session_id)
		if row is None:
			raise HTTPException(404, "session_not_found")
		return {"id": session_id, "archived": bool(row["archived"])}
	finally:
		db.close()


def native_workspace(profile, session_id):
	"""Exact stored segment facts after a native move; no resume/title/alias resolution."""
	from hermes_cli.web_server_sessions import _open_session_db_for_profile

	db = _open_session_db_for_profile(profile, read_only=True)
	try:
		row = db._get_session_rich_rows_batch([session_id], compact_rows=True).get(session_id)
		if row is None:
			raise HTTPException(404, "session_not_found")
		return {"id": session_id, **{key: row.get(key) for key in ("cwd", "git_branch", "git_repo_root")},
			"project": card_project(row.get("cwd"), card_projects(db))}
	finally:
		db.close()


def native_delete_snapshot(profile, session_id):
	"""Exact read-only CAS counters/absence; never resolve titles, prefixes or aliases."""
	from hermes_cli.web_server_sessions import _open_session_db_for_profile

	db = _open_session_db_for_profile(profile, read_only=True)
	try:
		row = db.get_session(session_id)
		return {"session_id": session_id, "exists": row is not None,
			"runtime_revision": row["runtime_revision"] if row else 0,
			"runtime_generation": row["runtime_generation"] if row else None}
	finally:
		db.close()


async def native_delete(request, profile, session_id, body):
	"""Delegate to core HTTP deletion, never legacy RPC or a second native writer.

	Core owns actor/history authorization, exact receipts, revision/generation,
	busy/lease/worker/lineage guards, owner forwarding and artifact cleanup.
	Hosted admission is not an actor; those topologies must use core HTTP itself.
	"""
	if getattr(request.state, "hosted_http_authenticated", None) is not None:
		raise HTTPException(503, "native_delete_context_unavailable")
	from hermes_constants import get_hermes_home
	from hermes_cli.web_server_sessions import _session_mutation_context, _session_db_path_for_profile
	from hermes_cli.web_routers.sessions import delete_session_endpoint

	home = get_hermes_home().resolve()
	# A matching display name is not enough: check core's actual store resolution.
	if _session_db_path_for_profile(profile).resolve().parent != home:
		raise HTTPException(403, "profile_mismatch")
	authority, actor = _session_mutation_context(request, profile)
	if actor is None:
		raise HTTPException(503, "native_delete_context_unavailable")
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
	for sid in deleted_ids:
		snapshot = await asyncio.to_thread(native_delete_snapshot, profile, sid)
		if snapshot["session_id"] != sid or snapshot["exists"] is not False:
			raise HTTPException(503, "native_delete_verification_failed")
	# Allowlist the response: no native session payloads/configuration escape.
	value = {"ok": True, "profile": profile, "session_id": session_id,
		"request_id": body.request_id, "operation": "delete", "deleted_ids": deleted_ids,
		"already_absent": absent, "verified_absent": True}
	if not absent:
		value.update(revision=result["revision"], execution_generation=result["execution_generation"])
	return value


def create_router(path: Path | None = None, clock: Callable[[], float] = time.time, *, runtime_reader=None, sessions_reader=None, archives_reader=None, archive_reader=None, profile_reader=None) -> APIRouter:
	"""Inject a temporary path and clock for tests; production accepts neither over HTTP."""
	api = APIRouter()

	def store():
		return HermesT3SidebarStore(path if path is not None else default_state_path(), clock)

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
				state = store().state()
				ids = tuple(sorted(state["sessions"].keys() | state["completions"].keys()))
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
			return await native_delete(request, profile, session_id, body)
		except HTTPException:
			raise
		except Exception as exc:
			# Ambiguous failures must retain the original request for exact retry.
			raise HTTPException(503, "native_delete_unavailable") from exc

	@api.get("/state", response_model=FlowState)
	def get_state(response: Response):
		response.headers["Cache-Control"] = "no-store"
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

	return api


router = create_router()
