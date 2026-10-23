"""Bounded contention regressions; synthetic registries and scratch SQLite only."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
from threading import Event
import unittest
from unittest.mock import patch

from test_backend import backend


class MetadataReadPerformance(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="flow-read-performance-")
		self.addCleanup(self.temp.cleanup)
		self.path = Path(self.temp.name) / "metadata.sqlite3"
		self.now = 1000.0
		self.store = backend.HermesT3SidebarStore(self.path, lambda: self.now)
		self.store.mutate("future", backend.SessionAction(action="snooze", wake_at=1100.0))

	def test_current_no_due_read_is_one_select_without_writer_or_schema_work(self):
		statements, opens = [], []
		connect = sqlite3.connect
		def traced(*args, **kwargs):
			opens.append((args, kwargs))
			conn = connect(*args, **kwargs)
			conn.set_trace_callback(statements.append)
			return conn
		before = self.path.read_bytes()
		with patch.object(backend.sqlite3, "connect", traced):
			value = self.store.state()
		self.assertEqual(value["sessions"]["future"]["state"], "snoozed")
		self.assertEqual(self.path.read_bytes(), before)
		self.assertEqual(len(opens), 1)
		self.assertIn("mode=ro", str(opens[0][0][0]))
		self.assertTrue(opens[0][1].get("uri"))
		self.assertEqual([s.split()[0].upper() for s in statements], ["BEGIN", "SELECT", "COMMIT"])
		self.assertNotIn("IMMEDIATE", " ".join(statements).upper())

	def test_reserved_writer_does_not_block_committed_no_due_snapshot(self):
		with closing(sqlite3.connect(self.path, isolation_level=None)) as blocker, ThreadPoolExecutor(max_workers=1) as pool:
			blocker.execute("BEGIN IMMEDIATE")
			blocker.execute("UPDATE session_metadata SET pinned = 1")
			future = pool.submit(self.store.state)
			try:
				value = future.result(timeout=.25)
				self.assertFalse(value["sessions"]["future"]["pinned"])
			finally:
				blocker.execute("ROLLBACK")
				future.result(timeout=2)

	def test_due_read_rechecks_after_writer_and_preserves_resnooze(self):
		self.now = 1100.0
		attempted = Event()
		connect = sqlite3.connect
		def traced(*args, **kwargs):
			conn = connect(*args, **kwargs)
			conn.set_trace_callback(lambda sql: attempted.set() if sql == "BEGIN IMMEDIATE" else None)
			return conn
		with closing(connect(self.path, isolation_level=None)) as blocker, ThreadPoolExecutor(max_workers=1) as pool:
			blocker.execute("BEGIN IMMEDIATE")
			blocker.execute("UPDATE session_metadata SET wake_at = 1200, updated_at = 1099")
			with patch.object(backend.sqlite3, "connect", traced):
				future = pool.submit(self.store.state)
				try:
					self.assertTrue(attempted.wait(1), "due read must use the serialized writer path")
				finally:
					blocker.execute("COMMIT")
				value = future.result(timeout=2)
		row = value["sessions"]["future"]
		self.assertEqual((row["state"], row["wake_at"], row["updated_at"], row["woke_at"]), ("snoozed", 1200, 1099, None))
		self.now = 1300.0
		row = self.store.state()["sessions"]["future"]
		self.assertEqual((row["state"], row["updated_at"], row["woke_at"]), ("active", 1200, 1200))
		self.store.mutate("future", backend.SessionAction(action="ack_wake", woke_at=1100.0))
		self.assertEqual(self.store.state()["sessions"]["future"]["woke_at"], 1200)

	def test_nonfinite_clock_is_rejected_on_read_fast_path(self):
		for now in (float("nan"), float("inf")):
			self.now = now
			with self.assertRaises(ValueError):
				self.store.state()


class NativeAliasPerformance(unittest.TestCase):
	def test_real_native_projection_of_loaded_aliases_has_one_rich_seed(self):
		from hermes_state import SessionDB
		with tempfile.TemporaryDirectory(prefix="flow-alias-performance-") as temp:
			path = Path(temp) / "native.sqlite3"
			# Seed only synthetic compact session columns, avoiding lifecycle hooks.
			with closing(SessionDB(path)) as db:
				assert db._conn is not None
				with db._conn:
					for i in range(20):
						db._conn.execute("INSERT INTO sessions(id, source, started_at, end_reason) VALUES (?, 'cli', ?, 'compression')", (f"root-{i}", i + 1))
						db._conn.execute("INSERT INTO sessions(id, source, started_at, parent_session_id) VALUES (?, 'cli', ?, ?)", (f"tip-{i}", i + 100, f"root-{i}"))
			statements = []
			def open_db(profile, *, read_only):
				self.assertEqual(profile, "exact-profile")
				self.assertTrue(read_only)
				db = SessionDB(path, read_only=read_only)
				assert db._conn is not None
				db._conn.set_trace_callback(statements.append)
				return db
			before = path.read_bytes()
			with patch("hermes_cli.web_server_sessions._open_session_db_for_profile", open_db):
				value = backend.native_sessions("exact-profile", 0, 500, tuple(f"tip-{i}" for i in range(20)))
			self.assertEqual(len(value["sessions"]), 20)
			self.assertEqual(sum("WITH RECURSIVE chain(root_id, cur_id)" in sql for sql in statements), 1)
			self.assertEqual(path.read_bytes(), before)


class RuntimeLoopPerformance(unittest.TestCase):
	def test_parallel_standalone_workers_keep_distinct_profile_contexts(self):
		from threading import Barrier
		from types import SimpleNamespace
		from hermes_constants import get_hermes_home, set_hermes_home_override, reset_hermes_home_override
		barrier = Barrier(2, timeout=2)
		def blocking(request, profile, actor):
			barrier.wait()
			return {"sessions": [], "home": str(get_hermes_home()), "selected": profile}
		async def scoped(name):
			token = set_hermes_home_override(str(Path(tempfile.gettempdir()) / name))
			try:
				return await backend.native_runtime(SimpleNamespace(state=SimpleNamespace()), name)
			finally:
				reset_hermes_home_override(token)
		async def probe():
			return await asyncio.gather(scoped("profile-a"), scoped("profile-b"))
		with patch("hermes_cli.web_server_sessions._session_mutation_context", return_value=(None, object())), patch.object(backend, "standalone_runtime", blocking):
			values = asyncio.run(probe())
		self.assertEqual([(v["selected"], v["home"]) for v in values], [(name, str(Path(tempfile.gettempdir()) / name)) for name in ("profile-a", "profile-b")])

	def test_standalone_worker_yields_event_loop_and_keeps_context(self):
		from types import SimpleNamespace
		from hermes_constants import get_hermes_home, set_hermes_home_override, reset_hermes_home_override
		from gateway.session_contract import Principal
		home = Path(tempfile.gettempdir()) / "flow-synthetic-profile"
		actor = Principal("owner", str(home), frozenset({"session:read"}), "http")
		entered, release = Event(), Event()
		observed = []
		def blocking(request, profile, actual_actor):
			observed.append((get_hermes_home(), profile, actual_actor))
			entered.set()
			if not release.wait(.5):
				raise TimeoutError("event loop did not release the native read")
			return {"sessions": []}
		async def probe():
			task = asyncio.create_task(backend.native_runtime(SimpleNamespace(state=SimpleNamespace()), "exact-profile"))
			try:
				for _ in range(100):
					if entered.is_set():
						break
					await asyncio.sleep(.001)
				self.assertTrue(entered.is_set())
				release.set()
				return await task
			finally:
				release.set()
				if not task.done():
					await task
		token = set_hermes_home_override(str(home))
		try:
			with patch("hermes_cli.web_server_sessions._session_mutation_context", return_value=(None, actor)), patch.object(backend, "standalone_runtime", blocking):
				self.assertEqual(asyncio.run(probe()), {"sessions": []})
		finally:
			reset_hermes_home_override(token)
		self.assertEqual(observed, [(home, "exact-profile", actor)])
