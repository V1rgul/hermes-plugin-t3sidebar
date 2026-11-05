"""Redeem one banked Codex reset credit on one pool account, on the user's explicit request from the Limits page.

Kept apart from ``usage_limits``: the sampler module must never reference a path that spends credits or can refresh tokens, and its policy test enforces that. This module reuses the sampler's read-only pool and route helpers through the shared ``usage_limits`` instance passed in by the caller.
"""

import logging
import threading


LOG = logging.getLogger(__name__)

PROVIDER = "openai-codex"
# Hermes's CodexResetRedeemResult statuses; anything else is reported as unavailable.
STATUSES = frozenset({"reset", "nothing_to_reset", "no_credit", "already_redeemed", "not_exhausted", "no_credits_banked", "unavailable"})
# Outcomes after which the account's allowance and credit list changed upstream.
REDEEMED = frozenset({"reset", "already_redeemed"})
# One redemption at a time per process: each call mints its own idempotency key, so two concurrent clicks would spend two credits.
_LOCK = threading.Lock()


class Busy(RuntimeError):
	"""Another redemption is still running in this process."""


def _native_symbols(limits):
	symbols = dict(limits._native_symbols())
	for name in ("redeem_codex_reset_credit", "fetch_account_usage"):
		try:
			symbols[name] = getattr(__import__("agent.account_usage", fromlist=[name]), name)
		except Exception:
			symbols[name] = None
	return symbols


def _count(value):
	return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 1000 else None


def redeem(account_id, *, limits, symbols=None, lock=_LOCK):
	"""Redeem one credit through Hermes's own `/usage reset --force`, then re-read that account.

	The entry's own token and route are passed explicitly, so Hermes never re-resolves the credential to another pool account. ``force`` skips Hermes's "a window is fully used" guard: the page shows what the reset loses before the user confirms, and Codex itself still refuses (``nothing_to_reset``, credit kept) while every allowance has 80% or more left. Codex picks which credit is spent. Only the status code and counts are returned: Hermes's messages can carry exception text.
	"""
	symbols = symbols if symbols is not None else _native_symbols(limits)
	if any(symbols.get(name) is None for name in ("read_credential_pool", "PooledCredential", "redeem_codex_reset_credit")):
		raise RuntimeError("unavailable")
	pool = symbols["read_credential_pool"]()
	rows = pool.get(PROVIDER) if isinstance(pool, dict) else None
	row = next((row for row in rows or [] if isinstance(row, dict) and str(row.get("id")) == account_id), None)
	if row is None:
		raise LookupError("account_not_found")
	if not lock.acquire(blocking=False):
		raise Busy("redeem_in_progress")
	token = None
	try:
		entry = symbols["PooledCredential"].from_dict(PROVIDER, row)
		dead = symbols.get("STATUS_DEAD")
		token = str(entry.runtime_api_key or "").strip()
		if not token or (dead is not None and getattr(entry, "last_status", None) == dead):
			return {"status": "unavailable", "available_count": None, "windows_reset": 0}
		base_url, _host = limits._route(symbols, PROVIDER, entry)
		result = symbols["redeem_codex_reset_credit"](base_url=base_url, api_key=token, force=True)
		status = getattr(result, "status", None)
		status = status if status in STATUSES else "unavailable"
		outcome = {"status": status, "available_count": _count(getattr(result, "available_count", None)), "windows_reset": _count(getattr(result, "windows_reset", None)) or 0}
		if status in REDEEMED:
			_reread(symbols, limits, entry, account_id, base_url, token)
		return outcome
	finally:
		token = None
		lock.release()


def _reread(symbols, limits, entry, account_id, base_url, token):
	"""Let the next collection show the redeemed account: its credit list is due again, and its usage is fetched now rather than after Hermes's two-minute refresh throttle (one read-only GET through Hermes's per-credential fetcher, which lands in the shared cache the sampler reads)."""
	limits.forget_credit_read(PROVIDER, account_id)
	fetch, identity = symbols.get("fetch_account_usage"), symbols.get("_identity_id_for")
	if fetch is None or identity is None:
		return
	try:
		fetch(PROVIDER, base_url=base_url, api_key=token, read_only=True, identity_id=identity(PROVIDER, entry))
	except Exception as exc:
		LOG.debug("t3sidebar redeemed account re-read failed: %s", type(exc).__name__)
