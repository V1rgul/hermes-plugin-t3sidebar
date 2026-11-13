"""Provider limit sampler + history store: scratch SQLite, fake collectors and clocks, no network or live auth."""

from contextlib import closing
import ast
import asyncio
import contextvars
from datetime import UTC, datetime
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("t3sidebar_usage_limits_test", ROOT / "usage_limits.py")
assert SPEC is not None and SPEC.loader is not None
limits = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(limits)

NOW = 1800000000.0


def window(key, used, resets_at=None, label=None, seconds=None, scope="account", model=None):
	return {"key": key, "label": label, "window_seconds": seconds, "scope": scope, "model": model, "used_percent": used, "resets_at": resets_at}


def account(account_id, fetched_at, windows, label=None, priority: "int | None" = 0, plan: "str | None" = "Pro", banked=None, error=None):
	snapshot = None if fetched_at is None else {"fetched_at": fetched_at, "plan": plan, "banked_resets": banked, "windows": windows}
	return {"id": account_id, "label": label or f"acct-{account_id}", "priority": priority, "error": error, "snapshot": snapshot}


def codex(*accounts, error=None):
	return [{"provider": "openai-codex", "error": error, "accounts": list(accounts)}]


def dt(epoch):
	return datetime.fromtimestamp(epoch, UTC)


class StoreTests(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="t3sidebar-limits-")
		self.addCleanup(self.temp.cleanup)
		self.path = Path(self.temp.name) / "plugin-data/hermes-t3sidebar/usage-limits.sqlite3"
		self.store = limits.LimitsStore(self.path, clock=lambda: NOW)

	def rows(self):
		with closing(sqlite3.connect(self.path)) as connection:
			return connection.execute("SELECT t, account_id, window_key, error FROM limit_samples ORDER BY t, rowid").fetchall()

	def test_unchanged_fetched_at_is_not_recorded_twice(self):
		reading = codex(account("7ad3ca", NOW - 60, [window("weekly", 40.0, NOW + 1000, "Weekly", 604800)]))
		self.assertEqual(self.store.record(reading, checked_at=NOW), 1)
		self.assertEqual(self.store.record(reading, checked_at=NOW + 300), 0)
		# An older snapshot (a late cache read) must not be appended either.
		older = codex(account("7ad3ca", NOW - 120, [window("weekly", 39.0, NOW + 1000)]))
		self.assertEqual(self.store.record(older, checked_at=NOW + 600), 0)
		newer = codex(account("7ad3ca", NOW + 250, [window("weekly", 41.0, NOW + 1000)]))
		self.assertEqual(self.store.record(newer, checked_at=NOW + 900), 1)
		self.assertEqual([row[0] for row in self.rows()], [NOW - 60, NOW + 250])

	def test_multi_account_pool_payload(self):
		self.store.record(codex(
			account("7ad3ca", NOW - 100, [window("five_hour", 10.0, NOW + 3600, "Session", 18000), window("weekly", 42.0, NOW + 9000, "Weekly", 604800)],
				label="codex-pro", priority=1, banked=2),
			account("7c202b", NOW - 50, [window("weekly", 80.0, NOW + 5000, "Weekly", 604800)], label="codex-team", priority=0, banked=0),
		), checked_at=NOW)
		payload = limits.limits_payload(self.store, hours=168, now=NOW, sampler_status=None)
		(provider,) = payload["providers"]
		self.assertEqual((provider["provider"], provider["label"], provider["error"]), ("openai-codex", "OpenAI Codex", None))
		self.assertEqual([a["id"] for a in provider["accounts"]], ["7c202b", "7ad3ca"])
		second = provider["accounts"][1]
		self.assertEqual((second["label"], second["priority"], second["plan"], second["banked_resets"]), ("codex-pro", 1, "Pro", 2))
		self.assertEqual([w["key"] for w in second["windows"]], ["five_hour", "weekly"])
		self.assertEqual(second["windows"][1]["remaining_percent"], 58.0)
		self.assertEqual(provider["accounts"][0]["banked_resets"], 0)
		self.assertEqual([(h["account"], h["window"], h["t"]) for h in provider["history"]],
			[("7ad3ca", "five_hour", [NOW - 100]), ("7ad3ca", "weekly", [NOW - 100]), ("7c202b", "weekly", [NOW - 50])])

	def test_model_scoped_windows_keep_model(self):
		self.store.record([{"provider": "anthropic", "error": None, "accounts": [account("a1b2c3", NOW - 10, [
			window("weekly", 20.0, None, "Current week"), window("weekly:opus", 90.0, None, "Opus week", scope="model", model="opus"),
		])]}], checked_at=NOW)
		(provider,) = limits.limits_payload(self.store, hours=1, now=NOW)["providers"]
		opus = provider["accounts"][0]["windows"][1]
		self.assertEqual((opus["key"], opus["scope"], opus["model"]), ("weekly:opus", "model", "opus"))
		# Samples stored without a duration get Anthropic's implied one on the way out.
		self.assertEqual([w["window_seconds"] for w in provider["accounts"][0]["windows"]], [604800, 604800])
		self.assertEqual(provider["label"], "Anthropic")

	def test_unknown_fields_stay_null(self):
		self.store.record(codex(account("7ad3ca", NOW - 10, [window("w3600", None, None)], plan=None, priority=None)), checked_at=NOW)
		(provider,) = limits.limits_payload(self.store, hours=1, now=NOW)["providers"]
		(acct,) = provider["accounts"]
		self.assertIsNone(acct["plan"])
		self.assertIsNone(acct["priority"])
		self.assertIsNone(acct["banked_resets"])
		self.assertEqual(acct["windows"], [{"key": "w3600", "label": None, "window_seconds": None, "scope": "account", "model": None,
			"used_percent": None, "remaining_percent": None, "resets_at": None}])
		self.assertEqual(provider["history"], [{"account": "7ad3ca", "window": "w3600", "t": [NOW - 10], "remaining_percent": [None], "resets_at": [None]}])

	def test_history_is_compacted_and_rounded_for_the_wire(self):
		# Seven readings five minutes apart: unchanged, a change, unchanged again; reset times jitter by microseconds and percentages carry many decimals.
		used = [10.0, 10.0, 10.0, 10.0, 33.333, 33.333, 33.333]
		for index, value in enumerate(used):
			t = NOW - 1800 + index * 300 + 0.4
			self.store.record(codex(account("7ad3ca", t, [window("weekly", value, NOW + 9000 + index * 1e-6)])), checked_at=t)
		(provider,) = limits.limits_payload(self.store, hours=1, now=NOW + 60)["providers"]
		(series,) = provider["history"]
		# Kept: the first reading, the last unchanged one before the change, the change, and the last; whole seconds and one decimal, ints when whole.
		self.assertEqual(series, {"account": "7ad3ca", "window": "weekly", "t": [int(NOW) - 1800, int(NOW) - 900, int(NOW) - 600, int(NOW)],
			"remaining_percent": [90, 90, 66.7, 66.7], "resets_at": [int(NOW) + 9000] * 4})
		self.assertEqual([type(value) for value in series["t"] + series["resets_at"]], [int] * 8)
		# The latest snapshot keeps its full precision.
		self.assertEqual(provider["accounts"][0]["windows"][0]["remaining_percent"], 100.0 - 33.333)

	def test_retention_prunes_on_write(self):
		self.store.record(codex(account("7ad3ca", NOW - 36 * 86400, [window("weekly", 1.0)])), checked_at=NOW - 36 * 86400)
		self.store.record(codex(account("7ad3ca", NOW - 34 * 86400, [window("weekly", 2.0)])), checked_at=NOW - 34 * 86400)
		self.store.record(codex(account("7ad3ca", NOW - 5, [window("weekly", 3.0)])), checked_at=NOW)
		self.assertEqual([row[0] for row in self.rows()], [NOW - 34 * 86400, NOW - 5])

	def test_history_window_and_staleness(self):
		for offset, used in ((7200, 10.0), (1800, 20.0)):
			self.store.record(codex(account("7ad3ca", NOW - offset, [window("weekly", used, NOW + 100)])), checked_at=NOW - offset)
		payload = limits.limits_payload(self.store, hours=1, now=NOW, sampler_status={"interval_s": 300, "started_at": 1.0, "last_run_at": 2.0, "last_error": None, "secret": "x"})
		(provider,) = payload["providers"]
		self.assertEqual([h["t"] for h in provider["history"]], [[NOW - 1800]])
		self.assertEqual(provider["accounts"][0]["windows"][0]["used_percent"], 20.0)
		self.assertTrue(provider["accounts"][0]["stale"])
		self.assertEqual(payload["sampler"], {"interval_s": 300.0, "started_at": 1.0, "last_run_at": 2.0, "last_error": None, "last_collect_at": None, "next_collect_at": None})
		self.assertEqual(payload["generated_at"], NOW)
		fresh = limits.limits_payload(self.store, hours=2, now=NOW - 1800 + 899)["providers"][0]
		self.assertFalse(fresh["accounts"][0]["stale"])
		self.assertEqual([h["t"] for h in fresh["history"]], [[NOW - 7200, NOW - 1800]])
		for hours in (0, 841, True, 1.5, "24"):
			with self.assertRaises(ValueError):
				limits.limits_payload(self.store, hours=hours, now=NOW)

	def test_errors_are_recorded_once_per_streak_and_cleared_by_new_sample(self):
		self.store.record(codex(account("7ad3ca", NOW - 10, [window("weekly", 5.0)])), checked_at=NOW)
		failed = codex(account("7ad3ca", NOW - 10, [window("weekly", 5.0)], error="refresh_failed"))
		self.store.record(failed, checked_at=NOW + 300)
		self.store.record(failed, checked_at=NOW + 600)
		self.assertEqual([row[3] for row in self.rows()], [None, "refresh_failed"])
		acct = limits.limits_payload(self.store, hours=1, now=NOW + 600)["providers"][0]["accounts"][0]
		self.assertEqual((acct["error"], acct["fetched_at"], acct["stale"]), ("refresh_failed", NOW - 10, False))
		self.store.record(codex(account("7ad3ca", NOW + 650, [window("weekly", 6.0)])), checked_at=NOW + 700)
		acct = limits.limits_payload(self.store, hours=1, now=NOW + 700)["providers"][0]["accounts"][0]
		self.assertIsNone(acct["error"])
		# Free-form errors collapse to the closed vocabulary; emails never become labels.
		self.store.record(codex(account("dead01", None, [], label="me@example.com", error="Bearer abc"), error="whatever"), checked_at=NOW + 800)
		provider = limits.limits_payload(self.store, hours=1, now=NOW + 800)["providers"][0]
		dead = next(a for a in provider["accounts"] if a["id"] == "dead01")
		self.assertEqual((dead["error"], dead["label"], dead["windows"], dead["stale"]), ("internal_error", "account dead01", [], True))
		self.assertEqual(provider["error"], "internal_error")

	def test_windowed_read_matches_a_full_read_for_accounts_that_stopped_sampling(self):
		# Only rows inside the window are read, extended back to each account's newest sample, so an account that stopped sampling days ago keeps its windows, label and later error.
		for hour in range(72, 0, -1):
			self.store.record(codex(account("live01", NOW - hour * 3600, [window("weekly", 72.0 - hour, NOW + 1000), window("five_hour", 1.0, NOW + 100)])), checked_at=NOW - hour * 3600)
		self.store.record(codex(account("gone01", NOW - 50 * 3600, [window("weekly", 30.0, NOW - 3600)], label="Old seat")), checked_at=NOW - 50 * 3600)
		self.store.record(codex(account("gone01", NOW - 50 * 3600, [window("weekly", 30.0, NOW - 3600)], label="Old seat", error="refresh_failed")), checked_at=NOW - 26 * 3600)
		self.store.record(codex(account("dead01", None, [], error="refresh_failed")), checked_at=NOW - 60 * 3600)
		full = self.store.read_rows
		for hours in (1, 24, 168):
			windowed = limits.limits_payload(self.store, hours=hours, now=NOW)
			with patch.object(self.store, "read_rows", lambda since=None: full(None)):
				self.assertEqual(windowed, limits.limits_payload(self.store, hours=hours, now=NOW), hours)
		gone = next(a for a in windowed["providers"][0]["accounts"] if a["id"] == "gone01")
		self.assertEqual((gone["label"], gone["error"], gone["windows"][0]["used_percent"]), ("Old seat", "refresh_failed", 30.0))
		# The oldest newest-sample (dead01, 60 hours ago) bounds a one-hour read, so live01's earlier hours are skipped.
		self.assertLess(len(full(NOW - 3600)[0]), len(full(None)[0]))

	def test_missing_store_reads_empty_without_creating(self):
		payload = limits.limits_payload(self.store, hours=24, now=NOW)
		self.assertEqual(payload["providers"], [])
		self.assertEqual(payload["sampler"], {"interval_s": None, "started_at": None, "last_run_at": None, "last_error": None, "last_collect_at": None, "next_collect_at": None})
		self.assertFalse(self.path.exists())


