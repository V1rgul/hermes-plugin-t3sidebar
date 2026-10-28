"""Usage history aggregation: time attribution, buckets, human messages, pricing and the read-only cache."""
from contextlib import closing
from datetime import datetime
import hashlib
import importlib.util
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("usage_history_test", ROOT / "usage_history.py")
assert SPEC is not None and SPEC.loader is not None
history = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(history)

PARIS = ZoneInfo("Europe/Paris")
NEW_YORK = ZoneInfo("America/New_York")
SCHEMA = """
CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, parent_session_id TEXT, title TEXT, started_at REAL NOT NULL);
CREATE TABLE messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, tool_calls TEXT,
	reasoning TEXT, reasoning_content TEXT, timestamp REAL NOT NULL, token_count INTEGER, active INTEGER NOT NULL DEFAULT 1,
	compacted INTEGER NOT NULL DEFAULT 0, display_kind TEXT, _compressed_summary INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_messages_session ON messages(session_id, timestamp);
CREATE TABLE session_model_usage (
	session_id TEXT NOT NULL, model TEXT NOT NULL, billing_provider TEXT NOT NULL DEFAULT '', billing_base_url TEXT NOT NULL DEFAULT '',
	billing_mode TEXT NOT NULL DEFAULT '', task TEXT NOT NULL DEFAULT '', api_call_count INTEGER NOT NULL DEFAULT 0,
	input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
	cache_write_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL NOT NULL DEFAULT 0,
	actual_cost_usd REAL NOT NULL DEFAULT 0, cost_status TEXT, cost_source TEXT, first_seen REAL, last_seen REAL,
	PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task)
);
"""
# Linear test prices per token, deliberately distinct per class so a misattributed class shows up in the cost.
RATES = {"input_tokens": 1e-3, "output_tokens": 4e-3, "cache_read_tokens": 1e-4, "cache_write_tokens": 2e-3}


def linear_price(provider, model, usage):
	return sum(usage[name] * rate for name, rate in RATES.items())


def local(zone, *parts):
	return datetime(*parts, tzinfo=zone).timestamp()


class Fixture:
	def __init__(self, directory):
		self.path = Path(directory) / "state.db"
		with closing(sqlite3.connect(self.path)) as conn:
			conn.executescript(SCHEMA)

	def run(self, sql, *args):
		with closing(sqlite3.connect(self.path)) as conn, conn:
			conn.execute(sql, args)

	def session(self, session_id, source="desktop", parent=None, started_at=1.0):
		self.run("INSERT INTO sessions (id, source, parent_session_id, started_at) VALUES (?, ?, ?, ?)", session_id, source, parent, started_at)

	def message(self, session_id, role, timestamp, content="", tool_calls=None, reasoning=None, display_kind=None, compressed=0):
		self.run(
			"INSERT INTO messages (session_id, role, content, tool_calls, reasoning, reasoning_content, timestamp, display_kind, _compressed_summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			session_id, role, content, tool_calls, reasoning, reasoning, timestamp, display_kind, compressed,
		)

	def usage(self, session_id, model, provider, first_seen, last_seen, *, task="", calls=1, input=0, output=0, cache_read=0, cache_write=0, reasoning=0):
		self.run(
			"INSERT INTO session_model_usage (session_id, model, billing_provider, task, api_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			session_id, model, provider, task, calls, input, output, cache_read, cache_write, reasoning, first_seen, last_seen,
		)


def series(payload, key, view="by_model"):
	return next(entry for entry in payload[view] if entry["key"] == key)


