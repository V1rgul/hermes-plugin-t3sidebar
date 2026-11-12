"""Limits store and credit throttle housekeeping: scratch SQLite, fake collectors and clocks, no network or live auth."""

from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest

from test_backend import backend


limits = backend.usage_limits
NOW = 1800000000.0
CREDIT = {"status": "available", "granted_at": NOW - 86400, "expires_at": NOW + 86400}


def sampled(account_id, fetched_at, **extra):
	return {"id": account_id, "label": f"acct-{account_id}", "priority": 0, "error": None,
		"snapshot": {"fetched_at": fetched_at, "plan": "Pro", "banked_resets": None, "windows": [
			{"key": "weekly", "label": None, "window_seconds": None, "scope": "account", "model": None, "used_percent": 40.0, "resets_at": None}]}, **extra}


class CreditRetention(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="t3-limits-housekeeping-")
		self.addCleanup(self.temp.cleanup)
		self.path = Path(self.temp.name) / "limits.sqlite3"
		self.store = limits.LimitsStore(self.path)

	def credit_keys(self):
		with closing(sqlite3.connect(self.path)) as connection:
			return sorted(connection.execute("SELECT provider, account_id FROM limit_credits"))

	def test_credit_lists_go_with_the_last_sample_of_their_account(self):
		self.store.record([{"provider": "openai-codex", "error": None, "accounts": [
			sampled("kept", NOW, credits=[CREDIT]), sampled("removed", NOW, credits=[CREDIT])]}], checked_at=NOW)
		later = NOW + limits.RETENTION_S - 60
		# While its samples are retained a removed account still shows, with its credits.
		self.store.record([{"provider": "openai-codex", "error": None, "accounts": [sampled("kept", later)]}], checked_at=later)
		self.assertEqual(self.credit_keys(), [("openai-codex", "kept"), ("openai-codex", "removed")])
		gone = NOW + limits.RETENTION_S + 60
		self.store.record([{"provider": "openai-codex", "error": None, "accounts": [sampled("kept", gone)]}], checked_at=gone)
		self.assertEqual(self.credit_keys(), [("openai-codex", "kept")])
		accounts = limits.limits_payload(self.store, hours=24, now=gone)["providers"][0]["accounts"]
		self.assertEqual([(account["id"], [credit["expires_at"] for credit in account["banked_credits"]["credits"]]) for account in accounts], [("kept", [])])


class CreditThrottleRetention(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="t3-limits-throttle-")
		self.addCleanup(self.temp.cleanup)
		self.home = Path(self.temp.name) / "home"
		self.home.mkdir()
		self.store = limits.LimitsStore(Path(self.temp.name) / "limits.sqlite3")
		saved = dict(limits._CREDITS_READ)
		self.addCleanup(lambda: (limits._CREDITS_READ.clear(), limits._CREDITS_READ.update(saved)))
		limits._CREDITS_READ.clear()

	def test_a_tick_forgets_its_homes_credit_reads_that_are_due_anyway(self):
		sampler = limits.LimitsSampler(self.store, home_resolver=lambda: self.home, collector=lambda: [], clock=lambda: NOW)
		with limits._home_scope(self.home):
			home = limits._home_key(limits._default_home())
		due = NOW - limits.CREDITS_INTERVAL_S
		limits._CREDITS_READ.update({
			(home, "openai-codex", "removed"): due,
			(home, "openai-codex", "older"): due - 86400,
			(home, "openai-codex", "recent"): due + 1,
			("another-home", "openai-codex", "removed"): due,
		})
		sampler.run_once()
		self.assertEqual(limits._CREDITS_READ, {(home, "openai-codex", "recent"): due + 1, ("another-home", "openai-codex", "removed"): due})


class CreditListCap(unittest.TestCase):
	def test_available_credits_after_a_long_history_are_kept(self):
		history = [{"status": "redeemed", "expires_at": "2026-01-01T00:00:00Z"} for _ in range(limits.MAX_CREDITS + 10)]
		junk = ["junk", {"status": "Bad Status!"}, {"expires_at": "2026-01-01T00:00:00Z"}] * limits.MAX_CREDITS
		later = [{"status": "available", "expires_at": "2026-12-01T00:00:00Z"}, {"status": "available", "expires_at": None}, {"status": "available", "expires_at": "not a date"}]
		credits = limits.normalize_credits({"credits": history + junk + later})
		self.assertEqual([(credit["status"], credit["expires_at"]) for credit in credits], [("available", 1796083200.0), ("available", None), ("available", None)])

	def test_the_cap_bounds_the_kept_credits(self):
		listed = [{"status": "available", "expires_at": NOW + index} for index in range(limits.MAX_CREDITS + 5)]
		credits = limits.normalize_credits({"credits": listed})
		self.assertEqual([credit["expires_at"] for credit in credits], [NOW + index for index in range(limits.MAX_CREDITS)])


if __name__ == "__main__":
	unittest.main()
