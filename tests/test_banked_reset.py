"""Banked reset redemption: fake Hermes symbols and pool, no network or live auth."""

import importlib.util
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
# A module reference, not imported names: discovery would otherwise run the collector tests twice.
import test_usage_limits as collector_tests  # noqa: E402

limits = collector_tests.limits

SPEC = importlib.util.spec_from_file_location("t3sidebar_banked_reset_test", ROOT / "banked_reset.py")
assert SPEC is not None and SPEC.loader is not None
banked = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(banked)

ROUTE = "https://example.invalid/backend-api/codex"


class RedeemTests(unittest.TestCase):
	def setUp(self):
		limits._CREDITS_READ.clear()
		self.addCleanup(limits._CREDITS_READ.clear)
		self.calls = []
		self.pool = {"openai-codex": [
			{"id": "7c202b", "label": "codex-team", "priority": 0, "access_token": "tok-a"},
			{"id": "7ad3ca", "label": "codex-pro", "priority": 1, "access_token": "tok-b"},
			{"id": "dead01", "priority": 2, "access_token": "tok-d", "last_status": "dead"},
		]}
		self.result = SimpleNamespace(status="reset", message="✅ Reset redeemed. Could not reach https://secret.invalid/?token=tok-b", available_count=1, windows_reset=2)

	def symbols(self):
		def redeem(**kwargs):
			self.calls.append(("redeem", kwargs))
			return self.result
		return {
			**collector_tests.CollectorTests.symbols(collector_tests.CollectorTests(), {}, [], self.pool),
			"redeem_codex_reset_credit": redeem,
			"fetch_account_usage": lambda provider, **kwargs: self.calls.append(("fetch", provider, kwargs)),
		}

	def redeem(self, account_id, symbols=None, lock=None):
		with patch.object(limits, "_home_key", return_value="home"), patch.object(limits, "_default_home", return_value="/scratch/home"):
			return banked.redeem(account_id, limits=limits, symbols=symbols or self.symbols(), lock=lock or threading.Lock())

	def test_redeems_with_the_entrys_own_credential_and_rereads_only_that_account(self):
		limits._CREDITS_READ.update({("home", "openai-codex", "7ad3ca"): 1.0, ("home", "openai-codex", "7c202b"): 1.0})
		outcome = self.redeem("7ad3ca")
		# Status and counts only: Hermes's message can carry exception text with URLs or tokens.
		self.assertEqual(outcome, {"status": "reset", "available_count": 1, "windows_reset": 2})
		self.assertEqual(self.calls[0], ("redeem", {"base_url": ROUTE, "api_key": "tok-b", "force": True}))
		self.assertEqual(self.calls[1], ("fetch", "openai-codex", {"base_url": ROUTE, "api_key": "tok-b", "read_only": True, "identity_id": "id:tok-b"}))
		# The redeemed account's credit list is due again; the other account keeps its hourly throttle.
		self.assertEqual(set(limits._CREDITS_READ), {("home", "openai-codex", "7c202b")})

	def test_outcomes_that_spend_nothing_reread_nothing(self):
		for status in ("nothing_to_reset", "no_credit", "no_credits_banked", "unavailable"):
			self.calls.clear()
			self.result = SimpleNamespace(status=status, message="m", available_count=2, windows_reset=0)
			self.assertEqual(self.redeem("7c202b")["status"], status)
			self.assertEqual([call[0] for call in self.calls], ["redeem"], status)
		self.result = SimpleNamespace(status="surprise", available_count=True, windows_reset=-1)
		self.assertEqual(self.redeem("7c202b"), {"status": "unavailable", "available_count": None, "windows_reset": 0})

	def test_a_failed_reread_still_reports_the_redemption(self):
		symbols = self.symbols()
		def broken(provider, **kwargs):
			raise RuntimeError("tok-b")
		symbols["fetch_account_usage"] = broken
		self.assertEqual(self.redeem("7ad3ca", symbols)["status"], "reset")

	def test_unknown_dead_or_missing_credentials_never_reach_codex(self):
		with self.assertRaises(LookupError):
			self.redeem("nope00")
		self.assertEqual(self.redeem("dead01")["status"], "unavailable")
		self.pool["openai-codex"].append({"id": "empty1", "priority": 3})
		self.assertEqual(self.redeem("empty1")["status"], "unavailable")
		self.assertEqual(self.calls, [])
		symbols = self.symbols()
		symbols["redeem_codex_reset_credit"] = None
		with self.assertRaises(RuntimeError):
			self.redeem("7ad3ca", symbols)

	def test_a_second_redemption_is_refused_while_one_runs(self):
		lock = threading.Lock()
		lock.acquire()
		with self.assertRaises(banked.Busy):
			self.redeem("7ad3ca", lock=lock)
		self.assertEqual(self.calls, [])
		lock.release()
		self.assertEqual(self.redeem("7ad3ca", lock=lock)["status"], "reset")
		self.assertFalse(lock.locked(), "released after each redemption")
		self.assertIs(banked.redeem.__kwdefaults__["lock"], banked._LOCK, "production calls share one process-wide lock")


if __name__ == "__main__":
	unittest.main()
