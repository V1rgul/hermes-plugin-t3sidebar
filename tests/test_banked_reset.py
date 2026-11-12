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
			**collector_tests.CollectorTests.symbols(collector_tests.CollectorTests(), self.pool),
			"redeem_codex_reset_credit": redeem,
			"fetch_account_usage": lambda provider, **kwargs: self.calls.append(("fetch", provider, kwargs)),
		}

	def redeem(self, account_id, symbols=None, lock=None):
		with patch.object(limits, "_home_key", return_value="home"), patch.object(limits, "_default_home", return_value="/scratch/home"):
			return banked.redeem(account_id, limits=limits, symbols=symbols or self.symbols(), lock=lock or threading.Lock())

	def test_redeems_with_the_entrys_own_credential_and_makes_only_that_accounts_credits_due(self):
		limits._CREDITS_READ.update({("home", "openai-codex", "7ad3ca"): 1.0, ("home", "openai-codex", "7c202b"): 1.0})
		outcome = self.redeem("7ad3ca")
		# Status and counts only: Hermes's message can carry exception text with URLs or tokens.
		self.assertEqual(outcome, {"status": "reset", "available_count": 1, "windows_reset": 2})
		self.assertEqual(self.calls[0], ("redeem", {"base_url": ROUTE, "api_key": "tok-b", "force": True}))
		# Nothing else is fetched here: the route's next collection reads the account's usage.
		self.assertEqual(len(self.calls), 1)
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


ORG = "11111111-2222-3333-4444-555555555555"


class FakeAnthropic:
	"""Answers the profile read and the reset claim; records every request."""

	def __init__(self, answers, profile=200):
		self.answers, self.profile, self.requests = list(answers), profile, []

	def __call__(self):
		return self

	def __enter__(self):
		return self

	def __exit__(self, *exc):
		return False

	def get(self, url, headers):
		self.requests.append(("GET", url, headers, None))
		return SimpleNamespace(status_code=self.profile, json=lambda: {"organization": {"uuid": ORG}})

	def post(self, url, headers, json):
		self.requests.append(("POST", url, headers, json))
		answer = self.answers.pop(0)
		if isinstance(answer, Exception):
			raise answer
		status, body = answer
		return SimpleNamespace(status_code=status, json=lambda: body)


