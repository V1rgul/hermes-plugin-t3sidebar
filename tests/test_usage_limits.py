"""Provider limit sampler + history store: scratch SQLite, fake collectors and clocks, no network or live auth."""

from contextlib import closing
import ast
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
		self.assertEqual(payload["sampler"], {"interval_s": 300.0, "started_at": 1.0, "last_run_at": 2.0, "last_error": None})
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
		self.assertEqual(payload["sampler"], {"interval_s": None, "started_at": None, "last_run_at": None, "last_error": None})
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

	def test_experimental_setting_reads_codex_credit_lists_hourly_with_each_accounts_token(self):
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
		collect = lambda: limits.collect_native(claude_login=NO_CLAUDE, join_timeout=5, clock=lambda: now[0], credits_fetcher=fetch,
			pool_credits_setting=lambda: True, current_credits_fetcher=lambda: self.fail("the per-account mode never reads the current account's list"))
		with patch.object(limits, "_native_symbols", return_value=symbols):
			(reading,) = collect()
			self.assertEqual(reading["credits_mode"], "accounts")
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

	def test_default_reads_only_the_current_accounts_credits_through_hermes_hourly(self):
		pool = {"openai-codex": [{"id": "7c202b", "label": "a", "priority": 0, "access_token": "tok-a"}, {"id": "7ad3ca", "label": "b", "priority": 1, "access_token": "tok-b"}]}
		current = []
		listed = [{"status": "available", "granted_at": 1.0e9, "expires_at": 2.0e9}]
		now = [1_800_000_000.0]
		full = dict(self.symbols(pool), _codex_backend_urls=lambda base: (None, None, None), _codex_headers=lambda token, account: {})
		# Off, or on while Hermes no longer has the private helpers: no pool token is used for credits, only Hermes's own signed read.
		for setting, symbols in ((lambda: False, full), (lambda: True, self.symbols(pool)), (lambda: (_ for _ in ()).throw(RuntimeError("config")), full)):
			limits._CREDITS_READ.clear()
			with patch.object(limits, "_native_symbols", return_value=symbols):
				(reading,) = limits.collect_native(claude_login=NO_CLAUDE, join_timeout=5, clock=lambda: now[0], pool_credits_setting=setting,
					credits_fetcher=lambda base_url, token: self.fail("no per-account read by default"), current_credits_fetcher=lambda: current.append(True) or listed)
			self.assertEqual((reading["credits_mode"], reading["current_credits"]), ("current", listed))
			self.assertTrue(all("credits" not in account for account in reading["accounts"]))
		self.assertEqual(len(current), 3)
		# Hourly like the per-account lists; a failed read leaves the stored list alone.
		with patch.object(limits, "_native_symbols", return_value=full):
			now[0] += limits.CREDITS_INTERVAL_S - 1
			(reading,) = limits.collect_native(claude_login=NO_CLAUDE, join_timeout=5, clock=lambda: now[0], pool_credits_setting=lambda: False, current_credits_fetcher=lambda: current.append(True) or listed)
			self.assertEqual((len(current), "current_credits" in reading), (3, False))
			now[0] += 1
			(reading,) = limits.collect_native(claude_login=NO_CLAUDE, join_timeout=5, clock=lambda: now[0], pool_credits_setting=lambda: False, current_credits_fetcher=lambda: None)
			self.assertEqual((reading["credits_mode"], "current_credits" in reading), ("current", False))
			# A redeemed reset may have changed the current account's list too.
			limits.forget_credit_read("openai-codex", "7c202b")
			(reading,) = limits.collect_native(claude_login=NO_CLAUDE, join_timeout=5, clock=lambda: now[0], pool_credits_setting=lambda: False, current_credits_fetcher=lambda: listed)
			self.assertEqual(reading["current_credits"], listed)
		# A logged-out Codex pool asks nothing.
		with patch.object(limits, "_native_symbols", return_value=self.symbols({"openai-codex": []})):
			(reading,) = limits.collect_native(claude_login=NO_CLAUDE, join_timeout=1, clock=lambda: now[0] + 86400, current_credits_fetcher=lambda: self.fail("no sign-in to read with"))
		self.assertNotIn("credits_mode", reading)

	def test_current_account_read_goes_through_hermes_signed_request(self):
		import hermes_cli.plugin_provider_requests as requests
		calls = []
		body = {"credits": [{"status": "available", "granted_at": "2026-09-29T18:58:39Z", "expires_at": "2026-10-29T18:58:39Z", "id": "secret-id"}]}

		def signed(provider, method, url, **kwargs):
			calls.append((provider, method, url, kwargs))
			return SimpleNamespace(status=200, json=lambda: body)
		with patch.object(requests, "credentialed_provider_request", signed):
			self.assertEqual(limits._fetch_current_codex_credits(), limits.normalize_credits(body))
		((provider, method, url, kwargs),) = calls
		self.assertEqual((provider, method, url), ("openai-codex", "GET", "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"))
		# The plugin names itself and sends no credential of its own; Hermes attaches the sign-in.
		self.assertEqual(kwargs["headers"], {"Accept": "application/json", "User-Agent": "hermes-t3sidebar"})
		for response in (SimpleNamespace(status=401, json=lambda: body), PermissionError("not declared")):
			def failing(*args, response=response, **kwargs):
				if isinstance(response, Exception):
					raise response
				return response
			with patch.object(requests, "credentialed_provider_request", failing):
				self.assertIsNone(limits._fetch_current_codex_credits())

	def test_experimental_setting_lives_in_the_limits_store_and_needs_hermes_helpers(self):
		with tempfile.TemporaryDirectory() as temp:
			store = limits.LimitsStore(Path(temp) / "limits.sqlite3")
			# Off until written, even before the store file exists.
			self.assertFalse(store.read_setting(limits.POOL_CREDITS_SETTING))
			store.write_setting(limits.POOL_CREDITS_SETTING, True)
			self.assertTrue(store.read_setting(limits.POOL_CREDITS_SETTING))
			store.write_setting(limits.POOL_CREDITS_SETTING, False)
			self.assertFalse(store.read_setting(limits.POOL_CREDITS_SETTING))
			# The sampler hands the stored value to each collection.
			store.write_setting(limits.POOL_CREDITS_SETTING, True)
			seen = []
			with patch.object(limits, "collect_native", side_effect=lambda **kwargs: seen.append(kwargs["pool_credits_setting"]()) or []):
				limits.LimitsSampler(store, home_resolver=lambda: Path(temp))._collect()
			self.assertEqual(seen, [True])
		self.assertTrue(limits.pool_credits_available({"_codex_backend_urls": len, "_codex_headers": len}))
		self.assertFalse(limits.pool_credits_available({"_codex_backend_urls": len, "_codex_headers": None}))
		self.assertFalse(limits.pool_credits_available({}))

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
			("hermes_cli.plugin_provider_requests", "credentialed_provider_request"),
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