class NormalizeTests(unittest.TestCase):
	def snap(self, windows, raw=None, plan: "str | None" = "Pro", fetched=NOW):
		return SimpleNamespace(fetched_at=dt(fetched), plan=plan, windows=tuple(windows), raw=raw, identity="codex:acct:sub", details=("x",))

	def test_window_keys(self):
		self.assertEqual(limits.window_key("Session", 18000), ("five_hour", None))
		self.assertEqual(limits.window_key("Weekly", 604800), ("weekly", None))
		self.assertEqual(limits.window_key("Session", 3600), ("w3600", None))
		self.assertEqual(limits.window_key("Current session"), ("five_hour", None))
		self.assertEqual(limits.window_key("7d"), ("weekly", None))
		self.assertEqual(limits.window_key("API key quota"), ("api_key_quota", None))
		self.assertEqual(limits.window_key("Sonnet week", None, "model"), ("weekly:sonnet", "sonnet"))
		self.assertEqual(limits.window_key("Opus", 604800, "model"), ("weekly:opus", "opus"))

	def test_codex_durations_come_from_raw_numbers_only(self):
		W = SimpleNamespace
		raw = {"rate_limit": {"primary_window": {"used_percent": 12, "limit_window_seconds": 18000, "reset_at": 1},
			"secondary_window": {"used_percent": 40, "limit_window_seconds": 604800}}, "rate_limit_reset_credits": {"available_count": 2},
			"email": "me@example.com"}
		out = limits.normalize_snapshot("openai-codex", self.snap([
			W(label="Session", used_percent=12.0, reset_at=dt(NOW + 60), scope="account"),
			W(label="Weekly", used_percent=40.0, reset_at=None, scope="account")], raw=raw))
		self.assertEqual([(w["key"], w["window_seconds"]) for w in out["windows"]], [("five_hour", 18000), ("weekly", 604800)])
		self.assertEqual(out["windows"][0]["resets_at"], NOW + 60)
		self.assertEqual((out["fetched_at"], out["plan"]), (NOW, "Pro"))
		self.assertEqual(set(out), {"fetched_at", "plan", "banked_resets", "banked_applicable", "windows"})
		# The raw plan enum wins over Hermes's title-cased display value, because the page maps the enum to plan labels and capacity weights.
		raw_plan = limits.normalize_snapshot("openai-codex", self.snap([W(label="Weekly", used_percent=5.0, reset_at=None, scope="account")], raw={"plan_type": "prolite"}, plan="Prolite"))
		self.assertEqual(raw_plan["plan"], "prolite")
		self.assertNotIn("example.com", repr(out))
		self.assertNotIn("codex:acct", repr(out))
		# Weekly-only payload in primary_window (Hermes labels it Weekly by duration).
		weekly_only = {"rate_limit": {"primary_window": {"used_percent": 5, "limit_window_seconds": 604800}}}
		out = limits.normalize_snapshot("openai-codex", self.snap([W(label="Weekly", used_percent=5.0, reset_at=None, scope="account")], raw=weekly_only))
		self.assertEqual((out["windows"][0]["key"], out["windows"][0]["window_seconds"], out["banked_resets"]), ("weekly", 604800, None))
		# Disagreement with Hermes's labels voids durations instead of guessing.
		mismatch = {"rate_limit": {"primary_window": {"used_percent": 5, "limit_window_seconds": 18000}}}
		out = limits.normalize_snapshot("openai-codex", self.snap([W(label="Weekly", used_percent=5.0, reset_at=None, scope="account")], raw=mismatch))
		self.assertEqual((out["windows"][0]["key"], out["windows"][0]["window_seconds"]), ("weekly", None))

	def test_label_only_and_null_values(self):
		W = SimpleNamespace
		out = limits.normalize_snapshot("anthropic", self.snap([
			W(label="Current session", used_percent=None, reset_at=None, scope="account"),
			W(label="Opus week", used_percent=float("nan"), reset_at=None, scope="model"),
			W(label="Opus week", used_percent=1.0, reset_at=None, scope="model")], plan=None))
		self.assertEqual([w["key"] for w in out["windows"]], ["five_hour", "weekly:opus", "weekly:opus_2"])
		# Anthropic reports no durations; its window names imply them, model-scoped ones included.
		self.assertEqual([w["window_seconds"] for w in out["windows"]], [18000, 604800, 604800])
		codex = limits.normalize_snapshot("openai-codex", self.snap([W(label="Weekly", used_percent=1.0, reset_at=None, scope="account")]))
		self.assertIsNone(codex["windows"][0]["window_seconds"])
		self.assertIsNone(out["windows"][0]["used_percent"])
		self.assertIsNone(out["windows"][1]["used_percent"])
		self.assertIsNone(out["plan"])
		self.assertIsNone(out["banked_resets"])
		self.assertIsNone(limits.normalize_snapshot("anthropic", None))
		self.assertIsNone(limits.normalize_snapshot("anthropic", SimpleNamespace(fetched_at=None, windows=())))

	def test_real_hermes_snapshot_types(self):
		try:
			from agent.account_usage import AccountUsageSnapshot, AccountUsageWindow
		except Exception as exc:  # the store/payload logic does not depend on Hermes being importable
			self.skipTest(f"Hermes not importable: {type(exc).__name__}")
		snapshot = AccountUsageSnapshot(provider="openai-codex", source="usage_api", fetched_at=dt(NOW), plan="Plus",
			windows=(AccountUsageWindow(label="Weekly", used_percent=30.0, reset_at=dt(NOW + 10)),),
			identity="codex:a:b", raw={"rate_limit": {"primary_window": {"used_percent": 30, "limit_window_seconds": 604800}},
				"rate_limit_reset_credits": {"available_count": 3}})
		out = limits.normalize_snapshot("openai-codex", snapshot)
		self.assertEqual((out["banked_resets"], out["windows"][0]["key"], out["windows"][0]["window_seconds"]), (3, "weekly", 604800))
		# The count is read from the payload itself, the way Hermes counts it.
		counts = [limits.normalize_snapshot("openai-codex", SimpleNamespace(fetched_at=dt(NOW), plan=None, windows=(), raw=raw))["banked_resets"] for raw in (
			{"rate_limit_reset_credits": {"available_count": 2.0}}, {"rate_limit_reset_credits": {"available_count": "2"}}, {"rate_limit_reset_credits": None},
			{"rate_limit_reset_credits": {"available_count": True}}, {"rate_limit_reset_credits": {"available_count": -1}}, {"other": 1})]
		self.assertEqual(counts, [2, 0, 0, 0, 0, None])


