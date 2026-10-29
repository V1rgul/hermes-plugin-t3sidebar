"""Card enrichment uses native scratch stores only; no prompts/configs leave the API."""
import asyncio
from contextlib import closing
import json
import sqlite3
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from hermes_state import SessionDB
from hermes_cli import projects_db
from gateway.session_contract import Principal

from test_backend import backend


class CardMetadata(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="card-metadata-")
		self.addCleanup(self.temp.cleanup)
		self.root = Path(self.temp.name)
		self.db_path = self.root / "native.sqlite3"

	def sessions(self, *organized):
		with patch("hermes_cli.web_server_sessions._open_session_db_for_profile", side_effect=lambda profile, *, read_only: SessionDB(self.db_path, read_only=read_only)):
			return backend.native_sessions("scratch-profile", 0, 500, organized)["sessions"]

	def test_native_projects_longest_folder_multiple_folders_archived_and_boundary(self):
		with closing(projects_db.connect(self.root / "projects.db")) as conn:
			outer = projects_db.create_project(conn, name="Native outer name", folders=["/repo", "/second"], icon="tree", color="#123456")
			inner = projects_db.create_project(conn, name="Inner workspace", folders=["/repo/nested"], icon="sparkles", color="#abcdef")
			archived = projects_db.create_project(conn, name="Archived", folders=["/repo/nested/old"])
			conn.execute("UPDATE projects SET archived = 1 WHERE id = ?", (archived,))
			conn.commit()
		with closing(SessionDB(self.db_path)) as db:
			for sid, cwd in [("outer", "/repo/src"), ("inner", "/repo/nested/src"), ("second", "/second/sub"), ("archived", "/repo/nested/old/src"), ("boundary", "/repo2"), ("home", None)]:
				db.create_session(sid, "cli", cwd=cwd)
		before = {path: path.read_bytes() for path in [self.db_path, self.root / "projects.db"]}
		# Enrichment must never invoke native schema-writing connect, even with a catalog.
		with patch.object(projects_db, "connect", side_effect=AssertionError("native write")):
			rows = {row["id"]: row for row in self.sessions()}
		self.assertEqual(rows["outer"]["project"], {"id": outer, "name": "Native outer name", "icon": "tree", "color": "#123456", "cwd": "/repo"})
		self.assertEqual(rows["inner"]["project"]["id"], inner)
		self.assertEqual(rows["second"]["project"]["id"], outer)
		self.assertEqual(rows["archived"]["project"]["id"], inner)
		self.assertEqual(rows["boundary"]["project"]["name"], "repo2")
		self.assertNotEqual(rows["boundary"]["project"]["id"], outer)
		self.assertEqual(rows["home"]["project"], {"id": "__no_project__", "name": "Home", "icon": None, "color": None, "cwd": None, "is_home": True})
		for path, content in before.items():
			self.assertEqual(path.read_bytes(), content)

	def test_compression_tip_provider_and_unique_conversation_tokens_no_secrets(self):
		with closing(SessionDB(self.db_path)) as db:
			for sid, parent, provider, inp, out in [("root", None, "old-provider", 100, 20), ("middle", "root", "middle-provider", 200, 30), ("tip", "middle", "actual-tip-provider", 300, 40)]:
				db.create_session(sid, "cli", parent_session_id=parent, model_config={"provider": provider, "gateway_runtime": {"provider": "wrong-fallback", "secret": "private-credential"}, "secret": "private-config"}, system_prompt="private-prompt")
				db.update_token_counts(sid, input_tokens=inp, output_tokens=out, cache_read_tokens=10000, cache_write_tokens=10000, reasoning_tokens=10000, model=f"{sid}-model", absolute=True)
				if sid != "tip":
					db.end_session(sid, "compression")
		before = self.db_path.read_bytes()
		with patch.object(SessionDB, "get_session", side_effect=AssertionError("no per-row full reads")):
			rows = self.sessions("middle")
		self.assertEqual(len(rows), 1)
		row = rows[0]
		self.assertEqual((row["id"], row["provider"], row["model"]), ("tip", "actual-tip-provider", "tip-model"))
		self.assertEqual((row["input_tokens"], row["output_tokens"], row["total_tokens"]), (600, 90, 690))
		self.assertEqual(row["source"], "cli")
		self.assertNotIn("private-", json.dumps(row))
		self.assertNotIn("model_config", row)
		self.assertNotIn("system_prompt", row)
		self.assertEqual(self.db_path.read_bytes(), before)

	def test_missing_catalog_and_invalid_config_are_honest_without_model_guess(self):
		with closing(SessionDB(self.db_path)) as db:
			for sid, config in [("missing", None), ("fallback", {"gateway_runtime": {"provider": "native-slug"}}), ("invalid", None), ("array", None)]:
				db.create_session(sid, "cli", cwd="/honest-basename", model_config=config)
				db.update_token_counts(sid, input_tokens=5, output_tokens=7, model="anthropic/not-provider-evidence", absolute=True)
			with db._conn:
				db._conn.execute("UPDATE sessions SET model_config = ? WHERE id = 'invalid'", ("{not json",))
				db._conn.execute("UPDATE sessions SET model_config = ? WHERE id = 'array'", ('["not-a-config"]',))
		rows = {row["id"]: row for row in self.sessions()}
		for sid in ("missing", "invalid", "array"):
			self.assertIsNone(rows[sid]["provider"])
		self.assertEqual(rows["fallback"]["provider"], "native-slug")
		self.assertEqual(rows["missing"]["project"]["name"], "honest-basename")
		self.assertEqual(rows["missing"]["total_tokens"], 12)
		self.assertFalse((self.root / "projects.db").exists())

	def test_subagent_tokens_join_their_conversation_once_across_nesting_and_compression(self):
		with closing(SessionDB(self.db_path)) as db:
			for sid, source, parent, config, inp, out in [
				("root", "cli", None, None, 100, 10),
				("tip", "cli", "root", None, 200, 20),
				# Delegates spawned from the earlier segment and from the tip, a nested delegate, and a compressed subagent whose continuation inherits the marker.
				("sub-a", "subagent", "root", {"_delegate_from": "root"}, 10, 1),
				("nested", "subagent", "sub-a", {"_delegate_from": "sub-a"}, 40, 4),
				("sub-b", "subagent", "tip", {"_delegate_from": "tip"}, 20, 2),
				("sub-b2", "subagent", "sub-b", {"_delegate_from": "tip"}, 30, 3),
				# A branch is its own card: neither conversation absorbs the other's usage.
				("branch", "cli", "tip", {"_branched_from": "tip"}, 1000, 100),
				("branch-sub", "subagent", "branch", {"_delegate_from": "branch"}, 500, 50),
				("other", "cli", None, None, 7, 3),
			]:
				db.create_session(sid, source, parent_session_id=parent, model_config=config)
				db.update_token_counts(sid, input_tokens=inp, output_tokens=out, model="fixture", absolute=True)
				if sid in ("root", "sub-b"):
					db.end_session(sid, "compression")
		before = self.db_path.read_bytes()
		with closing(SessionDB(self.db_path, read_only=True)) as db:
			queries = []
			assert db._conn is not None
			db._conn.set_trace_callback(queries.append)
			rows = {row["id"]: row for row in backend.card_rows(db, db.list_sessions_rich(compact_rows=True))}
		self.assertEqual(set(rows), {"tip", "branch", "other"})
		self.assertEqual((rows["tip"]["input_tokens"], rows["tip"]["output_tokens"], rows["tip"]["total_tokens"]), (400, 40, 440))
		self.assertEqual(rows["branch"]["total_tokens"], 1650)
		self.assertEqual(rows["other"]["total_tokens"], 10)
		self.assertEqual(sum("WITH RECURSIVE tree" in sql for sql in queries), 1)
		self.assertEqual(self.db_path.read_bytes(), before)

	def test_subagent_usage_keeps_unknown_counts_and_ignores_malformed_configs(self):
		with closing(sqlite3.connect(":memory:")) as connection:
			connection.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, model_config TEXT, input_tokens INTEGER, output_tokens INTEGER)")
			connection.executemany("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)", [
				("known", None, None, 5, 5),
				("known-sub", "known", '{"_delegate_from":"known"}', 3, 2),
				("malformed", "known", "{not json", 900, 900),
				("partial", None, None, 5, 5),
				("partial-sub", "partial", '{"_delegate_from":"partial"}', None, 2),
			])
			rows = {row["id"]: row for row in backend.card_rows(SimpleNamespace(_conn=connection), [{"id": "known", "input_tokens": 5, "output_tokens": 5}, {"id": "partial", "input_tokens": 5, "output_tokens": 5}])}
		self.assertEqual(rows["known"]["total_tokens"], 15)
		self.assertIsNone(rows["partial"]["input_tokens"])
		self.assertEqual(rows["partial"]["output_tokens"], 7)
		self.assertIsNone(rows["partial"]["total_tokens"])
		# Stores whose sessions table predates the marker column keep the conversation's own counts.
		with closing(sqlite3.connect(":memory:")) as connection:
			connection.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT)")
			rows = backend.card_rows(SimpleNamespace(_conn=connection), [{"id": "legacy", "input_tokens": 1, "output_tokens": 2}])
		self.assertEqual(rows[0]["total_tokens"], 3)

	def test_card_message_count_preserves_empty_evidence_without_inventing_unknown_history(self):
		with closing(SessionDB(self.db_path)) as db:
			db.create_session("empty", "desktop")
		before = self.db_path.read_bytes()
		rows = self.sessions()
		self.assertEqual(rows[0]["message_count"], 0)
		self.assertEqual(self.db_path.read_bytes(), before)
		projected = backend.card_rows(SimpleNamespace(), [
			{"id": "populated", "message_count": 6, "system_prompt": "private"},
			{"id": "unknown"},
		])
		self.assertEqual(projected[0]["message_count"], 6)
		self.assertNotIn("system_prompt", projected[0])
		self.assertNotIn("message_count", projected[1])

	def test_duplicate_segments_are_counted_once_and_unknown_counts_stay_null(self):
		db = SimpleNamespace(_get_session_rich_rows_batch=lambda ids, *, compact_rows: {"root": {"input_tokens": 3, "output_tokens": 4}, "tip": {"input_tokens": 5, "output_tokens": 6, "model_config": '{"provider":"tip"}'}})
		rows = backend.card_rows(db, [{"id": "tip", "_lineage_ids": ["root", "tip", "root"]}, {"id": "missing", "model": "openai/not-evidence"}])
		self.assertEqual(rows[0]["total_tokens"], 18)
		self.assertEqual(rows[0]["provider"], "tip")
		for key in ("provider", "input_tokens", "output_tokens", "total_tokens"):
			self.assertIsNone(rows[1][key])

	def test_batched_segments_partial_unknown_counts_and_tip_not_root(self):
		fetch = Mock(return_value={
			"root": {"input_tokens": 3, "output_tokens": 4, "model_config": {"provider": "root-only"}},
			"tip": {"input_tokens": 5, "output_tokens": None, "model": "tip-model", "model_config": None},
			"other": {"input_tokens": 0, "output_tokens": 0},
		})
		db = SimpleNamespace(_get_session_rich_rows_batch=fetch)
		rows = backend.card_rows(db, [
			{"id": "tip", "_lineage_ids": ["root", "tip", "root"], "model_config": {"provider": "must-not-use-root"}},
			{"id": "other", "_lineage_ids": ["other", "absent"]},
		])
		fetch.assert_called_once_with({"root", "tip", "other", "absent"}, compact_rows=True)
		self.assertIsNone(rows[0]["provider"])
		self.assertEqual(rows[0]["model"], "tip-model")
		self.assertEqual(rows[0]["input_tokens"], 8)
		self.assertIsNone(rows[0]["output_tokens"])
		self.assertIsNone(rows[0]["total_tokens"])
		self.assertIsNone(rows[1]["input_tokens"])
		self.assertIsNone(rows[1]["total_tokens"])

	def test_missing_provider_recovers_only_unambiguous_main_loop_billing(self):
		with closing(SessionDB(self.db_path)) as db:
			for sid in ("recorded", "mixed", "empty", "automatic", "explicit"):
				db.create_session(sid, "cli", model_config={"provider": "anthropic"} if sid == "explicit" else None)
			for sid in ("recorded", "mixed", "explicit"):
				db.update_token_counts(sid, input_tokens=5, output_tokens=2, model="fixture-main", billing_provider="openai-codex")
			db.record_auxiliary_usage("recorded", "vision", model="fixture-vision", billing_provider="anthropic", input_tokens=3)
			db.update_token_counts("mixed", input_tokens=5, output_tokens=2, model="fixture-switch", billing_provider="anthropic")
			db.update_token_counts("automatic", input_tokens=5, model="fixture-auto", billing_provider="auto")
		before = self.db_path.read_bytes()
		rows = {row["id"]: row for row in self.sessions()}
		self.assertEqual(rows["recorded"]["provider"], "openai-codex")
		self.assertEqual(rows["explicit"]["provider"], "anthropic")
		for sid in ("mixed", "empty", "automatic"):
			self.assertIsNone(rows[sid]["provider"])
		self.assertEqual(self.db_path.read_bytes(), before)

	def test_billing_fallback_rejects_conflicting_lineage_configuration(self):
		with closing(SessionDB(self.db_path)) as db:
			for prefix, provider in (("consistent", "openai-codex"), ("conflict", "anthropic")):
				db.create_session(prefix + "-root", "cli", model_config={"provider": provider})
				db.end_session(prefix + "-root", "compression")
				db.create_session(prefix + "-tip", "cli", parent_session_id=prefix + "-root")
				db.update_token_counts(prefix + "-tip", input_tokens=7, output_tokens=3, model="fixture-tip", billing_provider="openai-codex")
		rows = {row["id"]: row for row in self.sessions()}
		self.assertEqual(rows["consistent-tip"]["provider"], "openai-codex")
		self.assertIsNone(rows["conflict-tip"]["provider"])

	def test_billing_fallback_is_one_read_batch_and_degrades_on_missing_usage_table(self):
		with closing(SessionDB(self.db_path)) as db:
			for sid in ("one", "two", "three"):
				db.create_session(sid, "cli")
				db.update_token_counts(sid, input_tokens=3, model="fixture", billing_provider="openai-codex")
		with closing(SessionDB(self.db_path, read_only=True)) as db:
			queries = []
			assert db._conn is not None
			db._conn.set_trace_callback(queries.append)
			rows = backend.card_rows(db, db.list_sessions_rich(compact_rows=True))
			self.assertTrue(all(row["provider"] == "openai-codex" for row in rows))
			self.assertEqual(sum("FROM session_model_usage" in sql for sql in queries), 1)
		with closing(sqlite3.connect(":memory:")) as connection:
			rows = backend.card_rows(SimpleNamespace(_conn=connection), [{"id": "legacy", "model": "openai/not-evidence"}])
			self.assertIsNone(rows[0]["provider"])

	def test_explicit_tip_providers_skip_billing_reads_including_compressed_cards(self):
		with closing(SessionDB(self.db_path)) as db:
			for sid, parent, config in [
				("plain", None, {"provider": "explicit"}),
				("root", None, {"provider": "conflicting-root"}),
				("tip", "root", {"provider": "auto", "gateway_runtime": {"provider": "explicit-tip"}}),
			]:
				db.create_session(sid, "cli", parent_session_id=parent, model_config=config)
				db.update_token_counts(sid, input_tokens=2, output_tokens=3, model="fixture", billing_provider="conflicting-billing")
				db.record_auxiliary_usage(sid, "vision", model="fixture-vision", billing_provider="auxiliary")
				if sid == "root":
					db.end_session(sid, "compression")
		with closing(SessionDB(self.db_path, read_only=True)) as db:
			queries = []
			listed = db.list_sessions_rich(compact_rows=True)
			# Native listing can read usage, so count only card enrichment's query; the aggregate on the projected root must not mask explicit tip config.
			assert db._conn is not None
			db._conn.set_trace_callback(queries.append)
			with patch.object(backend, "card_billing_providers", wraps=backend.card_billing_providers) as billing:
				rows = {row["id"]: row for row in backend.card_rows(db, listed)}
			billing.assert_not_called()
			self.assertFalse(any("FROM session_model_usage" in sql for sql in queries))
		self.assertEqual(rows["plain"]["provider"], "explicit")
		self.assertEqual(rows["tip"]["provider"], "explicit-tip")
		self.assertEqual(rows["tip"]["total_tokens"], 10)

	def test_mixed_billing_batch_covers_only_complete_unresolved_tip_lineages(self):
		with closing(SessionDB(self.db_path)) as db:
			for prefix, root_provider, tip_provider in [
				("explicit", "root-conflict", "tip-wins"),
				("fallback", "route", None),
				("config-conflict", "other", "auto"),
				("billing-conflict", None, "unknown"),
			]:
				for suffix, parent, provider in [("root", None, root_provider), ("tip", prefix + "-root", tip_provider)]:
					sid = prefix + "-" + suffix
					db.create_session(sid, "cli", parent_session_id=parent, model_config={"provider": provider})
					db.update_token_counts(sid, input_tokens=2, output_tokens=3, model="fixture", billing_provider="other" if prefix == "billing-conflict" and suffix == "root" else "route")
					db.record_auxiliary_usage(sid, "vision", model="fixture-vision", billing_provider="auxiliary-conflict")
					if suffix == "root":
						db.end_session(sid, "compression")
			for sid, provider in [("explicit-plain", "plain-wins"), ("fallback-plain", "default"), ("no-evidence", None)]:
				db.create_session(sid, "cli", model_config={"provider": provider})
				if sid != "no-evidence":
					db.update_token_counts(sid, input_tokens=2, output_tokens=3, model="fixture", billing_provider="route")
		with closing(SessionDB(self.db_path, read_only=True)) as db:
			listed = db.list_sessions_rich(compact_rows=True)
			queries = []
			assert db._conn is not None
			db._conn.set_trace_callback(queries.append)
			with patch.object(backend, "card_billing_providers", wraps=backend.card_billing_providers) as billing:
				rows = {row["id"]: row for row in backend.card_rows(db, listed)}
			ids = {"fallback-plain", "no-evidence", *(prefix + "-" + suffix
				for prefix in ("fallback", "config-conflict", "billing-conflict") for suffix in ("root", "tip"))}
			billing.assert_called_once_with(db, ids)
			usage_queries = [sql for sql in queries if "FROM session_model_usage" in sql]
			self.assertEqual(len(usage_queries), 1)
			self.assertIn("task = ''", usage_queries[0])
			self.assertNotIn("'explicit-", usage_queries[0])
		self.assertEqual(rows["explicit-tip"]["provider"], "tip-wins")
		self.assertEqual(rows["explicit-plain"]["provider"], "plain-wins")
		for sid in ("fallback-tip", "fallback-plain"):
			self.assertEqual(rows[sid]["provider"], "route")
		for sid in ("config-conflict-tip", "billing-conflict-tip", "no-evidence"):
			self.assertIsNone(rows[sid]["provider"])
		for prefix in ("explicit", "fallback", "config-conflict", "billing-conflict"):
			self.assertEqual(rows[prefix + "-tip"]["total_tokens"], 10)

	def test_provider_only_accepts_explicit_strings(self):
		for config in (None, [], "null", "42", {"provider": 7}, {"gateway_runtime": []}):
			with self.subTest(config=config):
				self.assertIsNone(backend.card_provider(config))
		self.assertEqual(backend.card_provider({"provider": "  ", "gateway_runtime": {"provider": " actual "}}), "actual")

	def test_catalog_loaded_once_and_read_only_even_with_custom_names(self):
		with closing(projects_db.connect(self.root / "projects.db")) as conn:
			projects_db.create_project(conn, name="Not a basename", folders=["/workspace"])
		with closing(SessionDB(self.db_path)) as db:
			db.create_session("one", "cli", cwd="/workspace/one")
			db.create_session("two", "cli", cwd="/workspace/two")
		native_list = projects_db.list_projects
		def read_only_list(conn, **kwargs):
			with self.assertRaises(sqlite3.OperationalError):
				conn.execute("UPDATE projects SET name = 'forbidden'")
			return native_list(conn, **kwargs)
		with patch.object(projects_db, "projects_db_path", side_effect=AssertionError("global home forbidden")), patch.object(projects_db, "list_projects", side_effect=read_only_list) as catalog:
			rows = self.sessions()
		catalog.assert_called_once()
		self.assertEqual([row["project"]["name"] for row in rows], ["Not a basename"] * 2)

	def test_unreadable_catalog_falls_back_without_modification(self):
		catalog = self.root / "projects.db"
		catalog.write_bytes(b"not a sqlite database")
		with closing(SessionDB(self.db_path)) as db:
			db.create_session("one", "cli", cwd="/fallback")
		self.assertEqual(self.sessions()[0]["project"]["name"], "fallback")
		self.assertEqual(catalog.read_bytes(), b"not a sqlite database")

	def test_zero_counts_are_known_and_negative_counts_are_unknown(self):
		rows = backend.card_rows(SimpleNamespace(), [
			{"id": "zero", "input_tokens": 0, "output_tokens": 0, "cwd": " "},
			{"id": "bad", "input_tokens": -1, "output_tokens": True},
		])
		self.assertEqual(rows[0]["total_tokens"], 0)
		self.assertTrue(rows[0]["project"]["is_home"])
		for field in ("input_tokens", "output_tokens", "total_tokens"):
			self.assertIsNone(rows[1][field])

	def test_authority_runtime_cron_cannot_reappear(self):
		from hermes_constants import set_hermes_home_override, reset_hermes_home_override

		with closing(SessionDB(self.db_path)) as db:
			db.create_session("human", "cli")
		token = set_hermes_home_override(str(self.root))
		self.addCleanup(reset_hermes_home_override, token)
		actor = Principal("owner", str(self.root), frozenset({"session:read"}), "http")
		authority = SimpleNamespace(profile_id=str(self.root), db=SimpleNamespace(db_path=self.db_path))
		async def active(*args):
			return {"sessions": [{"id": "human", "source": "cli"}, {"id": "job", "source": "cron"}]}
		with patch("hermes_cli.web_server_sessions._session_mutation_context", return_value=(authority, actor)), patch("gateway.session_active_list.active_list", active):
			result = asyncio.run(backend.native_runtime(SimpleNamespace(state=SimpleNamespace()), "scratch-profile"))
		self.assertEqual([row["id"] for row in result["sessions"]], ["human"])
		self.assertIsNone(result["sessions"][0]["running_subagents"])