if __name__ == "__main__":
	unittest.main()


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
		# Unparseable or zone-less times become None rather than being guessed in local time.
		self.assertEqual([(c["status"], c["expires_at"]) for c in credits[1:]], [("redeemed", None), ("available", None)])
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

	def test_credit_mode_keeps_only_its_own_lists(self):
		now = 1_800_000_000.0
		listed = [{"status": "available", "granted_at": now - 86400, "expires_at": now + 3 * 86400}]
		with tempfile.TemporaryDirectory() as temp:
			store = limits.LimitsStore(Path(temp) / "limits.sqlite3")
			payload = lambda t: limits.limits_payload(store, hours=24, now=t)["providers"][0]
			sampled = lambda t, **extra: dict(account("7ad3ca", t, [window("weekly", 40.0, now + 86400)]), **extra)
			# Per-account mode: lists sit on their accounts and nothing at the provider level.
			store.record([{"provider": "openai-codex", "error": None, "credits_mode": "accounts", "accounts": [sampled(now, credits=listed)]}], checked_at=now)
			block = payload(now)
			self.assertEqual(([c["expires_at"] for c in block["accounts"][0]["banked_credits"]["credits"]], block["current_banked_credits"]), ([now + 3 * 86400], None))
			# Default mode: the per-account list is dropped rather than left to go stale, and the current account's list is provider-level.
			store.record([{"provider": "openai-codex", "error": None, "credits_mode": "current", "current_credits": listed, "accounts": [sampled(now + 300)]}], checked_at=now + 300)
			block = payload(now + 300)
			self.assertIsNone(block["accounts"][0]["banked_credits"])
			self.assertEqual((block["current_banked_credits"]["fetched_at"], [c["expires_at"] for c in block["current_banked_credits"]["credits"]]), (now + 300, [now + 3 * 86400]))
			self.assertNotIn(limits.CURRENT_CREDITS_ID, [a["id"] for a in block["accounts"]])
			# A sample without a fresh read keeps the current list; switching back to per-account drops it.
			store.record([{"provider": "openai-codex", "error": None, "credits_mode": "current", "accounts": [sampled(now + 600)]}], checked_at=now + 600)
			self.assertIsNotNone(payload(now + 600)["current_banked_credits"])
			store.record([{"provider": "openai-codex", "error": None, "credits_mode": "accounts", "accounts": [sampled(now + 900)]}], checked_at=now + 900)
			self.assertIsNone(payload(now + 900)["current_banked_credits"])

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


