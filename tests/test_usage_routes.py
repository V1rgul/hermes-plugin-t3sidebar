"""Usage page HTTP routes: profile assertion, validation, and sampler start policy.

Every router here injects scratch paths, a fixed clock and a fake sampler starter, so no test reads live state or reaches provider credentials.
"""

from contextlib import closing
import importlib.util
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("hermes_dashboard_plugin_hermes_t3sidebar_usage_routes_test", ROOT / "dashboard/plugin_api.py")
assert SPEC is not None and SPEC.loader is not None
backend = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = backend
SPEC.loader.exec_module(backend)

PREFIX = "/api/plugins/hermes-t3sidebar"
NOW = 1_793_224_518.0
# Minimal Hermes state.db shape the aggregator reads; empty tables avoid any pricing lookup.
SCHEMA = """
CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, parent_session_id TEXT, title TEXT, started_at REAL NOT NULL);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, tool_calls TEXT, reasoning TEXT, reasoning_content TEXT, timestamp REAL NOT NULL, token_count INTEGER, active INTEGER NOT NULL DEFAULT 1, compacted INTEGER NOT NULL DEFAULT 0, display_kind TEXT, _compressed_summary INTEGER NOT NULL DEFAULT 0);
CREATE TABLE session_model_usage (session_id TEXT NOT NULL, model TEXT NOT NULL, billing_provider TEXT NOT NULL DEFAULT '', billing_base_url TEXT NOT NULL DEFAULT '', billing_mode TEXT NOT NULL DEFAULT '', task TEXT NOT NULL DEFAULT '', api_call_count INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL NOT NULL DEFAULT 0, actual_cost_usd REAL NOT NULL DEFAULT 0, cost_status TEXT, cost_source TEXT, first_seen REAL, last_seen REAL);
"""


class FakeSampler:
	def status(self):
		return {"interval_s": 300.0, "started_at": NOW - 600, "last_run_at": NOW - 60, "last_error": None}


class UsageRouteTests(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory()
		self.addCleanup(self.temp.cleanup)
		root = Path(self.temp.name)
		self.db = root / "state.db"
		with closing(sqlite3.connect(self.db)) as connection:
			connection.executescript(SCHEMA)
		self.limits = root / "usage-limits.sqlite3"
		self.starts = 0

	def starter(self):
		self.starts += 1
		return FakeSampler()

	def client(self, **kwargs):
		app = FastAPI()
		options = dict(profile_reader=lambda: "default", history_db_path=self.db, limits_path=self.limits, clock=lambda: NOW, limits_sampler=self.starter)
		options.update(kwargs)
		app.include_router(backend.create_router(Path(self.temp.name) / "metadata.sqlite3", **options), prefix=PREFIX)
		client = TestClient(app)
		self.addCleanup(client.close)
		return client

	def test_history_returns_contract_shape_for_current_profile(self):
		response = self.client().get(f"{PREFIX}/usage/history?days=7&tz=Europe%2FParis&profile=default")
		self.assertEqual(response.status_code, 200, response.text)
		body = response.json()
		self.assertEqual(body["profile"], "default")
		self.assertEqual((body["days"], body["tz"], body["resolution"], len(body["buckets"])), (7, "Europe/Paris", "day", 7))
		self.assertEqual((body["by_provider"], body["by_model"]), ([], []))
		self.assertEqual(response.headers["cache-control"], "no-store")

	def test_history_hourly_window(self):
		body = self.client().get(f"{PREFIX}/usage/history?days=1&tz=UTC").json()
		self.assertEqual((body["resolution"], len(body["buckets"])), ("hour", 24))

	def test_history_rejects_bad_arguments_and_foreign_profiles(self):
		client = self.client()
		for query in ("days=3&tz=UTC", "days=7&tz=Not%2FAZone", "days=x&tz=UTC", "days=7&tz=UTC&profile=other", "days=7&tz=UTC&extra=1"):
			self.assertEqual(client.get(f"{PREFIX}/usage/history?{query}").status_code, 422, query)

	def test_history_unreadable_store_is_unavailable_not_empty(self):
		response = self.client(history_db_path=Path(self.temp.name) / "missing.db").get(f"{PREFIX}/usage/history?days=7&tz=UTC")
		self.assertEqual(response.status_code, 503)

	def test_limits_reads_missing_store_without_creating_it(self):
		response = self.client().get(f"{PREFIX}/usage/limits?hours=24&profile=default")
		self.assertEqual(response.status_code, 200, response.text)
		body = response.json()
		self.assertEqual((body["profile"], body["providers"]), ("default", []))
		self.assertEqual(body["sampler"]["interval_s"], 300.0)
		self.assertFalse(self.limits.exists())
		self.assertEqual(self.starts, 1)

	def test_limits_validates_hours_and_parameters(self):
		client = self.client()
		for query in ("hours=0", "hours=841", "hours=x", "hours=24&days=7"):
			self.assertEqual(client.get(f"{PREFIX}/usage/limits?{query}").status_code, 422, query)

	def test_runtime_poll_starts_sampler(self):
		async def runtime(request, profile):
			return {"sessions": []}
		self.assertEqual(self.client(runtime_reader=runtime).get(f"{PREFIX}/runtime").status_code, 200)
		self.assertEqual(self.starts, 1)

	def test_failing_sampler_never_fails_requests(self):
		def broken():
			raise RuntimeError("no secret scope")
		async def runtime(request, profile):
			return {"sessions": []}
		client = self.client(limits_sampler=broken, runtime_reader=runtime)
		self.assertEqual(client.get(f"{PREFIX}/runtime").status_code, 200)
		body = client.get(f"{PREFIX}/usage/limits").json()
		self.assertIsNone(body["sampler"]["started_at"])

	def test_only_the_production_router_samples(self):
		calls = []
		original = backend.ensure_limits_sampler
		backend.ensure_limits_sampler = lambda: calls.append(1)
		self.addCleanup(setattr, backend, "ensure_limits_sampler", original)
		async def runtime(request, profile):
			return {"sessions": []}
		app = FastAPI()
		app.include_router(backend.create_router(Path(self.temp.name) / "metadata.sqlite3", profile_reader=lambda: "default", runtime_reader=runtime))
		with TestClient(app) as client:
			self.assertEqual(client.get("/runtime").status_code, 200)
		self.assertEqual(calls, [])
		# The module-level router is the one Hermes mounts; it must carry the real starter.
		self.assertIs(backend.router.t3sidebar_limits_sampler, original)


if __name__ == "__main__":
	unittest.main()
