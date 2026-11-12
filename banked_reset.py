"""Redeem one banked Codex reset credit, or use one Anthropic limit reset, on one account, on the user's explicit request from the Limits page.

Kept apart from ``usage_limits``: the sampler module must never reference a path that spends credits, and reaches a token refresh only through the two exceptions its own docstring documents (an expired Claude Code login handed to Hermes's refresh, and the current account's credit list read through Hermes's credentialed request); its policy test enforces the rest. This module reuses the sampler's read-only pool and route helpers through the shared ``usage_limits`` instance passed in by the caller.
"""

import json
import re
import threading
import uuid


PROVIDER = "openai-codex"
# Hermes's CodexResetRedeemResult statuses; anything else is reported as unavailable.
STATUSES = frozenset({"reset", "nothing_to_reset", "no_credit", "already_redeemed", "not_exhausted", "no_credits_banked", "unavailable"})
# Outcomes after which the account's allowance and credit list changed upstream.
REDEEMED = frozenset({"reset", "already_redeemed"})
# One redemption at a time per process: each call mints its own idempotency key, so two concurrent clicks would spend two credits.
_LOCK = threading.Lock()


ANTHROPIC = "anthropic"
ANTHROPIC_API = "https://api.anthropic.com"
ANTHROPIC_PROGRAM = "cedar_ember"
# Anthropic's claim outcomes, as Claude Code and T3 Code read them; `unknown` is the plugin's own: the claim may have gone through.
ANTHROPIC_STATUSES = frozenset({"reset", "already_used", "not_limited", "cooldown", "ineligible", "rate_limited", "signed_out", "unavailable", "unknown"})
# Outcomes after which the account's allowance and reset list changed upstream (`already_used`: an earlier unanswered claim with the same request id went through).
ANTHROPIC_REDEEMED = frozenset({"reset", "already_used"})
_UUID_PATTERN = re.compile(r"^[0-9a-fA-F-]{36}$")
_TIMEOUT_S = 25.0
# Request ids of claims whose outcome never arrived, per (account, grant): the next attempt on that grant reuses its id, so Anthropic answers `already_used` instead of spending a second reset. Process memory only; a claim that went through also shows on the next read.
_PENDING_CLAIMS = {}


class Busy(RuntimeError):
	"""Another redemption is still running in this process."""


def _native_symbols(limits):
	symbols = dict(limits._native_symbols())
	try:
		symbols["redeem_codex_reset_credit"] = getattr(__import__("agent.account_usage", fromlist=["redeem_codex_reset_credit"]), "redeem_codex_reset_credit")
	except Exception:
		symbols["redeem_codex_reset_credit"] = None
	return symbols


def _count(value):
	return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 1000 else None


def redeem(account_id, *, limits, symbols=None, lock=_LOCK):
	"""Redeem one credit through Hermes's own `/usage reset --force`; after a redemption the account's credit list is due again, and the caller's next collection reads its usage.

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
			limits.forget_credit_read(PROVIDER, account_id)
		return outcome
	finally:
		token = None
		lock.release()



def _anthropic_login(account_id, limits, symbols):
	"""(token, organization uuid or None) of one Anthropic account: Claude Code's login for its fallback account, else that Hermes pool entry; None when it has no usable token."""
	if account_id == limits.CLAUDE_CODE_ACCOUNT_ID:
		login = limits._claude_code_login()
		if login is None:
			raise LookupError("account_not_found")
		if login["expired"]:
			return None
		return login["token"], _claude_organization()
	if any(symbols.get(name) is None for name in ("read_credential_pool", "PooledCredential")):
		raise RuntimeError("unavailable")
	pool = symbols["read_credential_pool"]()
	rows = pool.get(ANTHROPIC) if isinstance(pool, dict) else None
	row = next((row for row in rows or [] if isinstance(row, dict) and str(row.get("id")) == account_id), None)
	if row is None:
		raise LookupError("account_not_found")
	entry = symbols["PooledCredential"].from_dict(ANTHROPIC, row)
	dead = symbols.get("STATUS_DEAD")
	token = str(entry.runtime_api_key or "").strip()
	return (token, None) if token and not (dead is not None and getattr(entry, "last_status", None) == dead) else None