class UsageHistoryTests(unittest.TestCase):
	def setUp(self):
		history.clear_cache()
		self.tmp = tempfile.TemporaryDirectory()
		self.db = Fixture(self.tmp.name)
		# Wednesday 2026-10-14 12:30 Paris; the daily window is Oct 8..14.
		self.now = local(PARIS, 2026, 10, 14, 12, 30)
		self.day = [local(PARIS, 2026, 10, day) for day in range(8, 16)]

	def tearDown(self):
		history.clear_cache()
		self.tmp.cleanup()

	def payload(self, days=7, tz="Europe/Paris", now=None, pricing=linear_price):
		return history.history_payload(self.db.path, days=days, tz=tz, now=self.now if now is None else now, pricing=pricing)

	def test_input_follows_context_and_output_follows_reply_size(self):
		first, second = self.day[5] + 3600, self.day[6] + 3600
		self.db.session("s1")
		self.db.message("s1", "user", first - 10, "u" * 9)
		self.db.message("s1", "assistant", first, "a" * 20, reasoning="r" * 10)
		self.db.message("s1", "tool", first + 1, "t" * 60)
		self.db.message("s1", "assistant", second, "", tool_calls="c" * 9)
		# Context before call 1 = 9 chars, before call 2 = 9 + 20 + 10 + 60 = 99; the +1 keeps weights positive.
		self.db.usage("s1", "gpt-x", "openai-codex", first, second, calls=2, input=1100, cache_read=2200, output=410, reasoning=41)
		payload = self.payload()
		entry = series(payload, "openai-codex/gpt-x")
		self.assertEqual(entry["input"][5:7], [100, 1000])
		self.assertEqual(entry["cache_read"][5:7], [200, 2000])
		# Reply sizes 30 and 9 -> weights 31 and 10.
		self.assertEqual(entry["output"][5:7], [310, 100])
		self.assertEqual(entry["reasoning"][5:7], [31, 10])
		self.assertEqual(entry["tokens"][5:7], [610, 3100])
		self.assertEqual(entry["label"], "gpt-x")
		self.assertEqual(entry["provider"], "openai-codex")
		self.assertAlmostEqual(entry["cost_usd"][5], 100e-3 + 200e-4 + 310 * 4e-3, places=6)
		self.assertAlmostEqual(entry["cost_usd"][6], 1000e-3 + 2000e-4 + 100 * 4e-3, places=6)
		self.assertEqual(payload["totals"]["tokens"], 3710)
		self.assertEqual(payload["resolution"], "day")
		self.assertTrue(payload["approximate"])
		for name in ("tokens", "input", "output", "cache_read", "cache_write", "reasoning", "cost_usd", "user_messages"):
			self.assertEqual(len(entry[name]), 7)

	def test_compaction_copies_are_counted_once(self):
		call = self.day[6] + 60
		self.db.session("s1")
		self.db.message("s1", "user", call - 5, "u" * 9)
		self.db.message("s1", "assistant", call, "a" * 20)
		# In-place compaction rewrites the same rows under new ids.
		self.db.message("s1", "user", call - 5, "u" * 9)
		self.db.message("s1", "assistant", call, "a" * 20)
		self.db.message("s1", "assistant", call + 600, "b" * 20)
		self.db.usage("s1", "m", "p", call, call + 600, calls=2, input=40)
		entry = series(self.payload(), "p/m")
		# Contexts 9 and 29 (not 18 and 58) -> weights 10 and 30.
		self.assertEqual(entry["input"][6], 40)
		self.assertEqual(entry["user_messages"][6], 1)
		layout = history._layouts[(str(self.db.path.resolve()), "s1")][1]
		self.assertEqual(layout[0][0][1], [0.25, 0.75])

	def test_model_switch_inside_a_session(self):
		early, late = self.day[3] + 1000, self.day[5] + 1000
		self.db.session("s1")
		self.db.message("s1", "user", early - 5, "hello")
		self.db.message("s1", "assistant", early, "a" * 10)
		self.db.message("s1", "assistant", early + 100, "a" * 10)
		self.db.message("s1", "user", late - 5, "switch")
		self.db.message("s1", "assistant", late, "b" * 10)
		self.db.usage("s1", "alpha", "anthropic", early, early + 100, calls=2, input=500, output=50)
		self.db.usage("s1", "beta", "openai-codex", late, late, calls=1, input=70, output=7)
		payload = self.payload()
		alpha, beta = series(payload, "anthropic/alpha"), series(payload, "openai-codex/beta")
		self.assertEqual(sum(alpha["input"]), 500)
		self.assertEqual(alpha["input"][3], 500)
		self.assertEqual(beta["input"], [0, 0, 0, 0, 0, 70, 0])
		# Each user message belongs to the model that answered it.
		self.assertEqual(alpha["user_messages"][3], 1)
		self.assertEqual(beta["user_messages"][5], 1)
		self.assertEqual([entry["key"] for entry in payload["by_provider"]], ["anthropic", "openai-codex"])

	def test_auxiliary_and_unmatched_rows_spread_evenly(self):
		self.db.session("s1")
		self.db.message("s1", "assistant", self.day[6] + 10, "main")
		# Three calls spread over first_seen, midpoint, last_seen: days 4, 5 and 6.
		self.db.usage("s1", "luna", "openai-codex", self.day[4] + 3600, self.day[6] + 3600, task="title_generation", calls=3, input=300, output=30)
		# A main-loop row whose window contains no assistant message.
		self.db.session("s2")
		self.db.usage("s2", "sol", "openai-codex", self.day[2] + 7200, self.day[3] + 7200, calls=2, input=50)
		payload = self.payload()
		self.assertEqual(series(payload, "openai-codex/luna")["input"], [0, 0, 0, 0, 100, 100, 100])
		self.assertEqual(series(payload, "openai-codex/luna")["output"], [0, 0, 0, 0, 10, 10, 10])
		self.assertEqual(series(payload, "openai-codex/sol")["input"], [0, 0, 25, 25, 0, 0, 0])
		self.assertEqual(series(payload, "openai-codex", "by_provider")["input"], [0, 0, 25, 25, 100, 100, 100])

	def test_rows_straddling_the_window_keep_full_session_weights(self):
		before, inside = self.day[0] - 3600, self.day[6] + 60
		self.db.session("s1")
		self.db.message("s1", "user", before - 5, "u" * 9)
		self.db.message("s1", "assistant", before, "a" * 20)
		self.db.message("s1", "assistant", inside, "b")
		self.db.usage("s1", "m", "p", before, inside, calls=2, input=400)
		entry = series(self.payload(), "p/m")
		# Weights 10 and 30 computed over the whole session; only the in-window share is shown.
		self.assertEqual(sum(entry["input"]), 300)
		self.db.session("s2")
		self.db.usage("s2", "old", "p", before - 86400 * 3, before - 86400 * 2, calls=1, input=999)
		history.clear_cache()
		self.assertNotIn("p/old", [entry["key"] for entry in self.payload()["by_model"]])

	def test_daily_buckets_across_dst_in_paris_and_new_york(self):
		self.db.session("s1")
		paris_now = local(PARIS, 2026, 10, 27, 9)
		payload = self.payload(now=paris_now)
		self.assertEqual(payload["buckets"], [int(local(PARIS, 2026, 10, day)) for day in range(21, 28)])
		gaps = [b - a for a, b in zip(payload["buckets"], payload["buckets"][1:])]
		# Oct 25 2026 is the 25-hour fall-back day in Paris.
		self.assertEqual(gaps, [86400, 86400, 86400, 86400, 90000, 86400])
		ny_now = local(NEW_YORK, 2026, 11, 3, 20)
		payload = self.payload(tz="America/New_York", now=ny_now)
		self.assertEqual(payload["buckets"], [int(local(NEW_YORK, 2026, 10, day)) for day in range(28, 32)] + [int(local(NEW_YORK, 2026, 11, day)) for day in range(1, 4)])
		self.assertEqual(payload["buckets"][5] - payload["buckets"][4], 90000)
		self.assertEqual(payload["tz"], "America/New_York")
		spring = self.payload(tz="America/New_York", now=local(NEW_YORK, 2027, 3, 16, 1), days=30)
		self.assertEqual(len(spring["buckets"]), 30)
		self.assertIn(82800, [b - a for a, b in zip(spring["buckets"], spring["buckets"][1:])])

	def test_bucket_edges_assign_to_the_later_bucket_and_drop_outside_points(self):
		self.db.session("s1")
		edge = self.day[3]
		self.db.message("s1", "assistant", edge, "x")
		self.db.message("s1", "assistant", self.day[0] - 0.001, "x")
		self.db.message("s1", "assistant", self.day[7], "x")
		self.db.usage("s1", "a", "p", edge, edge, calls=1, input=10)
		self.db.usage("s1", "b", "p", self.day[0] - 0.001, self.day[0] - 0.001, calls=1, input=10)
		self.db.usage("s1", "c", "p", self.day[7], self.day[7], calls=1, input=10)
		history.clear_cache()
		payload = self.payload(now=self.day[7] - 1)
		self.assertEqual(series(payload, "p/a")["input"], [0, 0, 0, 10, 0, 0, 0])
		keys = [entry["key"] for entry in payload["by_model"]]
		self.assertNotIn("p/b", keys)
		self.assertNotIn("p/c", keys)

	def test_hourly_mode_across_spring_forward(self):
		# 2026-03-29 02:00 Paris jumps to 03:00; buckets stay one real hour apart.
		now = local(PARIS, 2026, 3, 29, 12, 40)
		self.db.session("s1")
		call = local(PARIS, 2026, 3, 29, 3, 15)
		self.db.message("s1", "assistant", call, "x")
		self.db.usage("s1", "m", "p", call, call, calls=1, input=5, output=1)
		payload = self.payload(days=1, now=now)
		self.assertEqual(payload["resolution"], "hour")
		self.assertEqual(len(payload["buckets"]), 24)
		self.assertEqual(payload["buckets"][-1], int(local(PARIS, 2026, 3, 29, 12)))
		self.assertEqual({b - a for a, b in zip(payload["buckets"], payload["buckets"][1:])}, {3600})
		entry = series(payload, "p/m")
		index = payload["buckets"].index(int(local(PARIS, 2026, 3, 29, 3)))
		self.assertEqual(entry["tokens"][index], 6)
		self.assertEqual(datetime.fromtimestamp(payload["buckets"][index - 1], PARIS).hour, 1)
		half_hour = history.history_payload(self.db.path, days=1, tz="Asia/Kolkata", now=now, pricing=linear_price)
		self.assertEqual(datetime.fromtimestamp(half_hour["buckets"][-1], ZoneInfo("Asia/Kolkata")).minute, 0)

	def test_user_messages_count_only_human_rows(self):
		call = self.day[6] + 600
		for session_id, source in (("human", "desktop"), ("cron", "cron"), ("sub", "subagent"), ("kanban", "kanban"), ("tool", "tool")):
			self.db.session(session_id, source)
			self.db.message(session_id, "user", call - 60, "please do it")
			self.db.message(session_id, "assistant", call, "ok")
			self.db.usage(session_id, "m", "p", call, call, calls=1, input=1)
		self.db.message("human", "user", call - 50, "change of plan", display_kind="steer")
		self.db.message("human", "user", call - 40, "[IMPORTANT: Background process proc_1 completed normally]")
		self.db.message("human", "user", call - 30, "done", display_kind="process_complete")
		self.db.message("human", "user", call - 20, "[CONTEXT COMPACTION — REFERENCE ONLY] summary")
		self.db.message("human", "user", call - 10, "summary", compressed=1)
		self.db.message("human", "user", call - 9, "✔ [default] @default Kanban t_123 done — x")
		self.db.message("human", "user", call - 8, "[Heartbeat — recurring instruction, fires every 1h]")
		self.db.message("human", "user", call - 7, "[IMPORTANT: The user has invoked the \"plan\" skill]")
		# A continuation child carries a verbatim copy of an earlier human message.
		self.db.session("child", "desktop", parent="human")
		self.db.message("child", "user", call - 60, "please do it")
		self.db.message("child", "user", call + 100, "next question")
		self.db.message("child", "assistant", call + 200, "answer")
		self.db.usage("child", "m2", "p", call + 200, call + 200, calls=1, input=1)
		payload = self.payload()
		# please do it + steer + skill invocation in the parent, next question in the child.
		self.assertEqual(series(payload, "p/m")["user_messages"][6], 3)
		self.assertEqual(series(payload, "p/m2")["user_messages"][6], 1)
		self.assertEqual(payload["totals"]["user_messages"], 4)
		self.assertEqual(series(payload, "p", "by_provider")["user_messages"][6], 4)

	def test_unanswered_user_message_goes_to_the_dominant_main_model(self):
		call = self.day[6] + 600
		self.db.session("s1")
		self.db.message("s1", "assistant", call, "ok")
		self.db.message("s1", "user", call + 50, "still there?")
		self.db.usage("s1", "small", "p", call, call, calls=1, input=1)
		self.db.usage("s1", "big", "p", call - 9000, call - 8000, calls=1, input=100)
		self.db.usage("s1", "aux", "p", call, call, task="title_generation", calls=1, input=1000)
		payload = self.payload()
		self.assertEqual(sum(series(payload, "p/big")["user_messages"]), 1)
		self.assertEqual(payload["totals"]["user_messages"], 1)

	def test_pricing_maps_subscription_providers_and_reports_missing(self):
		seen = []

		def pricing(provider, model, usage):
			seen.append(provider)
			return None if model == "mystery" else linear_price(provider, model, usage)

		call = self.day[6] + 60
		self.db.session("s1")
		self.db.message("s1", "assistant", call, "x")
		self.db.usage("s1", "sol", "openai-codex", call, call, calls=1, input=10)
		self.db.usage("s1", "opus", "anthropic", call, call, calls=1, output=10)
		self.db.usage("s1", "mystery", "copilot", call, call, calls=1, input=10)
		self.db.usage("s1", "nameless", "", call, call, calls=1, input=7)
		payload = self.payload(pricing=pricing)
		self.assertIn("openai", seen)
		self.assertIn("anthropic", seen)
		self.assertIn("copilot", seen)
		self.assertNotIn("openai-codex", seen)
		self.assertIn(None, seen)
		self.assertEqual(payload["pricing_missing"], ["copilot/mystery"])
		self.assertEqual(series(payload, "copilot/mystery")["cost_usd"][6], 0.0)
		self.assertAlmostEqual(series(payload, "openai-codex/sol")["cost_usd"][6], 0.01)
		unknown = series(payload, "unknown", "by_provider")
		self.assertEqual(unknown["tokens"][6], 7)
		self.assertEqual(series(payload, "unknown/nameless")["provider"], "unknown")
		self.assertAlmostEqual(payload["totals"]["cost_usd"], 0.01 + 0.04 + 0.007, places=6)

	def test_class_costs_keep_tiered_total_and_probe_proportions(self):
		def tiered(provider, model, usage):
			# Whole-request tier: above 1500 prompt tokens per call every class costs double, and each call carries a flat fee the class probes must cancel out.
			calls = usage["request_count"]
			prompt = (usage["input_tokens"] + usage["cache_read_tokens"] + usage["cache_write_tokens"]) / calls
			return linear_price(provider, model, usage) * (2 if prompt > 1500 else 1) + 0.5 * calls

		row = history._Row(("s", "m", "p", "", 2, 1000, 500, 3000, 0, 0, 1.0, 2.0))
		costs, priced = history.row_class_costs(tiered, "p", row)
		self.assertTrue(priced)
		total = tiered("p", "m", {"input_tokens": 1000, "output_tokens": 500, "cache_read_tokens": 3000, "cache_write_tokens": 0, "reasoning_tokens": 0, "request_count": 2})
		self.assertAlmostEqual(sum(costs.values()), total)
		# 6.6 of tiered token cost plus the 1.0 flat fee, shared in token-cost proportions.
		scale = 7.6 / 6.6
		self.assertAlmostEqual(costs["input"], 2 * 1.0 * scale)
		self.assertAlmostEqual(costs["output"], 2 * 2.0 * scale)
		self.assertAlmostEqual(costs["cache_read"], 2 * 0.3 * scale)
		self.assertEqual(costs["cache_write"], 0.0)
		costs, priced = history.row_class_costs(lambda provider, model, usage: None, "p", row)
		self.assertFalse(priced)
		self.assertEqual(sum(costs.values()), 0.0)

	def test_cache_hits_until_the_data_changes(self):
		calls = []

		def counting(provider, model, usage):
			calls.append(model)
			return linear_price(provider, model, usage)

		call = self.day[6] + 60
		self.db.session("s1")
		self.db.message("s1", "assistant", call, "x")
		self.db.usage("s1", "m", "p", call, call, calls=1, input=10)
		first = self.payload(pricing=counting)
		priced = len(calls)
		self.assertGreater(priced, 0)
		later = self.payload(pricing=counting, now=self.now + 60)
		self.assertEqual(len(calls), priced)
		self.assertEqual(later["generated_at"], self.now + 60)
		self.assertEqual(later["by_model"], first["by_model"])
		later["by_model"][0]["input"][6] = -1
		self.assertEqual(self.payload(pricing=counting)["by_model"][0]["input"][6], 10)
		self.db.run("UPDATE session_model_usage SET input_tokens = 30, last_seen = ?", call + 1)
		self.assertEqual(series(self.payload(pricing=counting), "p/m")["input"][6], 30)
		self.db.message("s1", "user", call - 5, "a new human message")
		self.assertEqual(self.payload(pricing=counting)["totals"]["user_messages"], 1)

	def test_database_is_opened_read_only(self):
		call = self.day[6] + 60
		self.db.session("s1")
		self.db.message("s1", "user", call - 1, "hi")
		self.db.message("s1", "assistant", call, "x")
		self.db.usage("s1", "m", "p", call, call, calls=1, input=10)
		before = (hashlib.sha256(self.db.path.read_bytes()).hexdigest(), os.stat(self.db.path).st_mtime_ns, sorted(os.listdir(self.tmp.name)))
		self.payload()
		history.clear_cache()
		self.payload(days=90)
		after = (hashlib.sha256(self.db.path.read_bytes()).hexdigest(), os.stat(self.db.path).st_mtime_ns, sorted(os.listdir(self.tmp.name)))
		self.assertEqual(before, after)
		with history._connect(self.db.path) as conn:
			with self.assertRaises(sqlite3.OperationalError):
				conn.execute("INSERT INTO sessions (id, source, started_at) VALUES ('x', 'desktop', 1)")

	def test_missing_tables_and_empty_windows_are_empty(self):
		empty = Path(self.tmp.name) / "empty.db"
		with closing(sqlite3.connect(empty)) as conn:
			conn.execute("CREATE TABLE unrelated (x)")
		payload = history.history_payload(empty, days=30, tz="UTC", now=self.now, pricing=linear_price)
		self.assertEqual((payload["by_model"], payload["by_provider"], payload["pricing_missing"]), ([], [], []))
		self.assertEqual(payload["totals"], {"tokens": 0, "cost_usd": 0.0, "user_messages": 0})
		self.assertEqual(len(payload["buckets"]), 30)

	def test_rejects_bad_arguments(self):
		for days in (0, 2, 365, True, "7", 7.0):
			with self.assertRaises(ValueError):
				self.payload(days=days)
		for tz in ("Mars/Base", "", "../etc/passwd", None):
			with self.assertRaises(ValueError):
				self.payload(tz=tz)
		with self.assertRaises(ValueError):
			self.payload(now=float("nan"))

	def test_series_sorted_by_tokens_and_rounding_preserves_totals(self):
		self.db.session("s1")
		times = [self.day[index] + 100 for index in range(7)]
		for timestamp in times:
			self.db.message("s1", "assistant", timestamp, "x")
		# Seven calls with context weights 1..7 splitting 10 tokens: rounding must not lose or invent any.
		self.db.usage("s1", "small", "p", times[0], times[-1], calls=7, input=10)
		self.db.usage("s1", "large", "q", times[0], times[-1], calls=7, input=1000)
		payload = self.payload()
		self.assertEqual([entry["key"] for entry in payload["by_model"]], ["q/large", "p/small"])
		self.assertEqual(sum(series(payload, "p/small")["input"]), 10)
		self.assertEqual(payload["totals"]["tokens"], 1010)
		for entry in payload["by_model"]:
			self.assertTrue(all(type(value) is int for value in entry["tokens"]))
			self.assertTrue(all(type(value) is float for value in entry["cost_usd"]))
			self.assertIsInstance(entry["model"], str)
		self.assertIsNone(payload["by_provider"][0]["model"])


@unittest.skipUnless(importlib.util.find_spec("agent") is not None, "Hermes agent package not importable")
class HermesPricingTests(unittest.TestCase):
	def setUp(self):
		history.clear_cache()

	def test_codex_rows_are_priced_at_openai_list_price_per_request(self):
		from agent.usage_pricing import CanonicalUsage, estimate_usage_cost
		# Ten 100k-token requests stay below GPT-6's 272K whole-request tier even though the row sums to 1M.
		row = {"input_tokens": 1_000_000, "output_tokens": 100_000, "cache_read_tokens": 0, "cache_write_tokens": 0, "reasoning_tokens": 0, "request_count": 10}
		expected = estimate_usage_cost("gpt-6.1-sol", CanonicalUsage(input_tokens=100_000, output_tokens=10_000), provider="openai")
		self.assertIsNotNone(expected.amount_usd)
		self.assertAlmostEqual(history._hermes_price("openai", "gpt-6.1-sol", row), float(expected.amount_usd) * 10)
		self.assertIsNone(history._hermes_price("openai-codex", "gpt-6.1-sol", row))
		self.assertIsNone(history._hermes_price(None, "gpt-6.1-sol", row))


if __name__ == "__main__":
	unittest.main()
