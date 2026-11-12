"""Banked credits that have already expired cannot use up the bound on the kept credit list: scratch SQLite, fake responses, no network or live auth."""

import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from test_backend import backend
from test_limits_housekeeping import sampled


limits = backend.usage_limits
NOW = 1800000000.0
EXPIRED = {"status": "available", "expires_at": NOW - 1}
LIVE = {"status": "available", "expires_at": NOW + 86400}


class ExpiredCreditCap(unittest.TestCase):
	def test_expired_credits_do_not_crowd_out_a_live_one(self):
		credits = limits.normalize_credits({"credits": [EXPIRED] * limits.MAX_CREDITS + [LIVE]}, NOW)
		self.assertEqual([credit["expires_at"] for credit in credits], [NOW + 86400])
		block = limits._credits_block((NOW, json.dumps(credits), 1), NOW)
		self.assertEqual([credit["expires_at"] for credit in block["credits"]], [NOW + 86400])

	def test_only_a_known_past_expiry_drops_a_credit(self):
		listed = [{"status": "available", "expires_at": NOW}, {"status": "available", "expires_at": None}, {"status": "available", "expires_at": "not a date"}, LIVE]
		credits = limits.normalize_credits({"credits": listed}, NOW)
		# Expiring at the collection instant is already gone, as on the page; an unknown expiry is kept.
		self.assertEqual([credit["expires_at"] for credit in credits], [None, None, NOW + 86400])

	def test_the_store_bounds_what_is_still_live_when_it_records(self):
		with tempfile.TemporaryDirectory(prefix="t3-credit-expiry-") as temp:
			store = limits.LimitsStore(Path(temp) / "limits.sqlite3")
			listed = [EXPIRED] * limits.MAX_CREDITS + [LIVE]
			store.record([{"provider": "openai-codex", "error": None, "credits_mode": "current", "current_credits": listed, "accounts": [sampled("pooled", NOW, credits=listed)]}], checked_at=NOW)
			(provider,) = limits.limits_payload(store, hours=24, now=NOW)["providers"]
			self.assertEqual([credit["expires_at"] for credit in provider["current_banked_credits"]["credits"]], [NOW + 86400])
			self.assertEqual([credit["expires_at"] for credit in provider["accounts"][0]["banked_credits"]["credits"]], [NOW + 86400])

	def test_a_fetched_list_drops_what_has_expired_before_bounding_it(self):
		import hermes_cli.plugin_provider_requests as requests
		body = {"credits": [{"status": "available", "expires_at": "2020-01-01T00:00:00Z"}] * limits.MAX_CREDITS + [{"status": "available", "expires_at": "2099-01-01T00:00:00Z"}]}
		with patch.object(requests, "credentialed_provider_request", lambda *args, **kwargs: SimpleNamespace(status=200, json=lambda: body)):
			credits = limits._fetch_current_codex_credits()
		self.assertEqual([credit["expires_at"] for credit in credits], [4070908800.0])


if __name__ == "__main__":
	unittest.main()