class FakeEntry:
	def __init__(self, provider, row):
		self.provider = provider
		self.id = row["id"]
		self.label = row.get("label")
		self.priority = row.get("priority", 0)
		self.last_status = row.get("last_status")
		self.runtime_api_key = row.get("access_token", "")
		self.runtime_base_url = row.get("base_url")

	@classmethod
	def from_dict(cls, provider, row):
		return cls(provider, row)


class CollectorTests(unittest.TestCase):
	passed = None

	def setUp(self):
		# The hourly credit throttle is process-wide; each test starts with no recorded read.
		limits._CREDITS_READ.clear()

	def symbols(self, pool, fetched=None):
		def fetch(provider, **kwargs):
			if fetched is not None:
				fetched.append((provider, kwargs))
			token = kwargs.get("api_key")
			time.sleep(2 if token == "slow" else 0.02)
			if token == "fails":
				return None
			windows = () if token == "nowin" else (SimpleNamespace(label="Weekly", used_percent=50.0, reset_at=None, scope="account"),)
			# Codex names the account that answered; tok-a2 is a second credential of tok-a's account.
			identity = {"tok-a": "codex:acct-a", "tok-a2": "codex:acct-a", "tok-b": "codex:acct-b"}.get(token)
			return SimpleNamespace(fetched_at=dt(time.time()), plan="Pro", raw=None, windows=windows, identity=identity)

		return {
			"fetch_account_usage": fetch,
			"PooledCredential": FakeEntry,
			"STATUS_DEAD": "dead",
			"read_credential_pool": lambda: pool,
			"_pool_entry_route_base_url": lambda provider, entry: "https://example.invalid/backend-api/codex",
			"_pool_entry_host": lambda provider, entry: "example.invalid",
		}

	def test_collects_vetted_pools_read_only_without_keeping_tokens(self):
		pool = {
			"openai-codex": [
				{"id": "7c202b", "label": "codex-team", "priority": 0, "access_token": "tok-a"},
				{"id": "7ad3ca", "label": "codex-pro", "priority": 1, "access_token": "tok-b"},
				{"id": "dup001", "label": "dup", "priority": 2, "access_token": "tok-a"},
				{"id": "dead01", "label": "me@example.com", "priority": 3, "access_token": "tok-d", "last_status": "dead"},
				{"id": "empty1", "priority": 4},
				{"id": "fail01", "priority": 5, "access_token": "fails"},
				{"id": "nowin1", "priority": 6, "access_token": "nowin"},
				{"id": "alias1", "priority": 7, "access_token": "tok-a2"},
			],
			"openrouter": [{"id": "or0001", "access_token": "tok-or"}],
			"anthropic": [],
		}
		fetched = []
		with patch.object(limits, "_native_symbols", return_value=self.symbols(pool, fetched)):
			readings = limits.collect_native(claude_login=NO_CLAUDE, join_timeout=5)
		# An emptied pool key is reported as logged out; a provider outside the vetted set is never sampled.
		self.assertEqual([(r["provider"], r["error"], r["accounts"]) for r in readings[:1]], [("anthropic", "logged_out", [])])
		reading = readings[1]
		self.assertEqual([r["provider"] for r in readings], ["anthropic", "openai-codex"])
		by_id = {a["id"]: a for a in reading["accounts"]}
		# dup001 shares tok-a and is never fetched; alias1 is fetched, then merged because Codex answers as tok-a's account.
		self.assertEqual(list(by_id), ["7c202b", "7ad3ca", "dead01", "empty1", "fail01", "nowin1"])
		# Every fetch is Hermes's read-only per-credential one, with the entry's own token and route, keyed by the token's fingerprint.
		route = "https://example.invalid/backend-api/codex"
		self.assertEqual(sorted((provider, kwargs["api_key"]) for provider, kwargs in fetched), [("openai-codex", token) for token in ("fails", "nowin", "tok-a", "tok-a2", "tok-b")])
		for provider, kwargs in fetched:
			self.assertEqual((kwargs["base_url"], kwargs["read_only"], kwargs["identity_id"]), (route, True, limits._token_fingerprint(kwargs["api_key"])))
		self.assertEqual(by_id["dead01"]["error"], "credential_dead")
		self.assertEqual(by_id["dead01"]["label"], "account dead01")
		self.assertEqual(by_id["empty1"]["error"], "no_credential")
		self.assertEqual(by_id["fail01"]["error"], "refresh_failed")
		self.assertEqual(by_id["nowin1"]["error"], "no_data")
		self.assertIsNone(by_id["7ad3ca"]["error"])
		self.assertEqual(by_id["7ad3ca"]["snapshot"]["windows"][0]["key"], "weekly")
		self.assertNotIn("tok-", repr(readings))
		self.assertNotIn("fp:", repr(readings))
		self.assertNotIn("acct-", repr(readings))
		with tempfile.TemporaryDirectory() as temp:
			path = Path(temp) / "limits.sqlite3"
			store = limits.LimitsStore(path)
			store.record(readings, checked_at=time.time())
			payload = limits.limits_payload(store, hours=24, now=time.time())
			self.assertEqual({p["provider"]: (p["auth"], p["error"], len(p["accounts"])) for p in payload["providers"]}, {"anthropic": ("logged_out", None, 0), "openai-codex": ("ok", None, 6)})
			self.assertNotIn(b"tok-", path.read_bytes())
			self.assertNotIn(b"example", path.read_bytes())

	def test_one_key_on_two_routes_is_two_accounts(self):
		# Two proxies sharing one password are two accounts; the same key twice on one route is one.
		pool = {"openai-codex": [
			{"id": "proxy0", "priority": 0, "access_token": "shared", "base_url": "https://proxy-a.example.invalid/v1"},
			{"id": "proxy1", "priority": 1, "access_token": "shared", "base_url": "https://proxy-b.example.invalid/v1"},
			{"id": "proxy2", "priority": 2, "access_token": "shared", "base_url": "https://proxy-b.example.invalid/v1/"},
		]}
		fetched = []
		symbols = self.symbols(pool, fetched)
		symbols["_pool_entry_route_base_url"] = lambda provider, entry: entry.runtime_base_url
		symbols["_pool_entry_host"] = lambda provider, entry: entry.runtime_base_url.rstrip("/")
		with patch.object(limits, "_native_symbols", return_value=symbols):
			(reading,) = limits.collect_native(claude_login=NO_CLAUDE, join_timeout=5)
		self.assertEqual([a["id"] for a in reading["accounts"]], ["proxy0", "proxy1"])
		self.assertEqual(sorted(kwargs["base_url"] for _provider, kwargs in fetched), ["https://proxy-a.example.invalid/v1", "https://proxy-b.example.invalid/v1"])

	def test_a_fetch_still_running_is_reported_as_a_timeout(self):
		pool = {"openai-codex": [{"id": "7c202b", "priority": 0, "access_token": "tok-a"}, {"id": "slow01", "priority": 1, "access_token": "slow"}]}
		with patch.object(limits, "_native_symbols", return_value=self.symbols(pool)):
			(reading,) = limits.collect_native(claude_login=NO_CLAUDE, join_timeout=0.5)
		self.assertEqual([(a["id"], a["error"]) for a in reading["accounts"]], [("7c202b", None), ("slow01", "timeout")])

	def test_fetches_run_in_the_collections_profile_context(self):
		# Hermes resolves auth and its cache from the active home, a context variable a plain thread would not inherit.
		home = contextvars.ContextVar("home", default="none")
		seen = []
		symbols = self.symbols({"openai-codex": [{"id": "7c202b", "priority": 0, "access_token": "tok-a"}]})
		symbols["fetch_account_usage"] = lambda provider, **kwargs: seen.append(home.get())
		token = home.set("profile-a")
		try:
			with patch.object(limits, "_native_symbols", return_value=symbols):
				limits.collect_native(claude_login=NO_CLAUDE, join_timeout=5)
		finally:
			home.reset(token)
		self.assertEqual(seen, ["profile-a"])

	def test_codex_credit_lists_are_read_hourly_with_each_accounts_token(self):
		pool = {"openai-codex": [
			{"id": "7c202b", "label": "a", "priority": 0, "access_token": "tok-a"},
			{"id": "7ad3ca", "label": "b", "priority": 1, "access_token": "tok-b"},
			{"id": "dup001", "label": "dup", "priority": 2, "access_token": "tok-a"},
			{"id": "dead01", "priority": 3, "access_token": "tok-d", "last_status": "dead"},
		]}
		calls = []

		def fetch(base_url, token):
			calls.append(token)
			if token == "tok-b":
				raise RuntimeError("401 from tok-b")
			return [{"status": "available", "granted_at": 1.0e9, "expires_at": 2.0e9}]
		now = [1_800_000_000.0]
		symbols = dict(self.symbols(pool), _codex_backend_urls=lambda base: (None, None, None), _codex_headers=lambda token, account: {})
		collect = lambda: limits.collect_native(claude_login=NO_CLAUDE, join_timeout=5, clock=lambda: now[0], credits_fetcher=fetch)
		with patch.object(limits, "_native_symbols", return_value=symbols):
			(reading,) = collect()
			# Duplicates of an account and dead credentials are never asked; a failed read leaves no list.
			self.assertEqual(calls, ["tok-a", "tok-b"])
			by_id = {a["id"]: a for a in reading["accounts"]}
			self.assertEqual(by_id["7c202b"]["credits"], [{"status": "available", "granted_at": 1.0e9, "expires_at": 2.0e9}])
			self.assertNotIn("credits", by_id["7ad3ca"])
			self.assertNotIn("tok-", repr(reading))
			# Within the hour nothing is read again, failures included; after it, both are.
			now[0] += limits.CREDITS_INTERVAL_S - 1
			collect()
			self.assertEqual(len(calls), 2)
			now[0] += 1
			collect()
			self.assertEqual(calls[2:], ["tok-a", "tok-b"])

	def test_per_account_lists_need_both_hermes_helpers_and_no_setting_survives(self):
		self.assertTrue(limits.pool_credits_available({"_codex_backend_urls": len, "_codex_headers": len}))
		self.assertFalse(limits.pool_credits_available({"_codex_backend_urls": len, "_codex_headers": None}))
		self.assertFalse(limits.pool_credits_available({}))
		# Without them no credit list is read at all; the accounts keep their usage readings.
		pool = {"openai-codex": [{"id": "7c202b", "label": "a", "priority": 0, "access_token": "tok-a"}]}
		with patch.object(limits, "_native_symbols", return_value=self.symbols(pool)):
			(reading,) = limits.collect_native(claude_login=NO_CLAUDE, join_timeout=5, credits_fetcher=lambda base_url, token: self.fail("no list without the helpers"))
		self.assertEqual((reading["accounts"][0]["error"], "credits" in reading["accounts"][0]), (None, False))
		# A store that kept the former switch drops its table at the next write; the sampler collects with no setting.
		with tempfile.TemporaryDirectory() as temp:
			path = Path(temp) / "limits.sqlite3"
			with closing(sqlite3.connect(path)) as connection:
				connection.execute("CREATE TABLE limit_settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL)")
				connection.execute("INSERT INTO limit_settings VALUES ('experimental_pool_credits', 0)")
				connection.commit()
			store = limits.LimitsStore(path)
			store.record([], checked_at=NOW)
			with closing(sqlite3.connect(path)) as connection:
				self.assertIsNone(connection.execute("SELECT 1 FROM sqlite_master WHERE name = 'limit_settings'").fetchone())
			seen = []
			with patch.object(limits, "collect_native", side_effect=lambda **kwargs: seen.append(sorted(kwargs)) or []):
				limits.LimitsSampler(store, home_resolver=lambda: Path(temp))._collect()
			self.assertEqual(seen, [["clock", "join_timeout"]])

	def test_missing_native_symbol_reports_unavailable(self):
		symbols = self.symbols({"openai-codex": [{"id": "7ad3ca", "access_token": "x"}]})
		symbols["fetch_account_usage"] = None
		with patch.object(limits, "_native_symbols", return_value=symbols):
			(reading,) = limits.collect_native(claude_login=NO_CLAUDE, join_timeout=1)
		self.assertEqual((reading["error"], reading["accounts"]), ("unavailable", []))
		symbols["read_credential_pool"] = None
		with patch.object(limits, "_native_symbols", return_value=symbols):
			with self.assertRaises(RuntimeError):
				limits.collect_native(claude_login=NO_CLAUDE, join_timeout=1)

	def test_a_missing_route_helper_sends_nothing_rather_than_guessing_a_route(self):
		# A guessed route can send a key to the wrong host (a proxy key to chatgpt.com), so without either helper no account is fetched.
		for name in ("_pool_entry_route_base_url", "_pool_entry_host"):
			with self.subTest(missing=name):
				fetched = []
				symbols = self.symbols({"openai-codex": [{"id": "7ad3ca", "access_token": "proxy-key", "base_url": "https://chatgpt.com/backend-api/codex"}]}, fetched)
				symbols[name] = None
				with patch.object(limits, "_native_symbols", return_value=symbols):
					(reading,) = limits.collect_native(claude_login=NO_CLAUDE, join_timeout=1, credits_fetcher=lambda *args: self.fail("credit list fetched"))
				self.assertEqual((reading["error"], reading["accounts"], fetched), ("unavailable", [], []))

	def test_default_collector_only_uses_vetted_native_functions(self):
		tree = ast.parse((ROOT / "usage_limits.py").read_text(encoding="utf-8"))
		taken = {
			(node.args[0].value, node.args[1].value) for node in ast.walk(tree)
			if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "take"
			and isinstance(node.args[0], ast.Constant) and isinstance(node.args[1], ast.Constant)
		}
		self.assertEqual(taken, {
			("agent.credential_pool", "PooledCredential"),
			("agent.credential_pool", "STATUS_DEAD"),
			("hermes_cli.auth", "read_credential_pool"),
			("hermes_cli.inventory", "_pool_entry_route_base_url"),
			("hermes_cli.inventory", "_pool_entry_host"),
			("agent.account_usage", "_codex_backend_urls"),
			("agent.account_usage", "_codex_headers"),
			("agent.account_usage", "fetch_account_usage"),
		})
		imported = {
			(node.module, alias.name) for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)
			for alias in node.names if node.module and node.module.split(".")[0] in ("agent", "hermes_cli", "hermes_constants")
		}
		self.assertEqual(imported, {
			("hermes_constants", "get_hermes_home"), ("hermes_constants", "hermes_home_key"),
			("hermes_constants", "reset_hermes_home_override"), ("hermes_constants", "set_hermes_home_override"),
		})
		functions = {fn.name: fn for fn in ast.walk(tree) if isinstance(fn, ast.FunctionDef)}
		users = {name for name, fn in functions.items() if any(isinstance(node, ast.Constant) and node.value == "fetch_account_usage" for node in ast.walk(fn))}
		self.assertEqual(users, {"_native_symbols", "_collect_claude_code", "collect_native"})
		# Pool accounts are only ever fetched read-only with their own token; the one refreshing path (an expired Claude Code login, fetched without a token) stays inside the fallback.
		(pooled,) = [node for node in ast.walk(functions["_fetch_accounts"]) if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "fetch"]
		self.assertEqual({keyword.arg for keyword in pooled.keywords}, {"base_url", "api_key", "read_only", "identity_id"})
		self.assertTrue(any(keyword.arg == "read_only" and getattr(keyword.value, "value", None) is True for keyword in pooled.keywords))
		forbidden = {
			"refresh_account_usage_async", "load_pool", "select", "try_refresh_matching",
			"resolve_codex_runtime_credentials", "_persist", "persist_pool_entries",
			"_save_auth_store", "redeem_codex_reset_credit", "remember_account_usage", "_claim_refresh",
			"cached_account_usage", "refresh_account_usage_entries_async", "_identity_id_for", "resolve_anthropic_token",
		}
		used = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
		used |= {node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)}
		used |= {node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and isinstance(node.value, str)}
		self.assertEqual(used & forbidden, set())
		self.assertEqual(limits.VETTED_PROVIDERS, ("openai-codex", "anthropic"))


