"""Session menu figures from native scratch stores; read-only, exact ids, nothing beyond the displayed figures."""
from contextlib import closing
import sqlite3
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from hermes_state import SessionDB

from test_backend import backend
from native_fixture import native_fixture


class SessionStats(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="session-stats-")
		self.addCleanup(self.temp.cleanup)
		self.db_path = Path(self.temp.name) / "native.sqlite3"

	def stats(self, session_id):
		with patch.object(backend, "open_session_db", side_effect=lambda profile, *, read_only: SessionDB(self.db_path, read_only=read_only)):
			return backend.native_session_stats("scratch-profile", session_id)

	def times(self, **spans):
		"""Set (started_at, ended_at, end_reason) directly: the native writers stamp the wall clock."""
		with closing(sqlite3.connect(self.db_path)) as conn:
			for sid, (start, end, reason) in spans.items():
				conn.execute("UPDATE sessions SET started_at = ?, ended_at = ?, end_reason = ? WHERE id = ?", (start, end, reason, sid))
			conn.commit()

	def test_figures_cover_compressed_segments_subagent_runs_and_hermes_overhead(self):
		delegate = lambda parent: {"_delegate_from": parent}
		with closing(native_fixture(self.db_path)) as db:
			for sid, source, parent, config, tokens in [
				("root", "desktop", None, None, (100, 20)), ("tip", "desktop", "root", None, (300, 40)),
				# A reset fork of the root is another conversation, not this one's history.
				("fork", "desktop", "root", {"_branched_from": "root"}, (9000, 900)),
				("sub-a", "subagent", "root", delegate("root"), (10, 1)), ("nested", "subagent", "sub-a", delegate("sub-a"), (40, 4)),
				("sub-b", "subagent", "tip", delegate("tip"), (20, 2)), ("sub-b2", "subagent", "sub-b", delegate("tip"), (30, 3)),
				# Launched by sub-b itself before its compression: a real nested subagent, not its continuation.
				("nested-b", "subagent", "sub-b", delegate("sub-b"), (1, 1)),
				("sub-x", "subagent", "tip", delegate("tip"), (1, 1)), ("sub-c", "subagent", "tip", delegate("tip"), (5, 5)),
				("sub-e", "subagent", "tip", delegate("tip"), (1, 1)), ("sub-f", "subagent", "tip", delegate("tip"), (1, 1))]:
				db.create_session(sid, source, parent_session_id=parent, model_config=config)
				db.update_token_counts(sid, input_tokens=tokens[0], output_tokens=tokens[1], model="fixture", absolute=True)
			db.record_auxiliary_usage("root", "title_generation", model="fixture", input_tokens=7, output_tokens=3)
			db.record_auxiliary_usage("sub-a", "compression", model="fixture", input_tokens=5, output_tokens=5)
			db.record_auxiliary_usage("fork", "title_generation", model="fixture", input_tokens=500, output_tokens=500)
			# The tip's messages are written first: row ids are not chronological across segments.
			db.append_message("tip", "user", "next question", timestamp=300)
			db.append_message("tip", "assistant", "answer", timestamp=350)
			db.append_message("tip", "user", "[CONTEXT COMPACTION — REFERENCE ONLY] legacy summary without the flag", timestamp=400)
			db.append_message("root", "user", "hello", timestamp=100)
			db.append_message("root", "assistant", "", tool_calls=[{"id": "c1", "type": "function", "function": {"name": "terminal", "arguments": "{}"}}], timestamp=110)
			db.append_message("root", "tool", "ok", tool_call_id="c1", timestamp=111)
			db.append_message("root", "assistant", "done", timestamp=120)
			db.append_message("root", "user", "also this", display_kind="steer", timestamp=125)
			db.append_message("root", "user", "[IMPORTANT: Background process finished]", display_kind="process_complete", timestamp=130)
			db.append_message("root", "user", "[CONTEXT COMPACTION — REFERENCE ONLY] summary", _compressed_summary=True, timestamp=200)
			# The same compaction saved twice in one second counts once.
			db.append_message("root", "user", "[CONTEXT COMPACTION — REFERENCE ONLY] summary", _compressed_summary=True, timestamp=200.4)
			db.append_message("sub-c", "assistant", "last words", timestamp=2010)
			# Compression closes the root to new messages, so it ends after its transcript is written.
			db.end_session("root", "compression")
			db.append_message("fork", "user", "fork message", timestamp=150)
		self.times(**{"sub-a": (1000, 1100, "agent_close"), "nested": (1010, 1020, "agent_close"),
			# sub-b2 continues sub-b after its compression, so sub-x overlaps that one run.
			"sub-b": (1200, 1300, "compression"), "sub-b2": (1300, 1400, "agent_close"), "nested-b": (1210, 1220, "agent_close"), "sub-x": (1350, 1360, "agent_close"),
			# Reaped long after its last message: counting to the reaping would overlap sub-e and sub-f.
			"sub-c": (2000, 9000, "startup_orphan_reap"), "sub-e": (3000, 3100, "agent_close"), "sub-f": (3000, 3100, "agent_close")})
		before = self.db_path.read_bytes()
		value = self.stats("root")
		self.assertEqual(value, {"id": "root", "tokens": {"main": 460, "subagents": 128, "hermes": 20},
			"subagents": {"count": 8, "simultaneous": 2},
			# 100→120 and 125→200.4 in the root, 300→400 in the tip.
			"working_seconds": 195, "messages": 3, "model_calls": 3, "tool_calls": 1, "compressions": 2})
		self.assertEqual(self.db_path.read_bytes(), before)
		# The tip resolves to the same conversation.
		self.assertEqual(self.stats("tip"), {**value, "id": "tip"})

	def test_unknown_tokens_stay_null_and_segment_boundaries_count_as_compressions(self):
		with closing(native_fixture(self.db_path)) as db:
			for sid, parent in [("one", None), ("two", "one"), ("three", "two")]:
				db.create_session(sid, "cli", parent_session_id=parent)
				db.update_token_counts(sid, input_tokens=5, output_tokens=5, model="fixture", absolute=True)
				if sid != "three":
					db.end_session(sid, "compression")
		with closing(sqlite3.connect(self.db_path)) as conn:
			conn.execute("UPDATE sessions SET input_tokens = NULL WHERE id = 'two'")
			conn.commit()
		value = self.stats("three")
		self.assertIsNone(value["tokens"]["main"])
		self.assertEqual((value["compressions"], value["subagents"], value["messages"], value["working_seconds"]), (2, {"count": 0, "simultaneous": 0}, 0, 0))

	def test_route_is_profile_qualified_exact_and_reports_missing_sessions(self):
		with closing(native_fixture(self.db_path)) as db:
			db.create_session("present", "desktop")
		app = FastAPI()
		app.include_router(backend.create_router(Path(self.temp.name) / "state.sqlite3"), prefix="/api")
		with TestClient(app) as client, patch.object(backend, "served_profile", return_value="scratch-profile"), \
			patch.object(backend, "open_session_db", side_effect=lambda profile, *, read_only: SessionDB(self.db_path, read_only=read_only)) as opened:
			response = client.get("/api/sessions/present/stats?profile=scratch-profile")
			self.assertEqual(response.status_code, 200, response.text)
			self.assertEqual(response.headers["cache-control"], "no-store")
			self.assertEqual(set(response.json()), {"profile", "id", "tokens", "subagents", "working_seconds", "messages", "model_calls", "tool_calls", "compressions"})
			self.assertEqual(response.json()["profile"], "scratch-profile")
			self.assertTrue(all(call.kwargs["read_only"] for call in opened.call_args_list))
			self.assertEqual(client.get("/api/sessions/absent/stats").status_code, 404)
			self.assertEqual(client.get("/api/sessions/present/stats?profile=foreign").status_code, 422)


if __name__ == "__main__":
	unittest.main()
