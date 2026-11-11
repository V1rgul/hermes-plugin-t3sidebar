"""Fail-open compatibility catches keep working and leave a diagnostic naming the failure's class, never its message."""

from pathlib import Path
import tempfile
from typing import Any
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from hermes_state_runtime import RuntimeStoreError

from test_backend import backend
# Only the module objects: importing their TestCase classes here would run those tests twice under discovery.
import test_completion_hooks as hook_fixture
import test_runtime_subagents as subagent_fixture


SECRET = "private-fixture-detail"
hooks = hook_fixture.hooks


class HookDiagnostics(unittest.TestCase):
	observer: Any
	setUp = hook_fixture.CompletionHookTests.setUp
	payload = hook_fixture.CompletionHookTests.payload
	markers = hook_fixture.CompletionHookTests.markers

	def begin(self):
		return self.observer.on_pre_llm_call(**self.payload())

	def end(self):
		return self.observer.on_session_end(**self.payload(completed=True, failed=False, interrupted=False))

	def assert_logged(self, logs, message):
		self.assertIn(message, [record.getMessage() for record in logs.records])
		self.assertNotIn(SECRET, "\n".join(logs.output))

	def test_begin_failures_name_their_class(self):
		with self.assertLogs(hooks.log, "DEBUG") as logs, patch.object(hooks, "native_snapshot", side_effect=RuntimeError(SECRET)):
			self.assertIsNone(self.begin())
		self.assert_logged(logs, "Completion begin observation unavailable (RuntimeError)")
		with self.assertLogs(hooks.log, "DEBUG") as logs, patch.object(self.observer.store, "begin_run", side_effect=OSError(SECRET)):
			self.observer.on_pre_llm_call(**self.payload(turn="second"))
		self.assert_logged(logs, "Turn start unavailable (OSError)")

	def test_end_failures_name_their_class_and_done_stays_independent(self):
		self.begin()
		with self.assertLogs(hooks.log, "DEBUG") as logs, patch.object(self.observer.store, "end_run", side_effect=OSError(SECRET)):
			self.assertIsNone(self.end())
		self.assert_logged(logs, "Turn end unavailable (OSError)")
		self.assertEqual(self.markers()["human"]["done_token"], "human:task:turn1")
		self.observer.on_pre_llm_call(**self.payload(turn="second"))
		with self.assertLogs(hooks.log, "DEBUG") as logs, patch.object(hooks, "native_snapshot", side_effect=RuntimeError(SECRET)):
			self.observer.on_session_end(**self.payload(turn="second", completed=True, failed=False, interrupted=False))
		self.assert_logged(logs, "Turn end snapshot unavailable (RuntimeError)")
		self.observer.on_pre_llm_call(**self.payload(turn="third"))
		with self.assertLogs(hooks.log, "DEBUG") as logs, patch.object(self.observer.store, "record", side_effect=OSError(SECRET)):
			self.assertIsNone(self.observer.on_session_end(**self.payload(turn="third", completed=True, failed=False, interrupted=False)))
		self.assert_logged(logs, "Completion end observation unavailable (OSError)")


class SubagentDiagnostics(unittest.TestCase):
	setUp = subagent_fixture.AuthoritySubagents.setUp
	start_patch = subagent_fixture.AuthoritySubagents.start_patch
	authorize = subagent_fixture.AuthoritySubagents.authorize
	active_list = subagent_fixture.AuthoritySubagents.active_list
	child = subagent_fixture.AuthoritySubagents.child
	runtime = subagent_fixture.AuthoritySubagents.runtime
	count = subagent_fixture.AuthoritySubagents.count

	def test_failed_authority_projection_stays_unknown_and_names_its_class(self):
		with self.assertLogs(backend.__name__, "DEBUG") as logs, patch.object(subagent_fixture.ancillary, "read", AsyncMock(side_effect=RuntimeStoreError(SECRET))):
			self.assertIsNone(self.count())
		self.assertIn("Subagent projection unavailable (RuntimeStoreError)", [record.getMessage() for record in logs.records])
		self.assertNotIn(SECRET, "\n".join(logs.output))


class BackendDiagnostics(unittest.TestCase):
	def test_failed_standalone_count_stays_unknown_and_names_its_class(self):
		with self.assertLogs(backend.__name__, "DEBUG") as logs:
			self.assertIsNone(backend.standalone_subagent_count(None, {}, None, None, None))
		self.assertEqual([record.getMessage() for record in logs.records], ["Running subagent count unavailable (TypeError)"])

	def test_failed_sampler_start_never_fails_the_runtime_poll_and_names_its_class(self):
		temp = tempfile.TemporaryDirectory(prefix="hermes-t3sidebar-diagnostics-")
		self.addCleanup(temp.cleanup)
		async def runtime_reader(request, profile):
			return {"sessions": []}
		def sampler():
			raise RuntimeError(SECRET)
		app = FastAPI()
		app.include_router(backend.create_router(Path(temp.name) / "state.sqlite3", profile_reader=lambda: "default", runtime_reader=runtime_reader, limits_sampler=sampler))
		with TestClient(app) as client, self.assertLogs(backend.__name__, "DEBUG") as logs:
			response = client.get("/runtime?profile=default")
		self.assertEqual(response.status_code, 200, response.text)
		self.assertEqual(response.json(), {"sessions": [], "profile": "default"})
		self.assertEqual([record.getMessage() for record in logs.records], ["Limits sampler unavailable (RuntimeError)"])
		self.assertNotIn(SECRET, "\n".join(logs.output))


if __name__ == "__main__":
	unittest.main()