class SamplerTests(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="t3sidebar-sampler-")
		self.addCleanup(self.temp.cleanup)
		self.home = Path(self.temp.name) / "home"
		self.home.mkdir()
		self.store = limits.LimitsStore(Path(self.temp.name) / "limits.sqlite3")

	def sampler(self, collector, **kwargs):
		sampler = limits.LimitsSampler(self.store, home_resolver=lambda: self.home, collector=collector, **kwargs)
		self.addCleanup(sampler.stop)
		return sampler

	def wait_for(self, predicate, timeout=5.0):
		deadline = time.monotonic() + timeout
		while time.monotonic() < deadline:
			if predicate():
				return True
			time.sleep(0.01)
		return False

	def test_start_is_idempotent_per_process_and_home(self):
		first = self.sampler(lambda: [], interval_s=60, first_delay_s=60)
		self.assertIs(first.start(), first)
		self.assertIs(first.start(), first)
		second = self.sampler(lambda: [], interval_s=60, first_delay_s=60)
		self.assertIs(second.start(), first)
		self.assertFalse(second.is_running())
		self.assertEqual(sum(t.name == "t3sidebar-limits-sampler" and t.is_alive() for t in threading.enumerate()), 1)
		first.stop()
		self.assertFalse(first.is_running())
		self.assertIs(second.start(), second)

	def test_thread_survives_exceptions_and_runs_in_home_scope(self):
		marker: "contextvars.ContextVar[str | None]" = contextvars.ContextVar("marker", default=None)
		calls = []

		def collector():
			from hermes_constants import get_hermes_home

			calls.append((str(get_hermes_home()), marker.get()))
			if len(calls) == 1:
				raise RuntimeError("Bearer secret-token")
			return codex(account("7ad3ca", NOW + len(calls), [window("weekly", 1.0)]))

		token = marker.set("caller-scope")
		try:
			sampler = self.sampler(collector, interval_s=0.02, first_delay_s=0).start()
		finally:
			marker.reset(token)
		self.assertTrue(self.wait_for(lambda: len(calls) >= 3))
		sampler.stop()
		self.assertTrue(all(call == (str(self.home), "caller-scope") for call in calls))
		self.assertIsNone(sampler.last_error)
		self.assertGreaterEqual(len(self.store.read_rows()[0]), 2)
		status = self.store.read_status()
		self.assertEqual(status["interval_s"], 0.02)
		self.assertIsNotNone(status["started_at"])

	def test_run_once_reports_safe_error_classes(self):
		def broken():
			raise ValueError("token=abc")

		sampler = self.sampler(broken)
		self.assertEqual(sampler.run_once(), {"inserted": 0, "error": "collector_failed:ValueError"})
		self.assertEqual(self.store.read_status()["last_error"], "collector_failed:ValueError")
		self.assertNotIn("abc", repr(self.store.read_status()))
		sampler = self.sampler(lambda: codex(account("7ad3ca", NOW, [window("weekly", 1.0)])))
		with patch.object(self.store, "record", side_effect=sqlite3.OperationalError("locked")):
			self.assertEqual(sampler.run_once()["error"], "store_failed:OperationalError")
		self.assertEqual(sampler.run_once(), {"inserted": 1, "error": None})
		payload = limits.limits_payload(self.store, hours=1, now=NOW, sampler_status=sampler.status())
		self.assertEqual(payload["sampler"]["interval_s"], 300.0)

	def held_collector(self, calls):
		"""A collector that stays in its provider reads until the test releases it."""
		entered, release = threading.Event(), threading.Event()
		self.addCleanup(release.set)

		def collector():
			calls.append(1)
			entered.set()
			release.wait(5)
			return []
		return collector, entered, release

	def in_thread(self, results, name, call):
		thread = threading.Thread(target=lambda: results.__setitem__(name, call()))
		thread.start()
		self.addCleanup(thread.join, 5)
		return thread

	def test_collect_now_reads_the_providers_at_most_once_per_cooldown_counting_every_collection(self):
		calls, clock = [], [100.0]
		# The wall clock runs far from the monotonic one; reported times are wall times, the cooldown runs on the monotonic clock.
		sampler = self.sampler(lambda: calls.append(1) or [], cooldown_s=30, monotonic=lambda: clock[0], clock=lambda: NOW + clock[0])
		self.assertEqual(sampler.collect_window(), {"generated_at": NOW + 100, "last_collect_at": None, "next_collect_at": None})
		self.assertEqual(sampler.collect_now(), {"status": "collected", "error": None, "generated_at": NOW + 100, "last_collect_at": NOW + 100, "next_collect_at": NOW + 130})
		clock[0] += 10
		self.assertEqual(sampler.collect_now(), {"status": "cooldown", "error": None, "generated_at": NOW + 110, "last_collect_at": NOW + 100, "next_collect_at": NOW + 130})
		# A scheduled tick right after a Refresh is skipped too: everything was just read.
		self.assertIsNone(sampler.tick())
		self.assertEqual(len(calls), 1)
		clock[0] += 20
		self.assertEqual(sampler.collect_now()["status"], "collected")
		# The reading after a reset is never refused, and starts the wait like any collection; the status every limits read carries says so.
		clock[0] += 5
		sampler.run_once()
		clock[0] += 5
		status = sampler.status()
		self.assertEqual((status["last_collect_at"], status["next_collect_at"]), (NOW + 135, NOW + 165))
		self.assertEqual(sampler.collect_now()["status"], "cooldown")
		clock[0] += 30
		self.assertEqual(sampler.tick(), {"inserted": 0, "error": None})
		self.assertEqual(len(calls), 4)
		# The stored status is unchanged: collect times live only in the running process.
		self.assertNotIn("next_collect_at", self.store.read_status())

	def test_a_whole_collection_failure_is_reported_by_the_request_that_ran_it(self):
		def broken():
			raise ValueError("token=abc")
		answer = self.sampler(broken).collect_now()
		self.assertEqual((answer["status"], answer["error"]), ("collected", "collector_failed:ValueError"))

	def test_requests_during_a_collection_join_it_even_past_the_cooldown_and_start_none(self):
		calls, clock, results = [], [100.0], {}
		collector, entered, release = self.held_collector(calls)
		sampler = self.sampler(collector, cooldown_s=30, monotonic=lambda: clock[0])
		first = self.in_thread(results, "first", sampler.collect_now)
		self.assertTrue(entered.wait(5))
		# The collection outlasts the cooldown: a later request still joins it rather than queueing a second one.
		clock[0] += 45
		second = self.in_thread(results, "second", sampler.collect_now)
		second.join(0.2)
		self.assertTrue(second.is_alive(), "the joining request waits for the collection under way")
		self.assertIsNone(sampler.tick(), "a scheduled tick never overlaps a collection")
		release.set()
		first.join(5)
		second.join(5)
		self.assertEqual((results["first"]["status"], results["second"]["status"], len(calls)), ("collected", "joined", 1))

	def test_a_request_admitted_just_before_its_collection_starts_reading_is_still_joined(self):
		# The first caller has been admitted but has not reached its collector yet: a second caller must still wait for it.
		calls, results = [], {}
		collector, entered, release = self.held_collector(calls)
		sampler = self.sampler(collector, cooldown_s=30)
		decision, flight = sampler.admit("manual")
		self.assertEqual(decision, "run")
		second = self.in_thread(results, "second", sampler.collect_now)
		second.join(0.2)
		self.assertTrue(second.is_alive())
		first = self.in_thread(results, "first", lambda: sampler._run_admitted(flight))
		self.assertTrue(entered.wait(5))
		release.set()
		first.join(5)
		second.join(5)
		self.assertEqual((results["second"]["status"], len(calls)), ("joined", 1))

	def test_the_reading_after_a_reset_waits_for_the_collection_under_way_then_runs_its_own(self):
		calls, results = [], {}
		collector, entered, release = self.held_collector(calls)
		sampler = self.sampler(collector, cooldown_s=30)
		first = self.in_thread(results, "first", sampler.collect_now)
		self.assertTrue(entered.wait(5))
		forced = self.in_thread(results, "forced", sampler.run_once)
		forced.join(0.2)
		self.assertEqual(len(calls), 1, "never two collections at once")
		release.set()
		first.join(5)
		forced.join(5)
		self.assertEqual(len(calls), 2, "a reading that postdates the reset")

	def test_a_replacement_sampler_of_the_same_home_keeps_the_cooldown_and_the_collection_under_way(self):
		calls, results = [], {}
		collector, entered, release = self.held_collector(calls)
		old = self.sampler(collector, cooldown_s=30)
		first = self.in_thread(results, "first", old.collect_now)
		self.assertTrue(entered.wait(5))
		# Re-registration creates a new sampler while the old one still reads.
		new = self.sampler(collector, cooldown_s=30)
		self.assertEqual(new.admit("manual")[0], "joined")
		release.set()
		first.join(5)
		self.assertEqual(new.collect_now()["status"], "cooldown")
		self.assertEqual(len(calls), 1)

	def test_the_async_request_waits_on_the_event_loop_and_collects_in_a_thread_of_its_own(self):
		calls, results = [], {}
		collector, entered, release = self.held_collector(calls)
		sampler = self.sampler(collector, cooldown_s=30)
		first = self.in_thread(results, "first", sampler.collect_now)
		self.assertTrue(entered.wait(5))
		threading.Timer(0.3, release.set).start()
		workers = []
		original = asyncio.to_thread

		async def counted(*args):
			workers.append(args)
			return await original(*args)
		with patch.object(asyncio, "to_thread", new=counted):
			answer = asyncio.run(sampler.collect_now_async())
			first.join(5)
			self.assertEqual((answer["status"], len(calls)), ("joined", 1))
			# The request that starts a collection waits for it like the others: the shared executor is never used.
			names = []
			unthrottled = self.sampler(lambda: names.append(threading.current_thread().name) or [], cooldown_s=0)
			self.assertEqual(asyncio.run(unthrottled.collect_now_async())["status"], "collected")
		self.assertEqual((workers, names), ([], ["t3sidebar-limits-collect"]))

	def test_a_cancelled_request_neither_stops_its_collection_nor_strands_the_admission(self):
		calls = []
		collector, entered, release = self.held_collector(calls)
		sampler = self.sampler(collector, cooldown_s=30)

		async def leave_early():
			task = asyncio.create_task(sampler.collect_now_async())
			await asyncio.sleep(0.05)
			task.cancel()
			with self.assertRaises(asyncio.CancelledError):
				await task
		asyncio.run(leave_early())
		self.assertTrue(entered.wait(5), "the collection still runs")
		release.set()
		# Its end releases the admission: the reading after a reset is admitted rather than waiting forever.
		forced = threading.Thread(target=sampler.run_once)
		forced.start()
		forced.join(5)
		self.assertFalse(forced.is_alive())
		self.assertEqual(len(calls), 2)

	def test_the_cooldown_counts_from_when_the_collection_really_begins(self):
		clock = [100.0]
		sampler = self.sampler(lambda: [], cooldown_s=30, monotonic=lambda: clock[0], clock=lambda: NOW + clock[0])
		decision, flight = sampler.admit("manual")
		self.assertEqual(decision, "run")
		# Admitted, but its thread only starts reading 40 s later.
		clock[0] += 40
		sampler._run_admitted(flight)
		clock[0] += 10
		self.assertEqual(sampler.collect_now()["status"], "cooldown")
		self.assertEqual(sampler.collect_window()["last_collect_at"], NOW + 140)

	def test_the_payload_states_the_next_collection_against_its_own_generated_at(self):
		status = {"interval_s": 300.0, "started_at": 1.0, "last_run_at": 2.0, "last_error": None, "generated_at": 500.0, "last_collect_at": 490.0, "next_collect_at": 512.5}
		payload = limits.limits_payload(self.store, hours=1, now=NOW, sampler_status=status)
		self.assertEqual(payload["sampler"], {"interval_s": 300.0, "started_at": 1.0, "last_run_at": 2.0, "last_error": None, "last_collect_at": 490.0, "next_collect_at": NOW + 12.5})
		past = limits.limits_payload(self.store, hours=1, now=NOW, sampler_status={**status, "next_collect_at": 500.0})
		self.assertEqual(past["sampler"]["next_collect_at"], NOW)


