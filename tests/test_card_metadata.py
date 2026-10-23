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
		actor = Principal("owner", "scratch-profile", frozenset({"session:read"}), "http")
		async def active(*args):
			return {"sessions": [{"id": "human", "source": "cli"}, {"id": "job", "source": "cron"}]}
		with patch("hermes_cli.web_server_sessions._session_mutation_context", return_value=(object(), actor)), patch("gateway.session_active_list.active_list", active):
			result = asyncio.run(backend.native_runtime(SimpleNamespace(state=SimpleNamespace()), "scratch-profile"))
		self.assertEqual(result["sessions"], [{"id": "human", "source": "cli"}])
