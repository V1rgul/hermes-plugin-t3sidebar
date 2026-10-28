"""Plugin-owned completion markers, durable content-free delivery receipts and current turn start times.

Only an authenticated lifecycle caller may record a completion. This module knows nothing about native session databases, HTTP, prompts or model output.
"""

import math
from pathlib import Path
import re
import sqlite3
import time


SESSION_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$"


def validate_session_id(value):
    if type(value) is not str or re.fullmatch(SESSION_ID_PATTERN, value) is None:
        raise ValueError("invalid session id")
    return value


def validate_done_token(value):
    if type(value) is not str or not 1 <= len(value) <= 256:
        raise ValueError("done_token must be a nonempty string of at most 256 characters")
    return value


class CompletionStore:
    """Serialize producers with API writers in the profile's plugin SQLite file."""

    def __init__(self, path, clock=time.time):
        self.path = Path(path)
        self.clock = clock

    @staticmethod
    def ensure_schema(connection):
        # Do not use executescript: it can commit the caller's transaction.
        connection.execute("""
            CREATE TABLE IF NOT EXISTS session_completions (
                session_id TEXT PRIMARY KEY,
                done_at REAL NOT NULL CHECK (done_at > 0),
                done_token TEXT NOT NULL CHECK (length(done_token) BETWEEN 1 AND 256)
            )
        """)
        connection.execute("""
            CREATE TABLE IF NOT EXISTS completion_receipts (
                session_id TEXT NOT NULL,
                turn_id TEXT NOT NULL CHECK (length(turn_id) BETWEEN 1 AND 256),
                PRIMARY KEY (session_id, turn_id)
            )
        """)
        # Latest human turn per conversation root. started_at is when the user's work began, kept across automatic wake-ups. It outlives the turn (ended_at) so a parent kept Working by its subagents still has a start to count from; pending records that the turn ended with background work that will wake the conversation again.
        connection.execute("""
            CREATE TABLE IF NOT EXISTS session_runs (
                session_id TEXT PRIMARY KEY,
                started_at REAL NOT NULL CHECK (started_at > 0),
                ended_at REAL CHECK (ended_at IS NULL OR ended_at > 0),
                turn_id TEXT NOT NULL CHECK (length(turn_id) BETWEEN 1 AND 256),
                pending INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0, 1))
            )
        """)
        if "pending" not in {row[1] for row in connection.execute("PRAGMA table_info(session_runs)")}:
            connection.execute("ALTER TABLE session_runs ADD COLUMN pending INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0, 1))")

    @staticmethod
    def read(connection):
        """Read markers only, using the caller's existing transaction/snapshot."""
        return {
            sid: {"done_at": done_at, "done_token": token}
            for sid, done_at, token in connection.execute(
                "SELECT session_id, done_at, done_token FROM session_completions ORDER BY session_id"
            )
        }

    @staticmethod
    def read_runs(connection):
        """Turn start/end times only; turn identities stay backend-private."""
        return {
            sid: {"started_at": started_at, "ended_at": ended_at, "pending": bool(pending)}
            for sid, started_at, ended_at, pending in connection.execute(
                "SELECT session_id, started_at, ended_at, pending FROM session_runs ORDER BY session_id")
        }

    def _write(self, statement, parameters):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        try:
            connection.execute("BEGIN IMMEDIATE")
            self.ensure_schema(connection)
            changed = connection.execute(statement, parameters).rowcount
            connection.execute("COMMIT")
            return changed
        except BaseException:
            if connection.in_transaction:
                connection.execute("ROLLBACK")
            raise
        finally:
            connection.close()

    def begin_run(self, session_id, turn_id, started_at, heartbeat_fired_at=None):
        """A newer turn replaces the conversation's previous turn, and restarts the work time unless it is a wake-up.

        A wake-up follows a turn that ended with background work pending, or a heartbeat fired since that turn ended.
        A previous turn that never ended (its runtime skipped the end hook) is no evidence of either.
        """
        validate_session_id(session_id)
        validate_done_token(turn_id)
        if type(started_at) is not float or not math.isfinite(started_at) or started_at <= 0:
            raise ValueError("started_at must be a positive finite UTC epoch timestamp")
        if heartbeat_fired_at is not None and (type(heartbeat_fired_at) is not float or not math.isfinite(heartbeat_fired_at)):
            raise ValueError("heartbeat_fired_at must be a finite UTC epoch timestamp")
        self._write("""
            INSERT INTO session_runs (session_id, started_at, ended_at, turn_id, pending) VALUES (?, ?, NULL, ?, 0)
            ON CONFLICT(session_id) DO UPDATE SET
                started_at = CASE WHEN session_runs.ended_at IS NOT NULL AND (session_runs.pending = 1 OR ? > session_runs.ended_at)
                    THEN session_runs.started_at ELSE excluded.started_at END,
                ended_at = NULL, pending = 0, turn_id = excluded.turn_id
        """, (session_id, started_at, turn_id, heartbeat_fired_at))

    def end_run(self, turn_id, pending=False):
        """End only this exact turn, so a racing next turn stays open; return whether it was open."""
        validate_done_token(turn_id)
        if type(pending) is not bool:
            raise ValueError("pending must be a bool")
        now = float(self.clock())
        if not math.isfinite(now) or now <= 0:
            raise ValueError("clock must return a positive finite UTC epoch timestamp")
        return self._write("UPDATE session_runs SET ended_at = ?, pending = ? WHERE turn_id = ? AND ended_at IS NULL",
            (now, int(pending), turn_id)) > 0

    @staticmethod
    def acknowledge(connection, session_id, done_token):
        """Exact generation CAS; never delete the durable delivery receipt."""
        validate_session_id(session_id)
        validate_done_token(done_token)
        return connection.execute(
            "DELETE FROM session_completions WHERE session_id = ? AND done_token = ?",
            (session_id, done_token),
        ).rowcount == 1

    def record(self, session_id, turn_id):
        """Record once per turn, even after acknowledgement; return whether new.

        A new turn supersedes the current marker. Replayed old turns cannot overwrite newer markers or resurrect an acknowledged completion.
        """
        validate_session_id(session_id)
        validate_done_token(turn_id)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        try:
            connection.execute("BEGIN IMMEDIATE")
            self.ensure_schema(connection)
            inserted = connection.execute(
                "INSERT INTO completion_receipts (session_id, turn_id) VALUES (?, ?) "
                "ON CONFLICT(session_id, turn_id) DO NOTHING",
                (session_id, turn_id),
            ).rowcount == 1
            if inserted:
                now = float(self.clock())
                if not math.isfinite(now) or now <= 0:
                    raise ValueError("clock must return a positive finite UTC epoch timestamp")
                connection.execute("""
                    INSERT INTO session_completions (session_id, done_at, done_token) VALUES (?, ?, ?)
                    ON CONFLICT(session_id) DO UPDATE SET
                        done_at = excluded.done_at, done_token = excluded.done_token
                """, (session_id, now, turn_id))
            connection.execute("COMMIT")
            return inserted
        except BaseException:
            if connection.in_transaction:
                connection.execute("ROLLBACK")
            raise
        finally:
            connection.close()