class CreditTests(unittest.TestCase):
	def test_normalizes_codex_credit_list_to_status_and_times(self):
		body = {"available_count": 2, "total_earned_count": 9, "credits": [
			{"reset_type": "codex_rate_limits", "status": "available", "granted_at": "2026-09-29T18:58:39.740398Z", "expires_at": "2026-10-29T18:58:39.740398Z", "id": "secret-id"},
			{"status": "redeemed", "expires_at": "not a date"},
			{"status": "Bad Status!", "expires_at": "2026-10-29T18:58:39Z"},
			{"status": "available", "expires_at": "2026-11-06T23:48:46"},
			"junk",
		]}
		credits = limits.normalize_credits(body)
		self.assertEqual(credits[0], {"status": "available", "granted_at": dt_epoch("2026-09-29T18:58:39.740398+00:00"), "expires_at": dt_epoch("2026-10-29T18:58:39.740398+00:00")})
		# Zone-less times become None rather than being guessed in local time; redeemed credits are never shown, so they are not kept.
		self.assertEqual([(c["status"], c["expires_at"]) for c in credits[1:]], [("available", None)])
		self.assertNotIn("secret", repr(credits))
		self.assertIsNone(limits.normalize_credits({"available_count": 2}))
		self.assertIsNone(limits.normalize_credits(None))

	def test_payload_lists_available_unexpired_credits_and_keeps_the_last_list(self):
		now = 1_800_000_000.0
		raw = {"rate_limit_reset_credits": {"available_count": 3, "applicable_available_count": 0}}
		snapshot = limits.normalize_snapshot("openai-codex", SimpleNamespace(fetched_at=dt(now - 10), plan="Pro", raw=raw,
			windows=(SimpleNamespace(label="Weekly", used_percent=5.0, reset_at=None, scope="account"),)))
		self.assertEqual(snapshot["banked_applicable"], 0)
		credits = [
			{"status": "available", "granted_at": now - 9 * 86400, "expires_at": now + 9 * 86400},
			{"status": "available", "granted_at": now - 30 * 86400, "expires_at": now + 5 * 3600},
			{"status": "available", "granted_at": now - 40 * 86400, "expires_at": now - 60},
			{"status": "redeemed", "granted_at": now - 2 * 86400, "expires_at": now + 86400},
		]
		with tempfile.TemporaryDirectory() as temp:
			store = limits.LimitsStore(Path(temp) / "limits.sqlite3")
			store.record([{"provider": "openai-codex", "error": None, "accounts": [{"id": "7ad3ca", "label": "b", "priority": 1, "snapshot": snapshot, "credits": credits}]}], checked_at=now)
			block = limits.limits_payload(store, hours=24, now=now)["providers"][0]["accounts"][0]["banked_credits"]
			self.assertEqual(block["applicable_count"], 0)
			self.assertEqual(block["fetched_at"], now)
			# Expired and redeemed credits are dropped; the rest is ordered by expiry.
			self.assertEqual([c["expires_at"] for c in block["credits"]], [now + 5 * 3600, now + 9 * 86400])
			# A later sample without a fresh list keeps the stored one and updates the applicable count.
			later = dict(snapshot, fetched_at=now + 300, banked_applicable=2)
			store.record([{"provider": "openai-codex", "error": None, "accounts": [{"id": "7ad3ca", "label": "b", "priority": 1, "snapshot": later}]}], checked_at=now + 300)
			block = limits.limits_payload(store, hours=24, now=now + 6 * 3600)["providers"][0]["accounts"][0]["banked_credits"]
			self.assertEqual((block["applicable_count"], block["fetched_at"], [c["expires_at"] for c in block["credits"]]), (2, now, [now + 9 * 86400]))

	def test_account_without_a_credit_read_has_none(self):
		with tempfile.TemporaryDirectory() as temp:
			path = Path(temp) / "limits.sqlite3"
			store = limits.LimitsStore(path)
			store.record(codex(account("7ad3ca", NOW - 10, [window("weekly", 40.0, NOW + 3600)])), checked_at=NOW)
			self.assertIsNone(limits.limits_payload(store, hours=24, now=NOW)["providers"][0]["accounts"][0]["banked_credits"])
			# A store written before the credit table existed still reads.
			with closing(sqlite3.connect(path)) as connection:
				connection.execute("DROP TABLE limit_credits")
				connection.commit()
			self.assertEqual(store.read_credits(), {})