class AnthropicRedeemTests(unittest.TestCase):
	def setUp(self):
		banked._PENDING_CLAIMS.clear()
		self.addCleanup(banked._PENDING_CLAIMS.clear)
		self.pool = {"anthropic": [{"id": "a00001", "priority": 0, "access_token": "tok-a"}, {"id": "dead01", "priority": 1, "access_token": "tok-d", "last_status": "dead"}]}

	def redeem(self, account_id, grant_id, client, version="2.1.318", lock=None):
		symbols = collector_tests.CollectorTests.symbols(collector_tests.CollectorTests(), self.pool)
		return banked.redeem_anthropic(account_id, grant_id, limits=limits, symbols=symbols, client_factory=client, lock=lock or threading.Lock(), version=version)

	def test_claims_the_named_reset_with_the_accounts_token_as_the_installed_claude_code_cli(self):
		client = FakeAnthropic([(200, {"result": "reset", "resets_left": 0, "cleared": ["seven_day"]})])
		self.assertEqual(self.redeem("a00001", "grant_fable_1", client), {"status": "reset", "resets_left": 0})
		(profile, claim) = client.requests
		self.assertEqual(profile[1], "https://api.anthropic.com/api/oauth/profile")
		self.assertEqual(claim[1], f"https://api.anthropic.com/api/organizations/{ORG}/reset_rate_limits")
		self.assertEqual((claim[2]["Authorization"], claim[2]["User-Agent"], claim[2]["anthropic-beta"]), ("Bearer tok-a", "claude-cli/2.1.318 (external, cli)", "oauth-2025-04-20"))
		self.assertEqual((claim[3]["program"], claim[3]["grant_id"]), ("cedar_ember", "grant_fable_1"))
		self.assertEqual(banked._PENDING_CLAIMS, {}, "a settled claim forgets its request id")

	def test_an_unanswered_claim_is_retried_with_the_same_request_id(self):
		client = FakeAnthropic([OSError("connection reset"), (200, {"result": "unavailable"}), (200, {"result": "already_used", "resets_left": 0})])
		self.assertEqual(self.redeem("a00001", "grant_fable_1", client)["status"], "unknown")
		# Anthropic's own `unavailable` is unconfirmed too.
		self.assertEqual(self.redeem("a00001", "grant_fable_1", client)["status"], "unknown")
		self.assertEqual(self.redeem("a00001", "grant_fable_1", client), {"status": "already_used", "resets_left": 0})
		ids = [request[3]["request_id"] for request in client.requests if request[0] == "POST"]
		self.assertEqual((len(ids), len(set(ids))), (3, 1))
		# Another reset of the same account gets its own id.
		other = FakeAnthropic([(200, {"result": "reset"})])
		self.redeem("a00001", "grant_session", other)
		self.assertNotEqual(other.requests[-1][3]["request_id"], ids[0])

	def test_refusals_are_reported_and_nothing_is_sent_without_a_token_version_or_organization(self):
		for answer, status in (((200, {"result": "not_limited"}), "not_limited"), ((200, {"result": "cooldown"}), "cooldown"), ((200, {"result": "ineligible"}), "ineligible"),
				((429, {}), "rate_limited"), ((401, {}), "signed_out"), ((500, {"error": "boom"}), "unknown")):
			self.assertEqual(self.redeem("a00001", "grant_fable_1", FakeAnthropic([answer]))["status"], status, answer)
			if status != "unknown":
				self.assertEqual(banked._PENDING_CLAIMS, {}, status)
		never = FakeAnthropic([])
		self.assertEqual(self.redeem("a00001", "grant_fable_1", never, version="")["status"], "unavailable")
		self.assertEqual(self.redeem("dead01", "grant_fable_1", never)["status"], "signed_out")
		self.assertEqual(self.redeem("a00001", "grant_fable_1", FakeAnthropic([], profile=403))["status"], "signed_out")
		self.assertEqual([request[0] for request in never.requests], [])
		with self.assertRaises(LookupError):
			self.redeem("nobody", "grant_fable_1", never)
		with self.assertRaises(LookupError):
			self.redeem("a00001", "../grant", never)
		held = threading.Lock()
		held.acquire()
		with self.assertRaises(banked.Busy):
			self.redeem("a00001", "grant_fable_1", never, lock=held)

	def test_claude_code_login_uses_its_own_organization_and_never_refreshes(self):
		import json as jsonlib
		import tempfile
		with tempfile.TemporaryDirectory() as temp:
			Path(temp, ".claude.json").write_text(jsonlib.dumps({"oauthAccount": {"organizationUuid": ORG}}), encoding="utf-8")
			Path(temp, ".credentials.json").write_text(jsonlib.dumps({"claudeAiOauth": {"accessToken": "tok-cc", "expiresAt": 4102444800000}}), encoding="utf-8")
			with patch.dict(limits.os.environ, {"CLAUDE_CONFIG_DIR": temp}):
				client = FakeAnthropic([(200, {"result": "reset"})])
				self.assertEqual(self.redeem("claude-code", "grant_fable_1", client)["status"], "reset")
				self.assertEqual([request[0] for request in client.requests], ["POST"], "the organization comes from Claude Code's own config, no profile read")
				self.assertEqual(client.requests[0][2]["Authorization"], "Bearer tok-cc")
				Path(temp, ".credentials.json").write_text(jsonlib.dumps({"claudeAiOauth": {"accessToken": "tok-cc", "expiresAt": 1000}}), encoding="utf-8")
				never = FakeAnthropic([])
				self.assertEqual(self.redeem("claude-code", "grant_fable_1", never)["status"], "signed_out")
				self.assertEqual(never.requests, [])
