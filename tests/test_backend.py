"""Run with: python -m unittest discover -s tests -v

Every API/store test injects scratch storage and a clock. No live state writes.
"""

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import ast
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("hermes_dashboard_plugin_hermes_t3sidebar_test", ROOT / "dashboard/plugin_api.py")
assert SPEC is not None and SPEC.loader is not None
backend = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = backend
SPEC.loader.exec_module(backend)


class BackendTests(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="hermes-t3sidebar-tests-")
		self.addCleanup(self.temp.cleanup)
		self.path = Path(self.temp.name) / "plugin-data/hermes-t3sidebar/state.sqlite3"
		self.now = 1800000000.25
		self.app = self.make_app()
		self.client = TestClient(self.app)
		self.addCleanup(self.client.close)

	def make_app(self):
		app = FastAPI()
		app.include_router(backend.create_router(self.path, lambda: self.now), prefix="/api/plugins/hermes-t3sidebar")
		return app

	def state(self):
		response = self.client.get("/api/plugins/hermes-t3sidebar/state")
		self.assertEqual(response.status_code, 200, response.text)
		self.assertEqual(response.headers["cache-control"], "no-store")
		return response.json()

	def act(self, action, session="durable-1", **kwargs):
		response = self.client.post(f"/api/plugins/hermes-t3sidebar/sessions/{session}", json={"action": action, **kwargs})
		self.assertEqual(response.status_code, 200, response.text)
		self.assertEqual(response.headers["cache-control"], "no-store")
		self.assertEqual(set(response.json()), {"version", "sessions", "completions"})
		return response.json()["sessions"][session]

	def test_empty_and_full_response_shape(self):
		self.assertEqual(self.state(), {"version": 1, "sessions": {}, "completions": {}})
		self.assertEqual(self.act("pin"), {
			"state": "active", "settled_at": None, "wake_at": None,
			"woke_at": None, "pinned": True, "updated_at": self.now,
		})
		self.act("settle", "another")
		self.assertEqual(len(self.state()["sessions"]), 2)

	def test_settle_restore_and_pin_metadata(self):
		self.act("pin")
		settled = self.act("settle")
		self.assertEqual(settled["settled_at"], self.now)
		self.now += 7
		unpinned = self.act("unpin")
		self.assertEqual(unpinned["state"], "settled")
		self.assertEqual(unpinned["settled_at"], settled["settled_at"])
		self.assertFalse(unpinned["pinned"])
		self.assertEqual(unpinned["updated_at"], self.now)
		self.act("pin")
		restored = self.act("restore")
		self.assertEqual(restored["state"], "active")
		self.assertIsNone(restored["settled_at"])
		self.assertIsNone(restored["wake_at"])
		self.assertTrue(restored["pinned"])

	def test_snooze_clears_settlement_pin_does_not_restore(self):
		self.act("settle")
		snoozed = self.act("snooze", wake_at=self.now + 60)
		self.assertEqual(snoozed["state"], "snoozed")
		self.assertIsNone(snoozed["settled_at"])
		self.now += 1
		pinned = self.act("pin")
		self.assertEqual(pinned["wake_at"], snoozed["wake_at"])
		self.assertEqual(pinned["state"], "snoozed")
		self.assertTrue(pinned["pinned"])
		settled = self.act("settle")
		self.assertIsNone(settled["wake_at"])
		self.assertTrue(settled["pinned"])

	def test_restore_cancels_snooze(self):
		self.act("snooze", wake_at=self.now + 60)
		restored = self.act("restore")
		self.assertEqual(restored["state"], "active")
		self.assertIsNone(restored["wake_at"])

	def test_due_at_boundary_and_late_reopen(self):
		wake = self.now + 60
		self.act("pin")
		self.act("snooze", wake_at=wake)
		self.now = wake - .01
		self.assertEqual(self.state()["sessions"]["durable-1"]["state"], "snoozed")
		self.now = wake
		with TestClient(self.make_app()) as reopened:
			response = reopened.get("/api/plugins/hermes-t3sidebar/state")
		self.assertEqual(response.status_code, 200)
		active = response.json()["sessions"]["durable-1"]
		self.assertEqual(active["state"], "active")
		self.assertIsNone(active["wake_at"])
		self.assertIsNone(active["settled_at"])
		self.assertTrue(active["pinned"])
		self.assertEqual(active["updated_at"], wake)
		self.assertEqual(active["woke_at"], wake)
		self.now += 86400
		self.assertEqual(self.state()["sessions"]["durable-1"], active)
		with TestClient(self.make_app()) as reopened:
			self.assertEqual(reopened.get("/api/plugins/hermes-t3sidebar/state").json()["sessions"]["durable-1"], active)
		self.assertEqual(self.act("ack_wake", woke_at=wake + .01), active)
		acknowledged = self.act("ack_wake", woke_at=wake)
		self.assertEqual(acknowledged, {**active, "woke_at": None})
		self.assertEqual(self.act("ack_wake", woke_at=wake), acknowledged)
		self.assertEqual(self.state()["sessions"]["durable-1"], acknowledged)
		# No timer ever ran: another due snooze is materialized only on reading.
		self.act("snooze", "late", wake_at=self.now + 2)
		self.now += 90000
		self.assertEqual(self.state()["sessions"]["late"]["state"], "active")

	def test_old_six_column_sqlite_migration(self):
		self.path.parent.mkdir(parents=True)
		with closing(sqlite3.connect(self.path)) as connection:
			connection.execute("""
				CREATE TABLE session_metadata (
					session_id TEXT PRIMARY KEY,
					state TEXT NOT NULL CHECK (state IN ('active', 'settled', 'snoozed')),
					settled_at REAL, wake_at REAL,
					pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
					updated_at REAL NOT NULL,
					CHECK (
						(state = 'active' AND settled_at IS NULL AND wake_at IS NULL) OR
						(state = 'settled' AND settled_at IS NOT NULL AND wake_at IS NULL) OR
						(state = 'snoozed' AND settled_at IS NULL AND wake_at IS NOT NULL)
					)
				)
			""")
			connection.executemany("INSERT INTO session_metadata VALUES (?, ?, ?, ?, ?, ?)", [
				("settled", "settled", self.now - 10, None, 1, self.now - 10),
				("due", "snoozed", None, self.now, 1, self.now - 20),
				("future", "snoozed", None, self.now + 10, 0, self.now - 20),
			])
			connection.commit()
		sessions = self.state()["sessions"]
		self.assertEqual(sessions["settled"], {
			"state": "settled", "settled_at": self.now - 10, "wake_at": None,
			"woke_at": None, "pinned": True, "updated_at": self.now - 10,
		})
		self.assertEqual(sessions["due"], {
			"state": "active", "settled_at": None, "wake_at": None,
			"woke_at": self.now, "pinned": True, "updated_at": self.now,
		})
		self.assertEqual(sessions["future"]["wake_at"], self.now + 10)
		self.assertIsNone(sessions["future"]["woke_at"])
		self.assertEqual(self.state()["sessions"], sessions)
		self.assertTrue(self.act("pin", "new")["pinned"])
		with closing(sqlite3.connect(self.path)) as connection:
			self.assertEqual(len(connection.execute("PRAGMA table_info(session_metadata)").fetchall()), 7)
			self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
			with self.assertRaises(sqlite3.IntegrityError):
				connection.execute("UPDATE session_metadata SET state = 'invalid' WHERE session_id = 'due'")

	def test_stale_ack_cannot_clear_new_wake_or_materialize_due_snooze(self):
		first = self.now + 1
		self.act("snooze", wake_at=first)
		self.now = first
		self.assertEqual(self.state()["sessions"]["durable-1"]["woke_at"], first)
		second = self.now + 1
		self.assertIsNone(self.act("snooze", wake_at=second)["woke_at"])
		self.now = second
		pending = self.act("ack_wake", woke_at=first)
		self.assertEqual(pending["state"], "snoozed")
		self.assertEqual(pending["wake_at"], second)
		self.assertIsNone(pending["woke_at"])
		active = self.state()["sessions"]["durable-1"]
		self.assertEqual(active["woke_at"], second)
		self.assertEqual(self.act("ack_wake", woke_at=first), active)
		self.assertIsNone(self.act("ack_wake", woke_at=second)["woke_at"])

	def test_pin_and_unpin_retain_wake_marker(self):
		wake = self.now + 1
		self.act("snooze", wake_at=wake)
		self.now = wake
		self.state()
		for action, pinned in [("pin", True), ("unpin", False)]:
			self.now += 1
			metadata = self.act(action)
			self.assertEqual(metadata["woke_at"], wake)
			self.assertEqual(metadata["state"], "active")
			self.assertEqual(metadata["pinned"], pinned)
			self.assertEqual(metadata["updated_at"], self.now)

	def test_organization_actions_clear_wake_marker(self):
		for action in ("settle", "restore", "snooze"):
			with self.subTest(action=action):
				wake = self.now + 1
				self.act("snooze", wake_at=wake)
				self.now = wake
				self.assertEqual(self.state()["sessions"]["durable-1"]["woke_at"], wake)
				if action == "snooze":
					metadata = self.act(action, wake_at=self.now + 10)
				else:
					metadata = self.act(action)
				self.assertIsNone(metadata["woke_at"])

	def test_ack_absent_row_does_not_create_or_sweep(self):
		response = self.client.post("/api/plugins/hermes-t3sidebar/sessions/absent", json={"action": "ack_wake", "woke_at": self.now})
		self.assertEqual(response.status_code, 200, response.text)
		self.assertEqual(response.json(), {"version": 1, "sessions": {}, "completions": {}})
		self.act("snooze", wake_at=self.now + 1)
		self.now += 2
		response = self.client.post("/api/plugins/hermes-t3sidebar/sessions/absent", json={"action": "ack_wake", "woke_at": self.now})
		self.assertEqual(response.status_code, 200, response.text)
		self.assertEqual(set(response.json()["sessions"]), {"durable-1"})
		self.assertEqual(response.json()["sessions"]["durable-1"]["state"], "snoozed")
		with closing(sqlite3.connect(self.path)) as connection:
			self.assertEqual(connection.execute("SELECT count(*) FROM session_metadata").fetchone()[0], 1)

	def test_invalid_ack_bodies_rejected_without_changes(self):
		self.act("snooze", wake_at=self.now + 1)
		self.now += 1
		expected = self.state()
		bodies = [
			{"action": "ack_wake"},
			*({"action": "ack_wake", "woke_at": value} for value in [None, True, False, "1800000001", [], {}, 0, -1]),
			{"action": "ack_wake", "woke_at": self.now, "wake_at": None},
			{"action": "ack_wake", "woke_at": self.now, "profile": "other"},
			*({"action": action, "woke_at": value} for action in ["pin", "unpin", "settle", "restore", "snooze"] for value in [None, self.now]),
		]
		for body in bodies:
			with self.subTest(body=body):
				response = self.client.post("/api/plugins/hermes-t3sidebar/sessions/durable-1", json=body)
				self.assertEqual(response.status_code, 422, response.text)
				self.assertEqual(self.state(), expected)
		for value in ["NaN", "Infinity", "-Infinity", "1e9999", "9" * 400]:
			with self.subTest(value=value):
				response = self.client.post("/api/plugins/hermes-t3sidebar/sessions/durable-1", content='{"action":"ack_wake","woke_at":' + value + '}', headers={"Content-Type": "application/json"})
				self.assertEqual(response.status_code, 422, response.text)
				json.loads(response.text)
				self.assertEqual(self.state(), expected)

	def test_metadata_woke_at_defaults_to_none(self):
		metadata = backend.SessionMetadata(state="active", settled_at=None, wake_at=None, pinned=False, updated_at=self.now)
		self.assertIsNone(metadata.woke_at)

	def test_persistence_across_new_app_and_store(self):
		self.act("pin")
		self.act("settle")
		self.act("snooze", "second", wake_at=self.now + 500)
		expected = self.state()
		with TestClient(self.make_app()) as reopened:
			self.assertEqual(reopened.get("/api/plugins/hermes-t3sidebar/state").json(), expected)
		self.assertEqual(backend.HermesT3SidebarStore(self.path, lambda: self.now).state(), expected)
		with closing(sqlite3.connect(self.path)) as connection:
			self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")

	def test_invalid_bodies_rejected_without_changes(self):
		self.act("settle")
		expected = self.state()
		bodies = [
			{}, {"action": "archive"}, {"action": 1}, {"action": True},
			{"action": "pin", "pinned": True}, {"action": "pin", "profile": "other"},
			{"action": "pin", "wake_at": None}, {"action": "pin", "wake_at": self.now + 9},
			{"action": "snooze"}, {"action": "snooze", "wake_at": None},
			*({"action": "snooze", "wake_at": value} for value in [True, "1900000000", [], {}, self.now, self.now - 1]),
			[], None, "pin",
		]
		for body in bodies:
			with self.subTest(body=body):
				response = self.client.post("/api/plugins/hermes-t3sidebar/sessions/rejected", json=body)
				self.assertEqual(response.status_code, 422, response.text)
				self.assertEqual(self.state(), expected)

	def test_nonfinite_and_huge_numbers_rejected_as_json_errors(self):
		for value in ["NaN", "Infinity", "-Infinity", "1e9999", "9" * 400]:
			with self.subTest(value=value):
				response = self.client.post("/api/plugins/hermes-t3sidebar/sessions/invalid", content='{"action":"snooze","wake_at":' + value + '}', headers={"Content-Type": "application/json"})
				self.assertEqual(response.status_code, 422, response.text)
				json.loads(response.text)
		self.assertEqual(self.state()["sessions"], {})

	def test_bad_session_ids_rejected(self):
		for session in ["bad%20id", "%00", ".", "x" * 257, "%27%3BDROP%20TABLE"]:
			with self.subTest(session=session):
				response = self.client.post(f"/api/plugins/hermes-t3sidebar/sessions/{session}", json={"action": "pin"})
				self.assertIn(response.status_code, (404, 405, 422))
		self.assertEqual(self.state()["sessions"], {})
		self.act("pin", "20261023_002913_f349b4")

	def test_post_also_applies_due_snoozes(self):
		self.act("snooze", "due", wake_at=self.now + 1)
		self.now += 2
		self.act("pin", "other")
		self.assertEqual(self.state()["sessions"]["due"]["state"], "active")

	def test_parallel_first_requests_and_same_session_writes(self):
		def update(index):
			with TestClient(self.make_app()) as client:
				return client.post(f"/api/plugins/hermes-t3sidebar/sessions/parallel-{index}", json={"action": "pin"}).status_code
		with ThreadPoolExecutor(max_workers=12) as pool:
			self.assertEqual(list(pool.map(update, range(48))), [200] * 48)
		self.assertEqual(len(self.state()["sessions"]), 48)
		def update_shared(action):
			with TestClient(self.make_app()) as client:
				return client.post("/api/plugins/hermes-t3sidebar/sessions/shared", json={"action": action}).status_code
		with ThreadPoolExecutor(max_workers=12) as pool:
			self.assertEqual(list(pool.map(update_shared, ["pin", "settle"] * 24)), [200] * 48)
		shared = self.state()["sessions"]["shared"]
		self.assertEqual(shared["state"], "settled")
		self.assertTrue(shared["pinned"])

	def test_invalid_mutation_rolls_back_due_sweep(self):
		self.act("snooze", wake_at=self.now + 1)
		self.now += 2
		response = self.client.post("/api/plugins/hermes-t3sidebar/sessions/rejected", json={"action": "snooze", "wake_at": self.now})
		self.assertEqual(response.status_code, 422)
		with closing(sqlite3.connect(self.path)) as connection:
			self.assertEqual(connection.execute("SELECT state FROM session_metadata").fetchone()[0], "snoozed")
		self.assertEqual(self.state()["sessions"]["durable-1"]["state"], "active")

	def test_profile_resolution_per_request(self):
		# Production router, but replace the resolver so no live paths are used.
		app = FastAPI()
		app.include_router(backend.router)
		other = Path(self.temp.name) / "other-profile/plugin-data/hermes-t3sidebar/state.sqlite3"
		with TestClient(app) as client, patch.object(backend, "default_state_path", return_value=self.path) as resolve:
			self.assertEqual(client.post("/sessions/same", json={"action": "pin"}).status_code, 200)
			resolve.return_value = other
			self.assertEqual(client.get("/state").json()["sessions"], {})
			resolve.return_value = self.path
			self.assertTrue(client.get("/state").json()["sessions"]["same"]["pinned"])

	def test_wake_ack_isolated_between_profiles(self):
		app = FastAPI()
		app.include_router(backend.create_router(clock=lambda: self.now))
		other = Path(self.temp.name) / "other-profile/plugin-data/hermes-t3sidebar/state.sqlite3"
		wake = self.now + 1
		with TestClient(app) as client, patch.object(backend, "default_state_path", return_value=self.path) as resolve:
			for path in (self.path, other):
				resolve.return_value = path
				response = client.post("/sessions/same", json={"action": "snooze", "wake_at": wake})
				self.assertEqual(response.status_code, 200, response.text)
			self.now = wake
			for path in (self.path, other):
				resolve.return_value = path
				self.assertEqual(client.get("/state").json()["sessions"]["same"]["woke_at"], wake)
			resolve.return_value = self.path
			response = client.post("/sessions/same", json={"action": "ack_wake", "woke_at": wake})
			self.assertEqual(response.status_code, 200, response.text)
			self.assertIsNone(client.get("/state").json()["sessions"]["same"]["woke_at"])
			resolve.return_value = other
			self.assertEqual(client.get("/state").json()["sessions"]["same"]["woke_at"], wake)

	def test_default_path_uses_profile_home(self):
		with patch("hermes_constants.get_hermes_home", return_value=Path(self.temp.name)):
			self.assertEqual(backend.default_state_path(), self.path)

	def test_no_native_history_mutation_or_execution_dependencies(self):
		source = (ROOT / "dashboard/plugin_api.py").read_text()
		tree = ast.parse(source)
		imports = set()
		for node in ast.walk(tree):
			if isinstance(node, ast.Import):
				imports.update(alias.name for alias in node.names)
			elif isinstance(node, ast.ImportFrom):
				imports.add(node.module)
		self.assertEqual(imports, {"asyncio", "importlib.util", "json", "math", "pathlib", "re", "sqlite3", "sys", "time", "typing", "types", "fastapi", "pydantic", "hermes_constants", "hermes_state_sessions", "hermes_cli", "hermes_cli.projects_db", "hermes_cli.web_server_sessions", "gateway.session_active_list", "gateway.session_ancillary", "gateway.session_contract", "tui_gateway.ws_legacy_fallback"})
		# Native access is read-only listing only; mutation stays in plugin-owned SQLite.
		self.assertNotIn("import tui_gateway.server", source)
		parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
		registry_reads = [node for node in ast.walk(tree) if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "server" and node.attr == "_sessions"]
		self.assertEqual(len(registry_reads), 2)
		projection = [node for node in registry_reads for parent in [parents[node]] if isinstance(parent, ast.keyword) and parent.arg == "_sessions"]
		guard = [node for node in registry_reads for parent in [parents[node]] if isinstance(parent, ast.Attribute) and parent.attr == "get"]
		self.assertEqual((len(projection), len(guard)), (1, 1))
		# The only direct registry lookup validates the exact object already admitted
		# by the native scoped snapshot; it never walks another profile's entries.
		lookup = parents[parents[guard[0]]]
		assert isinstance(lookup, ast.Call)
		self.assertEqual(len(lookup.args), 1)
		self.assertEqual(ast.dump(lookup.args[0]), ast.dump(ast.parse('row["id"]', mode="eval").body))
		self.assertEqual(lookup.keywords, [])
		self.assertTrue(all(isinstance(node.ctx, ast.Load) for node in registry_reads))
		self.assertNotIn("session_mutations", source)
		self.assertNotIn("read_only=False", source)
		self.assertIn("read_only=True", source)
		self.assertNotIn("ATTACH", source)
		self.assertNotIn("state.db", source)
		# A native history sentinel is untouched by all supported operations.
		history = Path(self.temp.name) / "sessions/example.jsonl"
		history.parent.mkdir()
		history.write_bytes(b'{"role":"user","content":"preserve exactly"}\n')
		before = history.read_bytes()
		for action in ("pin", "settle", "snooze", "unpin", "restore"):
			if action == "snooze":
				self.act(action, wake_at=self.now + 5)
			else:
				self.act(action)
		self.assertEqual(history.read_bytes(), before)
		self.assertFalse((Path(self.temp.name) / "state.db").exists())

	def test_packaging(self):
		manifest = json.loads((ROOT / "dashboard/manifest.json").read_text())
		self.assertEqual(manifest["name"], "hermes-t3sidebar")
		self.assertEqual(manifest["api"], "plugin_api.py")
		self.assertTrue(manifest["tab"]["hidden"])
		self.assertEqual({route.path for route in backend.router.routes}, {"/state", "/runtime", "/sessions", "/archives", "/sessions/{session_id}/archive", "/sessions/{session_id}/snapshot", "/sessions/{session_id}"})


if __name__ == "__main__":
	unittest.main()