class ClaudeCodeFallbackTests(unittest.TestCase):
	def collect(self, pool, login, fetcher, profile=None, refresher=None):
		symbols = CollectorTests.symbols(CollectorTests(), pool)
		profile = profile or (lambda token: "default_claude_max_5x")
		with patch.object(limits, "_native_symbols", return_value=symbols):
			return limits.collect_native(join_timeout=1, claude_login=login, claude_fetcher=fetcher, claude_profile=profile, claude_refresher=refresher)

	def test_plan_is_the_profiles_rate_limit_tier(self):
		fetch = lambda **kwargs: SimpleNamespace(fetched_at=dt(NOW), plan=None, raw=None, windows=(
			SimpleNamespace(label="Current week", used_percent=4.0, reset_at=dt(NOW + 6 * 86400), scope="account"),))
		tokens = []
		profile = lambda token: tokens.append(token) or "default_claude_max_5x"
		readings = self.collect({}, lambda clock: {"token": "tok", "expired": False}, fetch, profile)
		self.assertEqual((readings[0]["accounts"][0]["snapshot"]["plan"], tokens), ("default_claude_max_5x", ["tok"]))
		# A failed profile read leaves the plan unknown rather than failing the account.
		readings = self.collect({}, lambda clock: {"token": "tok", "expired": False}, fetch, lambda token: None)
		self.assertEqual((readings[0]["accounts"][0]["error"], readings[0]["accounts"][0]["snapshot"]["plan"]), (None, None))

	def test_empty_hermes_pool_reads_claude_codes_login_with_one_explicit_token_fetch(self):
		calls = []

		def fetch(**kwargs):
			calls.append(kwargs)
			return SimpleNamespace(fetched_at=dt(NOW), plan=None, raw=None, windows=(
				SimpleNamespace(label="Current session", used_percent=36.0, reset_at=dt(NOW + 1200), scope="account"),
				SimpleNamespace(label="Current week", used_percent=4.0, reset_at=dt(NOW + 6 * 86400), scope="account")))
		login = {"token": "sk-ant-oat-secret", "expired": False}
		readings = self.collect({"anthropic": []}, lambda clock: login, fetch)
		(reading,) = readings
		self.assertEqual((reading["provider"], reading["error"]), ("anthropic", None))
		(account,) = reading["accounts"]
		self.assertEqual((account["id"], account["label"], account["error"], account["snapshot"]["plan"]), ("claude-code", "Claude Code", None, "default_claude_max_5x"))
		self.assertEqual([w["key"] for w in account["snapshot"]["windows"]], ["five_hour", "weekly"])
		self.assertEqual(calls, [{"api_key": "sk-ant-oat-secret"}])
		# The token never leaves the collection, and the local copy is dropped.
		self.assertNotIn("secret", repr(readings))
		self.assertEqual(login, {})

	def test_expired_login_is_refreshed_by_hermes_then_read_again(self):
		# Hermes's resolver rewrites Claude Code's file; the sampler only sees the new token by reading it again.
		files = [{"token": "old", "expired": True}, {"token": "new", "expired": False}]
		refreshed, sent = [], []
		fetch = lambda **kw: sent.append(kw["api_key"]) or SimpleNamespace(fetched_at=dt(NOW), plan=None, raw=None, windows=(
			SimpleNamespace(label="Current week", used_percent=4.0, reset_at=dt(NOW + 6 * 86400), scope="account"),))
		(reading,) = self.collect({}, lambda clock: files.pop(0), fetch, refresher=lambda: refreshed.append(True) or "new")
		self.assertEqual((refreshed, sent, reading["accounts"][0]["error"]), ([True], ["new"], None))
		self.assertEqual(reading["accounts"][0]["snapshot"]["plan"], "default_claude_max_5x")

	def test_default_path_refreshes_and_reads_through_hermes_public_usage_fetch(self):
		# Without injected seams the fallback reaches Hermes only through its public usage fetch: without a token for an expired login, so Hermes resolves and refreshes one, then with the login's new token.
		files = [{"token": "old", "expired": True}, {"token": "new", "expired": False}]
		calls = []
		symbols = CollectorTests.symbols(CollectorTests(), {})
		symbols["fetch_account_usage"] = lambda provider, **kwargs: calls.append(("fetch", provider, kwargs)) or SimpleNamespace(fetched_at=dt(NOW), plan=None, raw=None, windows=(
			SimpleNamespace(label="Current week", used_percent=4.0, reset_at=dt(NOW + 6 * 86400), scope="account"),))
		with patch.object(limits, "_native_symbols", return_value=symbols):
			(reading,) = limits.collect_native(join_timeout=1, claude_login=lambda clock: files.pop(0), claude_profile=lambda token: "default_claude_max_5x")
		self.assertEqual(calls, [("fetch", "anthropic", {}), ("fetch", "anthropic", {"api_key": "new"})])
		self.assertEqual((reading["accounts"][0]["error"], reading["accounts"][0]["snapshot"]["windows"][0]["key"]), (None, "weekly"))

	def test_expired_or_failing_login_is_an_account_error_and_no_login_stays_logged_out(self):
		never = lambda **kw: self.fail("an expired token is never sent")
		# When Hermes's refresh leaves the file expired or raises, the account reads as expired.
		expired = self.collect({"anthropic": []}, lambda clock: {"token": "t", "expired": True}, never)
		self.assertEqual(expired[0]["accounts"][0]["error"], "token_expired")
		still = self.collect({}, lambda clock: {"token": "t", "expired": True}, never, refresher=lambda: None)
		self.assertEqual(still[0]["accounts"][0]["error"], "token_expired")
		raising = self.collect({}, lambda clock: {"token": "t", "expired": True}, never, refresher=lambda: (_ for _ in ()).throw(RuntimeError("invalid_grant")))
		self.assertEqual(raising[0]["accounts"][0]["error"], "token_expired")
		failing = self.collect({}, lambda clock: {"token": "t", "expired": False}, lambda **kw: (_ for _ in ()).throw(RuntimeError("401")))
		self.assertEqual((failing[0]["provider"], failing[0]["accounts"][0]["error"]), ("anthropic", "refresh_failed"))
		self.assertEqual(self.collect({"anthropic": []}, NO_CLAUDE, None)[0]["error"], "logged_out")
		self.assertEqual(self.collect({}, NO_CLAUDE, None), [])

	def test_hermes_pool_wins_over_claude_code(self):
		pool = {"anthropic": [{"id": "a00001", "label": "pool", "priority": 0, "access_token": "tok-a"}]}
		readings = self.collect(pool, lambda clock: self.fail("Claude Code is not read when Hermes has a pool"), None)
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