NO_CLAUDE = lambda clock: None


# The real read, kept before NoNetworkTestCase swaps it out of the module.
REAL_FETCH_ANTHROPIC_USAGE = limits._fetch_anthropic_usage


class NoNetworkTestCase(unittest.TestCase):
	"""Anthropic's scoped-limit GET defaults to the real endpoint; record any default call instead of sending it."""

	def setUp(self):
		self.network = []
		patcher = patch.object(limits, "_fetch_anthropic_usage", side_effect=lambda token: self.network.append(token))
		patcher.start()
		self.addCleanup(patcher.stop)
		# The plan is cached per process; each test starts as a freshly started Hermes.
		plans = patch.dict(limits._PLAN_READ, clear=True)
		plans.start()
		self.addCleanup(plans.stop)


TOKEN = "sk-ant-oat01-secret"


def collect_claude(pool, login, body=lambda token: USAGE_BODY, profile=None, refresher=None, clock=time.time, hermes_calls=None):
	"""One collection with Anthropic's usage read answered by ``body``; Hermes's own fetch records its calls and reads Codex only."""
	symbols = CollectorTests.symbols(CollectorTests(), pool, hermes_calls)
	profile = profile or (lambda token: "default_claude_max_5x")
	with patch.object(limits, "_native_symbols", return_value=symbols):
		return limits.collect_native(join_timeout=1, clock=clock, claude_login=login, claude_profile=profile, claude_refresher=refresher, anthropic_fetcher=body)


# Shape of a live /api/oauth/usage ``limits`` list (field names as Anthropic sends them; values invented).
SCOPED_BODY = {"limits": [
	{"kind": "session", "group": "session", "percent": 22, "severity": "normal", "resets_at": "2026-11-10T04:20:00.478555+00:00", "scope": None, "is_active": False},
	{"kind": "weekly_all", "group": "weekly", "percent": 40, "severity": "normal", "resets_at": "2026-11-12T00:00:00.478581+00:00", "scope": None, "is_active": True},
	{"kind": "weekly_scoped", "group": "weekly", "percent": 7, "severity": "normal", "resets_at": "2026-11-12T00:00:00+00:00", "scope": {"model": {"id": None, "display_name": "Fable"}, "surface": None}, "is_active": False},
]}
# The whole body: the windows Hermes maps (utilization already a percent) next to the scoped list.
USAGE_BODY = {"five_hour": {"utilization": 23.0, "resets_at": "2026-11-10T04:20:00+00:00"}, "seven_day": {"utilization": 40.0, "resets_at": "2026-11-12T00:00:00+00:00"},
	"seven_day_opus": None, "extra_usage": {"is_enabled": False}, **SCOPED_BODY}


