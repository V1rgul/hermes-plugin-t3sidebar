"""Plugin-owned completion markers and durable, content-free delivery receipts.

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
