"""Shared backend markers: scratch SQLite, offline producers and independent apps."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import ast
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from test_backend import ROOT, backend


SPEC = importlib.util.spec_from_file_location("completion_ledger_test", ROOT / "completion_state.py")
assert SPEC is not None and SPEC.loader is not None
ledger = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ledger)
CompletionStore = ledger.CompletionStore


class CompletionTests(unittest.TestCase):
    def setUp(self):
        archive = patch.object(backend, "native_archive", side_effect=lambda profile, sid: {"id": sid, "archived": False})
        archive.start()
        self.addCleanup(archive.stop)
        self.temp = tempfile.TemporaryDirectory(prefix="t3sidebar-completion-")
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "profile/plugin-data/hermes-t3sidebar/state.sqlite3"
        self.now = 1800000000.25
        self.producer = CompletionStore(self.path, lambda: self.now)

    def client(self, **kwargs):
        app = FastAPI()
        app.include_router(backend.create_router(self.path, lambda: self.now, **kwargs))
        client = TestClient(app)
        self.addCleanup(client.close)
        return client

    def state(self, client):
        response = client.get("/state")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["cache-control"], "no-store")
        return response.json()

    def act(self, client, action, session="same", **kwargs):
        response = client.post(f"/sessions/{session}", json={"action": action, **kwargs})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["cache-control"], "no-store")
        return response.json()

    def marker(self, token="turn-1", when=None):
        return {"done_at": self.now if when is None else when, "done_token": token}

    def test_offline_producer_creates_only_ledger_then_reopen(self):
        # No HTTP app or client exists when the lifecycle producer writes.
        self.assertTrue(self.producer.record("same", "turn-1"))
        with closing(sqlite3.connect(self.path)) as connection:
            self.assertEqual({row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")},
                             {"session_completions", "completion_receipts", "session_runs"})
        self.assertEqual(self.state(self.client()), {
            "version": 1, "sessions": {}, "completions": {"same": self.marker()}, "runs": {},
        })
        self.assertEqual(self.state(self.client())["completions"], {"same": self.marker()})

    def test_turn_starts_are_shared_content_free_and_ended_per_exact_turn(self):
        one, two = self.client(), self.client()
        self.producer.begin_run("same", "turn-1", 1000.5)
        self.assertEqual(self.state(one)["runs"], {"same": {"started_at": 1000.5, "ended_at": None, "pending": False}})
        self.assertEqual(self.state(one), self.state(two))
        self.producer.begin_run("same", "turn-2", 1001.0)
        self.assertFalse(self.producer.end_run("turn-1"))
        self.assertEqual(self.state(two)["runs"], {"same": {"started_at": 1001.0, "ended_at": None, "pending": False}})
        self.assertTrue(self.producer.end_run("turn-2"))
        self.assertFalse(self.producer.end_run("turn-2"))
        self.assertEqual(self.state(one)["runs"], {"same": {"started_at": 1001.0, "ended_at": self.now, "pending": False}})
        self.producer.begin_run("same", "turn-3", 1002.0)
        self.assertEqual(self.state(one)["runs"], {"same": {"started_at": 1002.0, "ended_at": None, "pending": False}})
        for invalid in (0.0, -1.0, float("nan"), float("inf"), 5):
            with self.assertRaises(ValueError):
                self.producer.begin_run("same", "turn-3", invalid)

    def test_wake_ups_keep_the_work_start_and_a_user_turn_restarts_it(self):
        client = self.client()
        runs = lambda: self.state(client)["runs"]["same"]
        self.producer.begin_run("same", "user", 1000.0)
        self.producer.end_run("user", pending=True)
        self.assertEqual(runs(), {"started_at": 1000.0, "ended_at": self.now, "pending": True})
        # The background work's wake-up continues; its own end has nothing left pending.
        self.producer.begin_run("same", "notice", 1001.0)
        self.assertEqual(runs(), {"started_at": 1000.0, "ended_at": None, "pending": False})
        self.producer.end_run("notice")
        # A heartbeat fired since that end continues too; an older firing does not.
        self.producer.begin_run("same", "heartbeat", 1002.0, heartbeat_fired_at=self.now + 1)
        self.assertEqual(runs()["started_at"], 1000.0)
        self.producer.end_run("heartbeat")
        self.producer.begin_run("same", "next-user", 1003.0, heartbeat_fired_at=self.now - 1)
        self.assertEqual(runs()["started_at"], 1003.0)
        # A turn whose end never arrived is no evidence of a wake-up.
        self.producer.begin_run("same", "unended-successor", 1004.0, heartbeat_fired_at=self.now + 1)
        self.assertEqual(runs()["started_at"], 1004.0)
        for invalid in (1, "x", None):
            with self.assertRaises(ValueError):
                self.producer.end_run("unended-successor", pending=invalid)

    def test_legacy_turn_table_gains_pending_on_first_read(self):
        self.path.parent.mkdir(parents=True)
        with closing(sqlite3.connect(self.path)) as connection:
            connection.execute("CREATE TABLE session_runs (session_id TEXT PRIMARY KEY, started_at REAL NOT NULL CHECK (started_at > 0), ended_at REAL CHECK (ended_at IS NULL OR ended_at > 0), turn_id TEXT NOT NULL CHECK (length(turn_id) BETWEEN 1 AND 256))")
            connection.execute("INSERT INTO session_runs VALUES ('same', 1000.0, 1001.0, 'old')")
            connection.commit()
        self.assertEqual(self.state(self.client())["runs"], {"same": {"started_at": 1000.0, "ended_at": 1001.0, "pending": False}})

    def test_two_independent_apps_observe_and_share_exact_ack(self):
        one, two = self.client(), self.client()
        self.assertEqual(self.state(one)["completions"], {})
        self.producer.record("same", "turn-1")
        self.assertEqual(self.state(one), self.state(two))
        self.assertEqual(self.state(two)["completions"], {"same": self.marker()})
        result = self.act(one, "ack_done", done_token="turn-1")
        self.assertEqual(result, {"version": 1, "sessions": {}, "completions": {}, "runs": {}})
        self.assertEqual(self.state(two)["completions"], {})
        self.assertEqual(self.act(two, "ack_done", done_token="turn-1"), result)

    def test_duplicate_after_ack_does_not_resurrect_or_change_clock(self):
        self.producer.record("same", "turn-1")
        client = self.client()
        self.act(client, "ack_done", done_token="turn-1")
        # Durable receipt works in a wholly new producer, without consulting time.
        replay = CompletionStore(self.path, lambda: self.fail("duplicate consulted clock"))
        self.assertFalse(replay.record("same", "turn-1"))
        self.assertEqual(self.state(client)["completions"], {})
        with closing(sqlite3.connect(self.path)) as connection:
            self.assertEqual(connection.execute("SELECT * FROM completion_receipts").fetchall(), [("same", "turn-1")])

    def test_stale_ack_and_duplicate_cannot_erase_or_replace_new_completion(self):
        client = self.client()
        self.producer.record("same", "turn-1")
        self.now += 1
        self.producer.record("same", "turn-2")
        expected = {"same": self.marker("turn-2")}
        self.assertEqual(self.act(client, "ack_done", done_token="turn-1")["completions"], expected)
        self.assertFalse(self.producer.record("same", "turn-1"))
        self.assertEqual(self.state(client)["completions"], expected)
        self.act(client, "ack_done", done_token="turn-2")
        self.assertFalse(self.producer.record("same", "turn-1"))
        self.assertFalse(self.producer.record("same", "turn-2"))
        self.assertEqual(self.state(client)["completions"], {})

    def test_duplicate_before_ack_keeps_original_backend_timestamp(self):
        self.producer.record("same", "turn-1")
        original = self.marker()
        self.now += 100
        self.assertFalse(self.producer.record("same", "turn-1"))
        self.assertEqual(self.state(self.client())["completions"], {"same": original})

    def test_ack_absent_does_not_create_org_row_or_sweep_due_snooze(self):
        client = self.client()
        empty = self.act(client, "ack_done", done_token="turn-1")
        self.assertEqual(empty, {"version": 1, "sessions": {}, "completions": {}, "runs": {}})
        self.act(client, "snooze", "due", wake_at=self.now + 1)
        self.now += 2
        result = self.act(client, "ack_done", done_token="turn-1")
        self.assertEqual(set(result["sessions"]), {"due"})
        self.assertEqual(result["sessions"]["due"]["state"], "snoozed")
        with closing(sqlite3.connect(self.path)) as connection:
            self.assertEqual(connection.execute("SELECT session_id FROM session_metadata").fetchall(), [("due",)])
        self.assertEqual(self.state(client)["sessions"]["due"]["state"], "active")

    def test_completion_and_ack_preserve_org_recency_and_wake(self):
        client = self.client()
        self.act(client, "pin")
        self.act(client, "snooze", wake_at=self.now + 1)
        self.now += 1
        before = self.state(client)["sessions"]
        self.now += 10
        self.producer.record("same", "turn-1")
        self.assertEqual(self.state(client)["sessions"], before)
        self.assertEqual(self.act(client, "ack_done", done_token="turn-1")["sessions"], before)

    def test_org_operations_never_clear_completion(self):
        client = self.client()
        self.producer.record("same", "turn-1")
        original = {"same": self.marker()}
        for action in ("pin", "unpin", "settle", "restore", "snooze", "ack_wake"):
            with self.subTest(action=action):
                self.now += 1
                kwargs: dict = {"wake_at": self.now + 1} if action == "snooze" else {"woke_at": self.now} if action == "ack_wake" else {}
                self.assertEqual(self.act(client, action, **kwargs)["completions"], original)

    def test_existing_org_only_schema_migrates_without_metadata_changes(self):
        client = self.client()
        before = self.act(client, "settle")["sessions"]
        with closing(sqlite3.connect(self.path)) as connection:
            connection.execute("DROP TABLE session_completions")
            connection.execute("DROP TABLE completion_receipts")
            connection.commit()
        value = self.state(client)
        self.assertEqual(value, {"version": 1, "sessions": before, "completions": {}, "runs": {}})
        self.producer.record("same", "turn-1")
        self.assertEqual(self.state(client)["sessions"], before)

    def test_reserved_writer_does_not_block_combined_readonly_snapshot(self):
        client = self.client()
        self.act(client, "pin")
        self.producer.record("same", "turn-1")
        expected = self.state(client)
        with closing(sqlite3.connect(self.path, isolation_level=None)) as writer, ThreadPoolExecutor(max_workers=1) as pool:
            writer.execute("BEGIN IMMEDIATE")
            writer.execute("UPDATE session_metadata SET pinned = 0")
            writer.execute("UPDATE session_completions SET done_token = 'uncommitted'")
            future = pool.submit(self.state, client)
            try:
                self.assertEqual(future.result(timeout=.5), expected)
            finally:
                writer.execute("ROLLBACK")
                future.result(timeout=2)

    def test_current_get_reads_all_three_tables_in_one_snapshot_without_receipts(self):
        client = self.client()
        self.state(client)
        statements = []
        connect = sqlite3.connect
        def traced(*args, **kwargs):
            self.assertIn("mode=ro", str(args[0]))
            conn = connect(*args, **kwargs)
            conn.set_trace_callback(statements.append)
            return conn
        before = self.path.read_bytes()
        with patch.object(backend.sqlite3, "connect", traced):
            self.state(client)
        self.assertEqual([s.split()[0] for s in statements], ["BEGIN", "SELECT", "SELECT", "SELECT", "COMMIT"])
        self.assertIn("session_metadata", statements[1])
        self.assertIn("session_completions", statements[2])
        self.assertIn("session_runs", statements[3])
        self.assertNotIn("completion_receipts", " ".join(statements))
        self.assertEqual(self.path.read_bytes(), before)

    def test_strict_ack_payload_validation_never_changes_state(self):
        self.producer.record("same", "turn-1")
        client = self.client()
        expected = self.state(client)
        bodies = [
            {"action": "ack_done"},
            *({"action": "ack_done", "done_token": token} for token in (None, "", 1, True, [], {}, "x" * 257)),
            *({"action": "ack_done", "done_token": "turn-1", key: value} for key, value in
              (("done_at", self.now), ("wake_at", None), ("woke_at", None), ("profile", "other"), ("path", "other"))),
            *({"action": action, "done_token": token} for action in
              ("pin", "unpin", "settle", "restore", "snooze", "ack_wake") for token in (None, "turn-1")),
            {"action": "complete", "done_token": "turn-1"},
        ]
        for body in bodies:
            with self.subTest(body=body):
                response = client.post("/sessions/same", json=body)
                self.assertEqual(response.status_code, 422, response.text)
                self.assertEqual(self.state(client), expected)
        # Boundary token is exact, not stripped or converted.
        token = "x" * 256
        self.producer.record("same", token)
        self.assertEqual(self.act(client, "ack_done", done_token=token)["completions"], {})

    def test_profile_resolution_is_per_request_and_receipts_are_isolated(self):
        other = Path(self.temp.name) / "other/plugin-data/hermes-t3sidebar/state.sqlite3"
        for path in (self.path, other):
            CompletionStore(path, lambda: self.now).record("same", "turn-1")
        app = FastAPI()
        app.include_router(backend.create_router(clock=lambda: self.now))
        with TestClient(app) as client, patch.object(backend, "default_state_path", return_value=self.path) as resolve:
            self.act(client, "ack_done", done_token="turn-1")
            self.assertEqual(self.state(client)["completions"], {})
            resolve.return_value = other
            self.assertEqual(self.state(client)["completions"], {"same": self.marker()})
            resolve.return_value = self.path
            self.assertFalse(self.producer.record("same", "turn-1"))
            self.assertEqual(self.state(client)["completions"], {})

    def test_listing_backfills_union_in_one_state_read_and_not_on_later_pages(self):
        calls = []
        def listing(profile, offset, limit, ids):
            calls.append((offset, ids))
            return {"sessions": [], "offset": offset, "limit": limit, "has_more": False}
        client = self.client(sessions_reader=listing, profile_reader=lambda: "exact")
        self.act(client, "pin", "organized")
        self.act(client, "pin", "both")
        self.producer.record("both", "turn-1")
        self.producer.record("old-completed", "turn-1")
        original = backend.HermesT3SidebarStore.state
        with patch.object(backend.HermesT3SidebarStore, "state", autospec=True, side_effect=original) as read:
            self.assertEqual(client.get("/sessions").status_code, 200)
            self.assertEqual(read.call_count, 1)
            self.assertEqual(client.get("/sessions?offset=500").status_code, 200)
            self.assertEqual(read.call_count, 1)
        self.assertEqual(calls, [(0, ("both", "old-completed", "organized")), (500, ())])

    def test_completed_only_alias_backfills_old_native_row_readonly(self):
        from hermes_state import SessionDB

        native_path = Path(self.temp.name) / "native.sqlite3"
        with closing(SessionDB(native_path)) as db:
            assert db._conn is not None
            with db._conn:
                db._conn.execute("INSERT INTO sessions(id, source, started_at, end_reason) VALUES ('old-root', 'cli', 1, 'compression')")
                db._conn.execute("INSERT INTO sessions(id, source, started_at, parent_session_id) VALUES ('old-tip', 'cli', 2, 'old-root')")
                db._conn.execute("INSERT INTO sessions(id, source, started_at) VALUES ('recent', 'cli', 100)")
        before = native_path.read_bytes()
        def open_db(profile, *, read_only):
            self.assertEqual(profile, "exact")
            self.assertTrue(read_only)
            return SessionDB(native_path, read_only=True)
        client = self.client(profile_reader=lambda: "exact")
        with patch("hermes_cli.web_server_sessions._open_session_db_for_profile", open_db):
            self.assertEqual([row["id"] for row in client.get("/sessions?limit=1").json()["sessions"]], ["recent"])
            self.producer.record("old-root", "turn-1")
            result = client.get("/sessions?limit=1")
            self.assertEqual(result.status_code, 200, result.text)
            rows = result.json()["sessions"]
            self.assertEqual({row["id"] for row in rows}, {"recent", "old-tip"})
            self.assertEqual(self.state(client)["sessions"], {})
            self.act(client, "ack_done", "old-root", done_token="turn-1")
            self.assertEqual([row["id"] for row in client.get("/sessions?limit=1").json()["sessions"]], ["recent"])
        self.assertEqual(native_path.read_bytes(), before)

    def test_record_validation_and_invalid_clock_rollback_receipt(self):
        for sid in (None, True, "", ".", "bad id", "a/b", "x" * 257, "ok\n"):
            with self.subTest(sid=sid), self.assertRaises(ValueError):
                self.producer.record(sid, "turn-1")
        for token in (None, 1, True, "", "x" * 257):
            with self.subTest(token=token), self.assertRaises(ValueError):
                self.producer.record("same", token)
        self.assertFalse(self.path.exists())
        for now in (0, -1, float("nan"), float("inf"), float("-inf")):
            with self.subTest(now=now), self.assertRaises(ValueError):
                CompletionStore(self.path, lambda: now).record("same", "turn-1")
        self.assertTrue(self.producer.record("same", "turn-1"))
        self.assertEqual(ledger.SESSION_ID_PATTERN, backend.SESSION_ID_PATTERN)

    def test_static_helpers_respect_caller_transaction(self):
        self.path.parent.mkdir(parents=True)
        with closing(sqlite3.connect(self.path, isolation_level=None)) as connection:
            connection.execute("BEGIN IMMEDIATE")
            CompletionStore.ensure_schema(connection)
            self.assertTrue(connection.in_transaction)
            self.assertEqual(CompletionStore.read(connection), {})
            connection.execute("INSERT INTO session_completions VALUES ('same', 12.5, 'turn-1')")
            self.assertFalse(CompletionStore.acknowledge(connection, "same", "wrong"))
            self.assertTrue(CompletionStore.acknowledge(connection, "same", "turn-1"))
            self.assertTrue(connection.in_transaction)
            connection.execute("ROLLBACK")
            self.assertEqual(connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall(), [])

    def test_offline_stdlib_subprocess_and_concurrent_sqlite_producers(self):
        # A separate Python process imports only the pure ledger, not FastAPI.
        source = '''import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("offline_ledger", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert not any(name.startswith(("fastapi", "pydantic", "hermes_state")) for name in sys.modules)
store = module.CompletionStore(sys.argv[2], lambda: 1234.5)
print(json.dumps([store.record("process-shared", "same-turn"), *[store.record("process-" + sys.argv[3], "turn-" + str(i)) for i in range(10)]]))
'''
        def run(index):
            result = subprocess.run([sys.executable, "-c", source, str(ROOT / "completion_state.py"), str(self.path), str(index)],
                                    capture_output=True, text=True, timeout=30, check=True)
            return json.loads(result.stdout)
        client = self.client()
        with ThreadPoolExecutor(max_workers=6) as pool:
            futures = [pool.submit(run, i) for i in range(6)]
            # Concurrent organization writes use the very same SQLite file.
            for i in range(6):
                self.act(client, "pin", f"process-{i}")
            results = [future.result() for future in futures]
        self.assertEqual(sum(row[0] for row in results), 1)
        self.assertTrue(all(all(row[1:]) for row in results))
        state = self.state(client)
        self.assertEqual(len(state["sessions"]), 6)
        self.assertEqual(len(state["completions"]), 7)
        for i in range(6):
            self.assertEqual(state["completions"][f"process-{i}"], {"done_at": 1234.5, "done_token": "turn-9"})
        with closing(sqlite3.connect(self.path)) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM completion_receipts").fetchone()[0], 61)
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_ledger_is_stdlib_and_persists_only_identifiers_and_timestamp(self):
        tree = ast.parse((ROOT / "completion_state.py").read_text())
        imports = {alias.name.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
        imports |= {node.module.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.module}
        self.assertTrue(imports <= sys.stdlib_module_names, imports)
        self.producer.record("same", "turn-1")
        client = self.client()
        self.act(client, "ack_done", done_token="turn-1")
        with closing(sqlite3.connect(self.path)) as connection:
            for table, columns in (("session_completions", ["session_id", "done_at", "done_token"]),
                                   ("completion_receipts", ["session_id", "turn_id"])):
                self.assertEqual([row[1] for row in connection.execute(f"PRAGMA table_info({table})")], columns)
        self.assertEqual(backend.FlowState(sessions={}).completions, {})


if __name__ == "__main__":
    unittest.main()