class AnthropicScopedLimitsTests(NoNetworkTestCase):
	def test_scoped_entries_become_model_windows_and_account_wide_ones_are_left_to_hermes(self):
		(fable,) = limits.anthropic_scoped_windows(SCOPED_BODY)
		self.assertEqual(fable, {"key": "weekly:fable", "label": "Fable week", "window_seconds": 604800, "scope": "model", "model": "fable",
			"used_percent": 7.0, "resets_at": dt_epoch("2026-11-12T00:00:00+00:00")})
		# A session-group scoped entry maps to the session window, the model's id stands in for a missing name, and malformed rows are skipped.
		odd = {"limits": [{"group": "session", "percent": 3, "scope": {"model": {"id": "mist", "display_name": None}}}, "x",
			{"group": "monthly", "percent": 1, "scope": {"model": {"display_name": "Fable"}}}, {"group": "weekly", "scope": {"model": {"display_name": "me@example.com"}}}]}
		self.assertEqual([(w["key"], w["used_percent"]) for w in limits.anthropic_scoped_windows(odd)], [("five_hour:mist", 3.0)])
		self.assertIsNone(limits.anthropic_scoped_windows({"seven_day": {}}))
		self.assertIsNone(limits.anthropic_scoped_windows(None))

	def test_the_body_gives_hermes_windows_under_the_same_keys_then_the_model_limits(self):
		# Samples recorded through Hermes before keep their keys: the same labels and scopes give the same windows.
		body = {**USAGE_BODY, "seven_day_opus": {"utilization": 0.5, "resets_at": None}, "seven_day_sonnet": {"resets_at": None}}
		snapshot = limits.anthropic_snapshot(body, NOW)
		hermes = limits.normalize_snapshot("anthropic", SimpleNamespace(fetched_at=dt(NOW), plan=None, raw=None, windows=(
			SimpleNamespace(label="Current session", used_percent=23.0, reset_at=dt(dt_epoch("2026-11-10T04:20:00+00:00")), scope="account"),
			SimpleNamespace(label="Current week", used_percent=40.0, reset_at=dt(dt_epoch("2026-11-12T00:00:00+00:00")), scope="account"),
			SimpleNamespace(label="Opus week", used_percent=0.5, reset_at=None, scope="model"))))
		self.assertEqual(snapshot["windows"][:3], hermes["windows"])
		# Anthropic's utilization is a percent: 0.5 stays 0.5 % (Hermes's own mapping would read it as 50 %). A window without utilization is skipped.
		self.assertEqual([(w["key"], w["used_percent"]) for w in snapshot["windows"]], [("five_hour", 23.0), ("weekly", 40.0), (hermes["windows"][2]["key"], 0.5), ("weekly:fable", 7.0)])
		self.assertEqual((snapshot["fetched_at"], snapshot["plan"], snapshot["reset_grants"]), (NOW, None, None))
		self.assertIsNone(limits.anthropic_snapshot(None, NOW))

	def test_claude_code_login_is_read_with_one_own_get_and_never_through_hermes(self):
		sent, hermes_calls = [], []
		login = {"token": TOKEN, "expired": False}
		readings = collect_claude({"anthropic": []}, lambda clock: login, lambda token: sent.append(token) or USAGE_BODY, clock=lambda: NOW, hermes_calls=hermes_calls)
		(reading,) = readings
		(account,) = reading["accounts"]
		self.assertEqual((reading["provider"], reading["error"], account["id"], account["label"], account["error"], account["snapshot"]["plan"]),
			("anthropic", None, "claude-code", "Claude Code", None, "default_claude_max_5x"))
		self.assertEqual([(w["key"], w["scope"], w["used_percent"]) for w in account["snapshot"]["windows"]], [("five_hour", "account", 23.0), ("weekly", "account", 40.0), ("weekly:fable", "model", 7.0)])
		self.assertEqual((sent, hermes_calls), ([TOKEN], []))
		# The token never leaves the collection, and the local copy is dropped.
		self.assertNotIn("secret", repr(readings))
		self.assertEqual(login, {})
		# The window survives the store and comes out as a model-scoped weekly with its pace duration.
		with tempfile.TemporaryDirectory() as temp:
			store = limits.LimitsStore(Path(temp) / "limits.sqlite3")
			store.record(readings, checked_at=NOW)
			(provider,) = limits.limits_payload(store, hours=1, now=NOW)["providers"]
		fable = provider["accounts"][0]["windows"][2]
		self.assertEqual((fable["key"], fable["model"], fable["remaining_percent"], fable["window_seconds"]), ("weekly:fable", "fable", 93.0, 604800))

	def test_pool_accounts_are_read_with_their_own_token_and_codex_still_through_hermes(self):
		pool = {"anthropic": [{"id": "a00001", "priority": 0, "access_token": "sk-ant-oat01-a"}, {"id": "a00002", "priority": 1, "access_token": "sk-ant-oat01-fails"},
			{"id": "a00003", "priority": 2, "access_token": "sk-ant-api03-console"}], "openai-codex": [{"id": "7c202b", "priority": 0, "access_token": "tok-b"}]}
		sent, hermes_calls = [], []
		readings = collect_claude(pool, NO_CLAUDE, lambda token: sent.append(token) or (None if token.endswith("fails") else USAGE_BODY), hermes_calls=hermes_calls)
		by_id = {a["id"]: a for reading in readings for a in reading["accounts"]}
		self.assertEqual([w["key"] for w in by_id["a00001"]["snapshot"]["windows"]], ["five_hour", "weekly", "weekly:fable"])
		self.assertEqual((by_id["a00002"]["error"], by_id["7c202b"]["error"]), ("refresh_failed", None))
		# A Console API key is never sent to the OAuth endpoint, as Hermes's own rule has it; it reads as having no limits.
		self.assertEqual(by_id["a00003"]["error"], "no_data")
		self.assertEqual((sorted(sent), [provider for provider, _ in hermes_calls]), (["sk-ant-oat01-a", "sk-ant-oat01-fails"], ["openai-codex"]))
		self.assertNotIn("sk-ant", repr(readings))

	def test_a_failed_read_is_a_failed_account(self):
		for body in (lambda token: None, lambda token: {"limits": "broken"}, lambda token: (_ for _ in ()).throw(RuntimeError("429"))):
			(reading,) = collect_claude({}, lambda clock: {"token": TOKEN, "expired": False}, body)
			self.assertEqual((reading["accounts"][0]["error"], reading["accounts"][0]["snapshot"]), ("refresh_failed", None))

	def test_default_read_asks_for_resets_as_the_installed_claude_code_cli(self):
		calls = []

		class Client:
			def __init__(self, **kwargs):
				calls.append(("client", kwargs))

			def __enter__(self):
				return self

			def __exit__(self, *exc):
				return False

			def get(self, url, headers):
				calls.append(("get", url, headers))
				return SimpleNamespace(status_code=200, json=lambda: SCOPED_BODY)

		for version, agent in (("2.1.318", "claude-cli/2.1.318 (external, cli)"), ("", "claude-code/2.1.0")):
			calls.clear()
			with patch("httpx.Client", Client), patch.object(limits, "claude_cli_version", return_value=version):
				self.assertEqual(REAL_FETCH_ANTHROPIC_USAGE("tok"), SCOPED_BODY)
			(_, client), (_, url, headers) = calls
			self.assertEqual((url, headers["Authorization"], client["follow_redirects"]), ("https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1", "Bearer tok", False))
			# Without an installed CLI there is no version to name, so the read goes out as Hermes's own usage fetch does, never as httpx.
			self.assertEqual(headers.get("User-Agent"), agent)
		# The plan's profile read needs no CLI identity: it is named as Hermes names its Anthropic reads.
		calls.clear()

		class Profile(Client):
			def get(self, url, headers):
				calls.append(("get", url, headers))
				return SimpleNamespace(status_code=200, json=lambda: {"organization": {"rate_limit_tier": "default_claude_max_5x"}})

		with patch("httpx.Client", Profile), patch.object(limits, "claude_cli_version", side_effect=AssertionError("no CLI identity for the profile")):
			self.assertEqual(limits._fetch_claude_profile_plan("tok"), "default_claude_max_5x")
		self.assertEqual((calls[1][1], calls[1][2]["User-Agent"], calls[1][2]["Authorization"]), ("https://api.anthropic.com/api/oauth/profile", "claude-code/2.1.0", "Bearer tok"))

	def test_claude_cli_version_is_read_from_the_cli_and_kept_for_six_hours(self):
		saved = dict(limits._CLAUDE_VERSION)
		self.addCleanup(limits._CLAUDE_VERSION.update, saved)
		clock, runs = [0.0], []
		run = lambda output: (lambda: runs.append(output) or output)
		limits._CLAUDE_VERSION.update(checked=float("-inf"), version=None)
		self.assertEqual(limits.claude_cli_version(clock=lambda: clock[0], runner=run("2.1.318 (Claude Code)\n")), "2.1.318")
		clock[0] = limits.CLAUDE_VERSION_TTL_S - 1
		self.assertEqual(limits.claude_cli_version(clock=lambda: clock[0], runner=run("9.9.9")), "2.1.318")
		clock[0] = limits.CLAUDE_VERSION_TTL_S + 1
		self.assertIsNone(limits.claude_cli_version(clock=lambda: clock[0], runner=run("command not found")))
		self.assertEqual(runs, ["2.1.318 (Claude Code)\n", "command not found"])
		clock[0] = 3 * limits.CLAUDE_VERSION_TTL_S
		self.assertIsNone(limits.claude_cli_version(clock=lambda: clock[0], runner=lambda: (_ for _ in ()).throw(OSError("no claude"))))


# A live /api/oauth/usage?cedar_ember=1 body's reset block (field names as Anthropic sends them; ids and values invented).
def resets_body(*grants, eligible=True, shares=({"limit_index": 2, "used_percent_of_weekly": 12, "allowance_percent_of_weekly": 50},)):
	return {**SCOPED_BODY, "weekly_scoped_shares": list(shares), "cedar_ember": {"eligible": eligible, "ineligible_reason": None if eligible else "surface", "at_limit": False,
		"exhausted": [], "grants": list(grants), "next_grant_id": None, "weekly_resets_at": None, "cooldown_until": None, "event_props": None}}


def grant(grant_id="grant_fable_1", **fields):
	return {"id": grant_id, "label": "Fable reset", "resets_total": 1, "resets_left": 1, "starts_at": None, "ends_at": "2026-11-19T00:00:00+00:00", "clears": [],
		"paused": False, "usable_now": True, "use_requires_limit": False, "percent_used": {}, "blocking": [], "gives_back_weekly": False, "unavailable_reason": None, **fields}