def _claude_organization():
	"""The organization of Claude Code's login, from its own ``.claude.json`` (honouring CLAUDE_CONFIG_DIR like the CLI), or None."""
	import os
	from pathlib import Path
	config = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
	path = Path(config).expanduser() / ".claude.json" if config else Path.home() / ".claude.json"
	try:
		value = json.loads(path.read_text(encoding="utf-8-sig")).get("oauthAccount", {}).get("organizationUuid")
	except (OSError, ValueError, AttributeError):
		return None
	return value.strip() if isinstance(value, str) and _UUID_PATTERN.fullmatch(value.strip()) else None


def _profile_organization(client, headers):
	"""The token's organization from Anthropic's OAuth profile, or None."""
	try:
		response = client.get(f"{ANTHROPIC_API}/api/oauth/profile", headers=headers)
		value = response.json().get("organization", {}).get("uuid") if response.status_code == 200 else None
	except Exception:
		return None
	return value if isinstance(value, str) and _UUID_PATTERN.fullmatch(value) else None


def redeem_anthropic(account_id, grant_id, *, limits, symbols=None, client_factory=None, lock=_LOCK, version=None):
	"""Use one Anthropic limit reset (``grant_id``, as listed by /usage/limits) on one account, as Claude Code's ``/limit-reset`` does: one POST to ``reset_rate_limits`` with the account's own token, named as the installed Claude Code CLI.

	Never refreshes a token: an expired Claude Code login answers ``signed_out``. A claim whose answer never arrived keeps its request id for the next attempt on that grant. Only the outcome and the resets left are returned.
	"""
	if not isinstance(grant_id, str) or not limits._GRANT_ID_PATTERN.fullmatch(grant_id):
		raise LookupError("grant_not_found")
	symbols = symbols if symbols is not None else limits._native_symbols()
	login = _anthropic_login(account_id, limits, symbols)
	version = version if version is not None else limits.claude_cli_version()
	if login is None:
		return {"status": "signed_out", "resets_left": None}
	if not version:
		# Anthropic only answers Claude Code for resets; without an installed CLI there is no version to name.
		return {"status": "unavailable", "resets_left": None}
	if not lock.acquire(blocking=False):
		raise Busy("redeem_in_progress")
	token, organization = login
	key = (account_id, grant_id)
	try:
		import httpx
		headers = limits.claude_headers(token, version)
		with (client_factory or (lambda: httpx.Client(timeout=_TIMEOUT_S, follow_redirects=False)))() as client:
			# The profile read needs no Claude Code CLI identity, so it is named as Hermes's own Anthropic reads are; only the claim names the CLI.
			organization = organization or _profile_organization(client, limits.hermes_headers(token))
			if organization is None:
				return {"status": "signed_out", "resets_left": None}
			request_id = _PENDING_CLAIMS.setdefault(key, str(uuid.uuid4()))
			try:
				response = client.post(f"{ANTHROPIC_API}/api/organizations/{organization}/reset_rate_limits",
					headers={**headers, "Content-Type": "application/json"}, json={"program": ANTHROPIC_PROGRAM, "grant_id": grant_id, "request_id": request_id})
			except Exception:
				return {"status": "unknown", "resets_left": None}
			if response.status_code in (401, 403, 429):
				_PENDING_CLAIMS.pop(key, None)
				return {"status": "rate_limited" if response.status_code == 429 else "signed_out", "resets_left": None}
			try:
				body = response.json() if response.status_code == 200 else None
			except Exception:
				body = None
			result = body.get("result") if isinstance(body, dict) else None
			# Anthropic's own `unavailable` is an unconfirmed claim too: Claude Code and T3 Code retry it with the same request id.
			if result not in ANTHROPIC_STATUSES or result in ("unavailable", "unknown"):
				return {"status": "unknown", "resets_left": None}
			_PENDING_CLAIMS.pop(key, None)
			left = body.get("resets_left")
			return {"status": result, "resets_left": _count(left)}
	finally:
		token = None
		login = None
		lock.release()
