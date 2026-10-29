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
				label="chatgpt1", priority=1, banked=2),
			account("7c202b", NOW - 50, [window("weekly", 80.0, NOW + 5000, "Weekly", 604800)], label="chatgptvitibot", priority=0, banked=0),
		), checked_at=NOW)
		payload = limits.limits_payload(self.store, hours=168, now=NOW, sampler_status=None)
		(provider,) = payload["providers"]
		self.assertEqual((provider["provider"], provider["label"], provider["error"]), ("openai-codex", "OpenAI Codex", None))
		self.assertEqual([a["id"] for a in provider["accounts"]], ["7c202b", "7ad3ca"])
		second = provider["accounts"][1]
		self.assertEqual((second["label"], second["priority"], second["plan"], second["banked_resets"]), ("chatgpt1", 1, "Pro", 2))
		self.assertEqual([w["key"] for w in second["windows"]], ["five_hour", "weekly"])
		self.assertEqual(second["windows"][1]["remaining_percent"], 58.0)
		self.assertEqual(provider["accounts"][0]["banked_resets"], 0)
		self.assertEqual([(h["t"], h["account"], h["window"]) for h in provider["history"]],
			[(NOW - 100, "7ad3ca", "five_hour"), (NOW - 100, "7ad3ca", "weekly"), (NOW - 50, "7c202b", "weekly")])

	def test_model_scoped_windows_keep_model(self):
		self.store.record([{"provider": "anthropic", "error": None, "accounts": [account("a1b2c3", NOW - 10, [
			window("weekly", 20.0, None, "Current week"), window("weekly:opus", 90.0, None, "Opus week", scope="model", model="opus"),
		])]}], checked_at=NOW)
		(provider,) = limits.limits_payload(self.store, hours=1, now=NOW)["providers"]
		opus = provider["accounts"][0]["windows"][1]
		self.assertEqual((opus["key"], opus["scope"], opus["model"]), ("weekly:opus", "model", "opus"))
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
		self.assertEqual(provider["history"], [{"t": NOW - 10, "account": "7ad3ca", "window": "w3600", "remaining_percent": None, "resets_at": None}])

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
		self.assertEqual([h["t"] for h in provider["history"]], [NOW - 1800])
		self.assertEqual(provider["accounts"][0]["windows"][0]["used_percent"], 20.0)
		self.assertTrue(provider["accounts"][0]["stale"])
		self.assertEqual(payload["sampler"], {"interval_s": 300.0, "started_at": 1.0, "last_run_at": 2.0, "last_error": None})
		self.assertEqual(payload["generated_at"], NOW)
		fresh = limits.limits_payload(self.store, hours=2, now=NOW - 1800 + 899)["providers"][0]
		self.assertFalse(fresh["accounts"][0]["stale"])
		self.assertEqual([h["t"] for h in fresh["history"]], [NOW - 7200, NOW - 1800])
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
		self.assertEqual(set(out), {"fetched_at", "plan", "banked_resets", "windows"})
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

	def symbols(self, cache, refreshed, pool):
		def refresh(requests):
			refreshed.append([dict(r) for r in requests])
			self.passed = requests

			# Like Hermes's _refresh_entries, the worker gets its own copy of the requests.
			due = list(requests)

			def work():
				time.sleep(0.05)
				for request in due:
					if request["identity_id"] not in ("id:fails", "id:old"):
						cache[(request["provider"], request["identity_id"])] = SimpleNamespace(
							fetched_at=dt(time.time()), plan="Pro", raw=None,
							windows=(SimpleNamespace(label="Weekly", used_percent=50.0, reset_at=None, scope="account"),))
			thread = threading.Thread(target=work)
			thread.start()
			return [thread]

		return {
			"cached_account_usage": lambda provider, identity_id=None: cache.get((provider, identity_id)),
			"refresh_account_usage_entries_async": refresh,
			"_identity_id_for": lambda provider, entry: f"id:{entry.runtime_api_key}",
			"REFRESH_AFTER_S": 120.0,
			"PooledCredential": FakeEntry,
			"STATUS_DEAD": "dead",
			"read_credential_pool": lambda: pool,
			"_pool_entry_route_base_url": lambda provider, entry: "https://example.invalid/backend-api/codex",
			"_pool_entry_host": lambda provider, entry: "example.invalid",
		}

	def test_collects_vetted_pools_read_only_without_keeping_tokens(self):
		pool = {
			"openai-codex": [
				{"id": "7c202b", "label": "chatgptvitibot", "priority": 0, "access_token": "tok-a"},
				{"id": "7ad3ca", "label": "chatgpt1", "priority": 1, "access_token": "tok-b"},
				{"id": "dup001", "label": "dup", "priority": 2, "access_token": "tok-a"},
				{"id": "dead01", "label": "me@example.com", "priority": 3, "access_token": "tok-d", "last_status": "dead"},
				{"id": "empty1", "priority": 4},
				{"id": "fail01", "priority": 5, "access_token": "fails"},
				{"id": "old001", "priority": 6, "access_token": "old"},
			],
			"openrouter": [{"id": "or0001", "access_token": "tok-or"}],
			"anthropic": [],
		}
		cache = {("openai-codex", "id:old"): SimpleNamespace(fetched_at=dt(time.time() - 3600), plan=None, raw=None,
			windows=(SimpleNamespace(label="Session", used_percent=1.0, reset_at=None, scope="account"),))}
		refreshed = []
		with patch.object(limits, "_native_symbols", return_value=self.symbols(cache, refreshed, pool)):
			readings = limits.collect_native(join_timeout=5)
		# An emptied pool key is reported as logged out; a provider outside the vetted set is never sampled.
		self.assertEqual([(r["provider"], r["error"], r["accounts"]) for r in readings[:1]], [("anthropic", "logged_out", [])])
		reading = readings[1]
		self.assertEqual([r["provider"] for r in readings], ["anthropic", "openai-codex"])
		by_id = {a["id"]: a for a in reading["accounts"]}
		self.assertEqual(list(by_id), ["7c202b", "7ad3ca", "dead01", "empty1", "fail01", "old001"])
		self.assertEqual([r["identity_id"] for r in refreshed[0]], ["id:tok-a", "id:tok-b", "id:fails", "id:old"])
		self.assertEqual(self.passed, [], "the request list holding tokens must be cleared after the refresh call")
		self.assertEqual(by_id["dead01"]["error"], "credential_dead")
		self.assertEqual(by_id["dead01"]["label"], "account dead01")
		self.assertEqual(by_id["empty1"]["error"], "no_credential")
		self.assertEqual(by_id["fail01"]["error"], "no_data")
		self.assertEqual(by_id["old001"]["error"], "refresh_failed")
		self.assertIsNone(by_id["7ad3ca"]["error"])
		self.assertEqual(by_id["7ad3ca"]["snapshot"]["windows"][0]["key"], "weekly")
		self.assertNotIn("tok-", repr(readings))
		self.assertNotIn("id:", repr(readings))
		with tempfile.TemporaryDirectory() as temp:
			path = Path(temp) / "limits.sqlite3"
			store = limits.LimitsStore(path)
			store.record(readings, checked_at=time.time())
			payload = limits.limits_payload(store, hours=24, now=time.time())
			self.assertEqual({p["provider"]: (p["auth"], p["error"], len(p["accounts"])) for p in payload["providers"]}, {"anthropic": ("logged_out", None, 0), "openai-codex": ("ok", None, 6)})
			self.assertNotIn(b"tok-", path.read_bytes())
			self.assertNotIn(b"example", path.read_bytes())

	def test_missing_native_symbol_reports_unavailable(self):
		symbols = self.symbols({}, [], {"openai-codex": [{"id": "7ad3ca", "access_token": "x"}]})
		symbols["_identity_id_for"] = None
		with patch.object(limits, "_native_symbols", return_value=symbols):
			(reading,) = limits.collect_native(join_timeout=1)
		self.assertEqual((reading["error"], reading["accounts"]), ("unavailable", []))
		symbols["read_credential_pool"] = None
		with patch.object(limits, "_native_symbols", return_value=symbols):
			with self.assertRaises(RuntimeError):
				limits.collect_native(join_timeout=1)

	def test_default_collector_only_uses_vetted_native_functions(self):
		tree = ast.parse((ROOT / "usage_limits.py").read_text(encoding="utf-8"))
		taken = {
			(node.args[0].value, node.args[1].value) for node in ast.walk(tree)
			if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "take"
			and isinstance(node.args[0], ast.Constant) and isinstance(node.args[1], ast.Constant)
		}
		self.assertEqual(taken, {
			("agent.account_usage_cache", "cached_account_usage"),
			("agent.account_usage_cache", "refresh_account_usage_entries_async"),
			("agent.account_usage_cache", "_identity_id_for"),
			("agent.account_usage_cache", "REFRESH_AFTER_S"),
			("agent.credential_pool", "PooledCredential"),
			("agent.credential_pool", "STATUS_DEAD"),
			("hermes_cli.auth", "read_credential_pool"),
			("hermes_cli.inventory", "_pool_entry_route_base_url"),
			("hermes_cli.inventory", "_pool_entry_host"),
		})
		imported = {
			(node.module, alias.name) for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)
			for alias in node.names if node.module and node.module.split(".")[0] in ("agent", "hermes_cli", "hermes_constants")
		}
		self.assertEqual(imported, {
			("agent.account_usage", "_codex_banked_resets"),
			("hermes_constants", "get_hermes_home"), ("hermes_constants", "hermes_home_key"),
			("hermes_constants", "reset_hermes_home_override"), ("hermes_constants", "set_hermes_home_override"),
		})
		forbidden = {
			"refresh_account_usage_async", "fetch_account_usage", "load_pool", "select", "try_refresh_matching",
			"resolve_codex_runtime_credentials", "resolve_anthropic_token", "_persist", "persist_pool_entries",
			"_save_auth_store", "redeem_codex_reset_credit", "remember_account_usage", "_claim_refresh",
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