class AnthropicResetTests(NoNetworkTestCase):
	def test_grants_take_claude_codes_kinds_and_keep_unusable_ones_with_their_reason(self):
		body = resets_body(
			grant("grant_fable_1", gives_back_weekly=True, type="weekly"),
			grant("grant_session", type="session", usable_now=False, unavailable_reason="needs_limit"),
			grant("grant_blocked", type="weekly", usable_now=False, blocking=["five_hour"]),
			grant("grant_clears_week", clears=["seven_day"]),
			grant("grant_full", clears=["five_hour", "seven_day"], resets_left=2),
			grant("grant_paused", type="weekly", paused=True),
			grant("grant_spent", type="weekly", resets_left=0),
			grant("Bad Id!", type="weekly"))
		result = limits.anthropic_reset_grants(body)
		self.assertEqual([(g["id"], g["kind"], g["resets_left"], g["usable"], g["reason"]) for g in result["grants"]], [
			("grant_fable_1", "fable", 1, True, None), ("grant_session", "session", 1, False, "needs_limit"), ("grant_blocked", "weekly", 1, False, "blocked_five_hour"),
			("grant_clears_week", "weekly", 1, True, None), ("grant_full", "full", 2, True, None)])
		self.assertEqual((result["grants"][0]["ends_at"], result["weekly_share_used"]), (dt_epoch("2026-11-19T00:00:00+00:00"), 12.0))
		# Anthropic answers other clients as ineligible: no resets, which also clears an earlier list. A body asked without the block says nothing about resets.
		self.assertEqual(limits.anthropic_reset_grants(resets_body(grant(), eligible=False))["grants"], [])
		self.assertIsNone(limits.anthropic_reset_grants(SCOPED_BODY))
		self.assertIsNone(limits.anthropic_reset_grants(None))

	def test_collected_resets_are_stored_and_offered_only_while_fresh_and_unexpired(self):
		later = NOW + 86400
		iso = lambda epoch: dt(epoch).isoformat()
		body = resets_body(grant("grant_fable_1", gives_back_weekly=True, ends_at=iso(later + 6 * 86400)), grant("grant_soon", type="session", ends_at=iso(later + 300)))
		# A read without windows fails the account, so each body here carries the usage windows; a body without a reset block keeps the last list.
		reading = lambda at, body: collect_claude({}, lambda clock: {"token": TOKEN, "expired": False}, lambda token: {**USAGE_BODY, **(body(token) or {})}, clock=lambda: at)
		with tempfile.TemporaryDirectory() as temp:
			store = limits.LimitsStore(Path(temp) / "limits.sqlite3")
			store.record(reading(later, lambda token: body), checked_at=later)
			resets = lambda now: limits.limits_payload(store, hours=1, now=now)["providers"][0]["accounts"][0]["reset_grants"]
			self.assertEqual(resets(later), {"fetched_at": later, "weekly_share_used": 12.0, "grants": [
				{"id": "grant_soon", "kind": "session", "resets_left": 1, "ends_at": later + 300, "usable": True, "reason": None, "clears": []},
				{"id": "grant_fable_1", "kind": "fable", "resets_left": 1, "ends_at": later + 6 * 86400, "usable": True, "reason": None, "clears": []}]})
			# A failed read (no reset block) keeps the last list rather than emptying it; an expired reset drops out.
			store.record(reading(later + 60, lambda token: None), checked_at=later + 60)
			self.assertEqual([g["id"] for g in resets(later + 600)["grants"]], ["grant_fable_1"])
			# Past the freshness limit the list is never offered: the reset may have been spent elsewhere meanwhile.
			self.assertIsNone(resets(later + limits.STALE_AFTER_S + 1))
			# An ineligible answer empties it.
			store.record(reading(later + 120, lambda token: resets_body(grant(), eligible=False)), checked_at=later + 120)
			self.assertEqual(resets(later + 130)["grants"], [])

class ClaudeCodeFallbackTests(NoNetworkTestCase):
	def test_plan_is_read_at_the_first_collection_then_hourly_and_kept_through_a_failure(self):
		clock, tokens, answers = [NOW], [], ["default_claude_max_5x", None, "default_claude_max_20x"]
		profile = lambda token: tokens.append(token) or answers.pop(0)
		plan = lambda: collect_claude({}, lambda c: {"token": TOKEN, "expired": False}, profile=profile, clock=lambda: clock[0])[0]["accounts"][0]["snapshot"]["plan"]
		self.assertEqual((plan(), len(tokens)), ("default_claude_max_5x", 1))
		# Every 5-minute sample within the hour reuses it.
		clock[0] = NOW + limits.PLAN_INTERVAL_S - 1
		self.assertEqual((plan(), len(tokens)), ("default_claude_max_5x", 1))
		# A failed hourly read keeps the last plan rather than failing the account, and is retried sooner.
		clock[0] = NOW + limits.PLAN_INTERVAL_S
		self.assertEqual((plan(), len(tokens)), ("default_claude_max_5x", 2))
		clock[0] += limits.PLAN_RETRY_S - 1
		self.assertEqual((plan(), len(tokens)), ("default_claude_max_5x", 2))
		clock[0] += 1
		self.assertEqual((plan(), tokens), ("default_claude_max_20x", [TOKEN] * 3))
		# A new process (Hermes restarted) reads it again at once.
		limits._PLAN_READ.clear()
		answers.append("default_claude_max_5x")
		self.assertEqual((plan(), len(tokens)), ("default_claude_max_5x", 4))

	def test_expired_login_is_refreshed_by_hermes_then_read_again(self):
		# Hermes's resolver rewrites Claude Code's file; the sampler only sees the new token by reading it again.
		files = [{"token": "sk-ant-oat01-old", "expired": True}, {"token": "sk-ant-oat01-new", "expired": False}]
		refreshed, sent = [], []
		(reading,) = collect_claude({}, lambda clock: files.pop(0), lambda token: sent.append(token) or USAGE_BODY, refresher=lambda: refreshed.append(True))
		self.assertEqual((refreshed, sent, reading["accounts"][0]["error"], reading["accounts"][0]["snapshot"]["plan"]), ([True], ["sk-ant-oat01-new"], None, "default_claude_max_5x"))

	def test_default_path_refreshes_through_hermes_then_reads_with_its_own_get(self):
		# Without injected seams Hermes is reached only to refresh an expired login, through its public usage fetch without a token; the reading is the plugin's own GET with the new token.
		files = [{"token": "sk-ant-oat01-old", "expired": True}, {"token": "sk-ant-oat01-new", "expired": False}]
		calls = []
		symbols = CollectorTests.symbols(CollectorTests(), {}, calls)
		with patch.object(limits, "_native_symbols", return_value=symbols):
			(reading,) = limits.collect_native(join_timeout=1, claude_login=lambda clock: files.pop(0), claude_profile=lambda token: "default_claude_max_5x")
		self.assertEqual((calls, self.network), ([("anthropic", {})], ["sk-ant-oat01-new"]))
		# The recorded default read answered nothing, so the account reads as failed.
		self.assertEqual(reading["accounts"][0]["error"], "refresh_failed")

	def test_expired_or_failing_login_is_an_account_error_and_no_login_stays_logged_out(self):
		never = lambda token: self.fail("an expired token is never sent")
		# When Hermes's refresh leaves the file expired or raises, the account reads as expired.
		expired = collect_claude({"anthropic": []}, lambda clock: {"token": TOKEN, "expired": True}, never)
		self.assertEqual(expired[0]["accounts"][0]["error"], "token_expired")
		still = collect_claude({}, lambda clock: {"token": TOKEN, "expired": True}, never, refresher=lambda: None)
		self.assertEqual(still[0]["accounts"][0]["error"], "token_expired")
		raising = collect_claude({}, lambda clock: {"token": TOKEN, "expired": True}, never, refresher=lambda: (_ for _ in ()).throw(RuntimeError("invalid_grant")))
		self.assertEqual(raising[0]["accounts"][0]["error"], "token_expired")
		failing = collect_claude({}, lambda clock: {"token": TOKEN, "expired": False}, lambda token: (_ for _ in ()).throw(RuntimeError("401")))
		self.assertEqual((failing[0]["provider"], failing[0]["accounts"][0]["error"]), ("anthropic", "refresh_failed"))
		self.assertEqual(collect_claude({"anthropic": []}, NO_CLAUDE)[0]["error"], "logged_out")
		self.assertEqual(collect_claude({}, NO_CLAUDE), [])

	def test_hermes_pool_wins_over_claude_code(self):
		pool = {"anthropic": [{"id": "a00001", "label": "pool", "priority": 0, "access_token": "sk-ant-oat01-a"}]}
		readings = collect_claude(pool, lambda clock: self.fail("Claude Code is not read when Hermes has a pool"))
		self.assertEqual([a["id"] for a in readings[0]["accounts"]], ["a00001"])

	def test_login_reader_is_read_only_and_honours_claude_config_dir(self):
		with tempfile.TemporaryDirectory() as temp:
			path = Path(temp) / ".credentials.json"
			body = '{"claudeAiOauth": {"accessToken": "tok", "refreshToken": "r", "expiresAt": 2000000, "subscriptionType": "team", "rateLimitTier": "default_claude_max_5x"}}'
			path.write_text(body, encoding="utf-8")
			with patch.dict(limits.os.environ, {"CLAUDE_CONFIG_DIR": temp}):
				self.assertEqual(limits._claude_code_login(clock=lambda: 1000.0), {"token": "tok", "expired": False})
				self.assertTrue(limits._claude_code_login(clock=lambda: 3000.0)["expired"])
				path.write_text("{broken", encoding="utf-8")
				self.assertIsNone(limits._claude_code_login())
			path.write_text(body, encoding="utf-8")
			self.assertEqual(path.read_text(encoding="utf-8"), body)

	def test_login_reader_accepts_a_byte_order_mark(self):
		# Windows tools (PowerShell Set-Content, some editors) prefix the files they touch with a BOM, which plain utf-8 JSON parsing rejects.
		with tempfile.TemporaryDirectory() as temp:
			body = '{"claudeAiOauth": {"accessToken": "tok", "expiresAt": 2000000}}'
			(Path(temp) / ".credentials.json").write_text(body, encoding="utf-8-sig")
			with patch.dict(limits.os.environ, {"CLAUDE_CONFIG_DIR": temp}):
				self.assertEqual(limits._claude_code_login(clock=lambda: 1000.0), {"token": "tok", "expired": False})


def dt_epoch(text):
	return datetime.fromisoformat(text).timestamp()


if __name__ == "__main__":
	unittest.main()
