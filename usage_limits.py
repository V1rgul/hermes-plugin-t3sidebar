"""Provider limit history for the Usage page: a background sampler plus a plugin-owned SQLite store.

Hermes keeps provider limit snapshots only in process memory and only fetches them on demand, so the page would have no history while Desktop is closed. A sampler therefore reads every account every few minutes, Codex through Hermes's public per-credential fetch and Anthropic with one read of its own, and records the readings.

Read-only toward credentials, by construction, except that an expired Claude Code login is handed to Hermes's own refresh (below):
- Pool rows come from ``read_credential_pool`` (a plain auth.json read), never ``load_pool`` (which can seed, heal and persist the store) or ``pool.select()``.
- Each Codex account is read by Hermes's public ``fetch_account_usage(read_only=True)`` with that entry's own token and an ``identity_id``, one thread per account, exactly as Hermes's model picker reads its pool: the Codex read-only fetcher reports a 401 instead of refreshing or rotating, the Anthropic fetcher with an explicit token never resolves or refreshes one, and a reading with an ``identity_id`` lands only in that account's slot of Hermes's cache, never in its single-account gauge. The provider-wide ``refresh_account_usage_async`` is deliberately not used because its Codex path resolves runtime credentials with ``refresh_if_expiring`` and force-refreshes on 401.
- Only providers in ``VETTED_PROVIDERS`` are refreshed: plugin usage hooks are arbitrary code and OpenRouter issues two GETs.
- Each Anthropic account (pool entry or Claude Code login) is read with one GET of its own: Anthropic's usage URL with ``cedar_ember=1``, whose body carries the 5-hour and weekly windows Hermes maps, the model-scoped limits of its ``limits`` list (a weekly cap on one model, such as Fable) and the account's limit resets (the ``cedar_ember`` block), none of which Hermes passes on. Reading through Hermes as well sent the same GET twice. The token goes only to ``api.anthropic.com`` and only when it is OAuth-shaped, Hermes's own rule for that endpoint; it is never refreshed or stored, and the body is dropped once read. The reading no longer lands in Hermes's in-memory Anthropic gauge, which Hermes's own reads (model picker, ``/usage``) keep. Anthropic lists resets only to Claude Code, so this read names itself as the Claude Code CLI installed on the host (``claude-cli/<version> (external, cli)``, as T3 Code does); without an installed CLI it goes out as Hermes's own usage fetch does (``claude-code/2.1.0``) and the resets read as none. Every other Anthropic request names itself ``claude-code/2.1.0`` too, never httpx.
- Anthropic falls back to Claude Code's own login when Hermes's anthropic pool is empty: Claude sessions that run through the Claude Code CLI (claude-subscription-directsdk) consume that login's account, not a Hermes pool entry. Its plan comes from Anthropic's OAuth profile, read at the sampler's first collection and then hourly (every ``PLAN_RETRY_S`` after a failure, keeping the last plan). An expired token is refreshed by calling ``fetch_account_usage("anthropic")`` without a token, which resolves one through Hermes's Claude Code resolver and writes the new pair back to Claude Code's credentials, then read again.
- Codex banked reset credit expiries (the usage payload only carries their count) are read at most every ``CREDITS_INTERVAL_S``. Every pool account's list is read with its own token through Hermes's private Codex helpers (its URL and headers, so the request is named as Hermes names its Codex reads); a 401 or any failure keeps the previous list and never refreshes the token. Without those helpers no list is read, and the page shows only each account's banked reset count.

Nothing secret is stored or logged: tokens, identities and base URLs stay in local variables of one collection; the store keeps pool entry id + label, plan, window numbers, banked reset count, banked credit status/grant/expiry times, Anthropic limit resets (Anthropic's reset id, kind, count, expiry, usability and the limit names they clear) and a closed set of error classes.
"""

from contextlib import closing, contextmanager
import contextvars
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import re
import sqlite3
import threading
import time


LOG = logging.getLogger(__name__)

DEFAULT_INTERVAL_S = 300
FIRST_TICK_DELAY_S = 5.0
JOIN_TIMEOUT_S = 30.0
# Matches Hermes's own SNAPSHOT_STALE_AFTER_S so the page and the model picker agree on "live".
STALE_AFTER_S = 15 * 60.0
RETENTION_S = 35 * 86400.0
MAX_HOURS = 840
# Banked credits change rarely (granted weekly at most, expiring after a month), so their list is read far less often than the windows.
CREDITS_INTERVAL_S = 3600.0
CREDITS_TIMEOUT_S = 10.0
MAX_CREDITS = 50

# Built-in fetchers verified to issue at most one GET with the entry's own token and to never refresh, rotate or persist credentials when called through the per-entry read-only path.
VETTED_PROVIDERS = ("openai-codex", "anthropic")
PROVIDER_LABELS = {"openai-codex": "OpenAI Codex", "anthropic": "Anthropic"}

# Closed vocabulary so an error string can never carry a message, URL or token.
ERROR_CLASSES = frozenset({
	"unavailable", "pool_unreadable", "credential_dead", "no_credential", "no_data",
	"refresh_failed", "timeout", "internal_error", "logged_out", "token_expired",
})
CLAUDE_CODE_ACCOUNT_ID = "claude-code"
# A per-account fetch still running when the collection stops waiting.
TIMEOUT = object()

_SECONDS_KEYS = {18000: "five_hour", 604800: "weekly"}
_LABEL_KEYS = {
	"session": "five_hour", "current session": "five_hour", "5h": "five_hour", "5 hour": "five_hour", "five hour": "five_hour",
	"weekly": "weekly", "week": "weekly", "current week": "weekly", "7d": "weekly", "7 day": "weekly", "seven day": "weekly",
}
# Words that name a window's period rather than its model, stripped when deriving a model-scoped window's model.
_PERIOD_WORDS = {"current", "session", "week", "weekly", "5h", "7d", "limit", "window", "usage"}
_CODEX_LABEL_BY_SECONDS = {18000: "Session", 604800: "Weekly"}
# Anthropic's usage endpoint names its windows (five_hour, seven_day, seven_day_opus...) without a duration, and Hermes passes on only their labels; the names are the durations, so its five_hour and weekly keys (model-scoped ones included) get them back.
_ANTHROPIC_SECONDS_BY_KEY = {key: seconds for seconds, key in _SECONDS_KEYS.items()}
# The URL Hermes's Anthropic fetcher reads; its ``limits`` list is the only place model-scoped caps such as Fable's weekly appear.
ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
# The same body with the account's limit resets added, as Claude Code asks for it; skip_spend leaves out the spend block nothing here reads.
ANTHROPIC_RESETS_URL = ANTHROPIC_USAGE_URL + "?cedar_ember=1&skip_spend=1"
ANTHROPIC_HEADERS = {"Accept": "application/json", "anthropic-beta": "oauth-2025-04-20"}
# Every Anthropic request names a Claude Code client, never httpx: by default the identity Hermes's own Anthropic usage fetch sends, so the sampler's reads look like Hermes's; only resets, which Anthropic lists and accepts for the Claude Code CLI alone, name the installed CLI.
HERMES_ANTHROPIC_USER_AGENT = "claude-code/2.1.0"
# Anthropic offers resets only to Claude Code, which it recognises by this User-Agent; the version is the installed CLI's, read from `claude --version`.
CLAUDE_VERSION_TTL_S = 6 * 3600.0
_CLAUDE_VERSION = {"checked": float("-inf"), "version": None}
_CLAUDE_VERSION_LOCK = threading.Lock()
# Reset kinds as Claude Code groups its grants: one that gives back weekly usage is a Fable reset, else its declared type, else what it clears.
RESET_KINDS = ("session", "weekly", "fable", "full")
_GRANT_ID_PATTERN = re.compile(r"^[a-z0-9_-]{1,40}$")
_SLUG_PATTERN = re.compile(r"^[a-z0-9_]{1,40}$")
MAX_GRANTS = 16
# The windows Hermes maps from Anthropic's usage body, with Hermes's labels so their keys stay those of samples recorded through Hermes.
ANTHROPIC_FIXED_WINDOWS = (("five_hour", "Current session", "account"), ("seven_day", "Current week", "account"), ("seven_day_opus", "Opus week", "model"), ("seven_day_sonnet", "Sonnet week", "model"))
# The plan changes rarely, so Anthropic's profile is read at the first collection, then hourly; a failed read is retried sooner and keeps the last plan.
PLAN_INTERVAL_S = 3600.0
PLAN_RETRY_S = 900.0
_PLAN_LOCK = threading.Lock()
_PLAN_READ = {}
_BLOCKED_REASONS = {"five_hour": "blocked_five_hour", "seven_day": "blocked_seven_day", "seven_day_opus": "blocked_opus", "seven_day_sonnet": "blocked_sonnet"}
# A ``limits`` entry's group names its period; the period word makes ``window_key`` give the same key Hermes's own labels would.
_ANTHROPIC_GROUP_PERIODS = {"weekly": "week", "session": "session"}
MAX_SCOPED_LIMITS = 16
_ACCOUNT_ID_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
_EXCEPTION_NAME_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")


def _finite(value):
	if isinstance(value, bool) or not isinstance(value, (int, float)):
		return None
	value = float(value)
	return value if math.isfinite(value) else None


def _positive_int(value):
	number = _finite(value)
	if number is None or number <= 0 or number != int(number):
		return None
	return int(number)


def _slug(text):
	return re.sub(r"[^a-z0-9]+", "_", str(text or "").lower()).strip("_")[:48]


def _safe_error(value):
	return value if value in ERROR_CLASSES else ("internal_error" if value else None)


def _safe_label(label, account_id):
	# Hermes may default a pool label to the token's email claim; never let that reach disk or the wire.
	text = str(label or "").strip()
	if not text or "@" in text or len(text) > 64:
		return f"account {account_id}"
	return text


def window_key(label, window_seconds=None, scope="account"):
	"""Stable (key, model) for one window: duration first, then known labels, model-scoped windows get ``<base>:<model>``."""
	seconds = _positive_int(window_seconds)
	words = " ".join(re.findall(r"[a-z0-9]+", str(label or "").lower()))
	if seconds is not None:
		base = _SECONDS_KEYS.get(seconds, f"w{seconds}")
	elif words in _LABEL_KEYS:
		base = _LABEL_KEYS[words]
	elif scope == "model":
		tokens = set(words.split())
		base = "weekly" if tokens & {"week", "weekly", "7d"} else "five_hour" if tokens & {"session", "5h"} else "window"
	else:
		base = _slug(label) or "window"
	if scope != "model":
		return base, None
	model = _slug(" ".join(word for word in words.split() if word not in _PERIOD_WORDS)) or None
	return (f"{base}:{model}", model) if model else (base, None)


def window_seconds(provider, key, seconds):
	"""A window's duration: the reported one, else Anthropic's implied by its key, else None."""
	seconds = _positive_int(seconds)
	if seconds is None and provider == "anthropic" and isinstance(key, str):
		return _ANTHROPIC_SECONDS_BY_KEY.get(key.split(":", 1)[0])
	return seconds


def _codex_window_seconds(raw, windows):
	"""Durations of a Codex snapshot's windows, read from the numeric ``limit_window_seconds`` only.

	Hermes builds windows from ``primary_window``/``secondary_window`` in that order, skipping ones without ``used_percent``; replaying the same walk pairs each duration with its window. Any disagreement with Hermes's own labels voids the pairing rather than guessing.
	"""
	rate_limit = raw.get("rate_limit") if isinstance(raw, dict) else None
	if not isinstance(rate_limit, dict):
		return [None] * len(windows)
	seconds = []
	for key in ("primary_window", "secondary_window"):
		window = rate_limit.get(key)
		if not isinstance(window, dict) or window.get("used_percent") is None:
			continue
		seconds.append(_positive_int(window.get("limit_window_seconds")))
	if len(seconds) != len(windows):
		return [None] * len(windows)
	for value, window in zip(seconds, windows):
		expected = _CODEX_LABEL_BY_SECONDS.get(value)
		if expected is not None and getattr(window, "label", None) != expected:
			return [None] * len(windows)
	return seconds


def _banked_resets(provider, raw):
	"""How many banked credits the account holds, read from the Codex usage payload Hermes already fetched (``rate_limit_reset_credits.available_count``); 0 when the block is there without a usable count, as Hermes counts it."""
	if provider != "openai-codex" or not isinstance(raw, dict) or "rate_limit_reset_credits" not in raw:
		return None
	block = raw.get("rate_limit_reset_credits")
	value = block.get("available_count") if isinstance(block, dict) else None
	if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or not 0 <= value <= 1000:
		return 0
	return int(value)


def _banked_applicable(provider, raw):
	"""How many banked credits Codex would let the account redeem right now (0 while its limits are not reached)."""
	if provider != "openai-codex" or not isinstance(raw, dict):
		return None
	block = raw.get("rate_limit_reset_credits")
	value = block.get("applicable_available_count") if isinstance(block, dict) else None
	# Zero is meaningful here (credits exist but cannot be redeemed yet), so this is not _positive_int.
	return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 1000 else None


def _iso_epoch(value):
	"""Epoch seconds from Codex's ISO-8601 times, or from an already-normalized epoch."""
	if isinstance(value, (int, float)) and not isinstance(value, bool):
		return _finite(value)
	if not isinstance(value, str) or len(value) > 64:
		return None
	try:
		from datetime import datetime
		parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
	except ValueError:
		return None
	return _finite(parsed.timestamp()) if parsed.tzinfo is not None else None


def normalize_credits(payload, now=None):
	"""Secret-free list of the still available credits in Codex's ``rate-limit-reset-credits`` body: status, grant and expiry only, or None when the body is not a credit list.

	Only available, unexpired credits are ever shown, so redeemed or malformed entries, and with a collection time ``now`` those whose known expiry has passed, are dropped before ``MAX_CREDITS`` bounds the list; a long history cannot crowd out the credits after it. A credit without a known expiry is kept.
	"""
	if not isinstance(payload, dict) or not isinstance(payload.get("credits"), list):
		return None
	credits = []
	for credit in payload["credits"]:
		if not isinstance(credit, dict) or credit.get("status") != "available":
			continue
		expires_at = _iso_epoch(credit.get("expires_at"))
		if now is not None and expires_at is not None and expires_at <= now:
			continue
		credits.append({"status": "available", "granted_at": _iso_epoch(credit.get("granted_at")), "expires_at": expires_at})
		if len(credits) == MAX_CREDITS:
			break
	return credits


def pool_credits_available(symbols=None):
	"""Whether this Hermes still has the private Codex helpers the per-account credit lists need; without them no list is read."""
	symbols = _native_symbols() if symbols is None else symbols
	return symbols.get("_codex_backend_urls") is not None and symbols.get("_codex_headers") is not None


def _fetch_codex_credits(symbols, base_url, token):
	"""One read-only GET of the account's credit list with its own token; None on any failure (a 401 is not retried or refreshed)."""
	urls, headers = symbols.get("_codex_backend_urls"), symbols.get("_codex_headers")
	if urls is None or headers is None:
		return None
	import httpx
	try:
		with httpx.Client(timeout=CREDITS_TIMEOUT_S, follow_redirects=False) as client:
			response = client.get(urls(base_url or "")[1], headers=headers(token, None))
		if response.status_code != 200:
			return None
		return normalize_credits(response.json(), time.time())
	except Exception:
		return None


def _timestamp(value):
	try:
		return _finite(value.timestamp()) if value is not None else None
	except (AttributeError, TypeError, ValueError, OSError, OverflowError):
		return None


def normalize_snapshot(provider, snapshot):
	"""Plain, secret-free dict from a Hermes ``AccountUsageSnapshot`` (identity and raw payload dropped here)."""
	if snapshot is None:
		return None
	fetched_at = _timestamp(getattr(snapshot, "fetched_at", None))
	if fetched_at is None:
		return None
	windows = tuple(getattr(snapshot, "windows", None) or ())
	raw = getattr(snapshot, "raw", None)
	seconds = _codex_window_seconds(raw, windows) if provider == "openai-codex" else [None] * len(windows)
	# Hermes title-cases Codex's plan_type ("Prolite"), which loses the enum the frontend maps to plan labels and pool capacity weights; prefer the raw value when the payload carries it.
	plan = raw.get("plan_type") if provider == "openai-codex" and isinstance(raw, dict) and isinstance(raw.get("plan_type"), str) else getattr(snapshot, "plan", None)
	plan = plan.strip()[:64] if isinstance(plan, str) and plan.strip() and "@" not in plan else None
	result_windows = []
	used_keys = set()
	for window, duration in zip(windows, seconds):
		label = str(getattr(window, "label", "") or "")[:64]
		scope = "model" if getattr(window, "scope", "account") == "model" else "account"
		key, model = window_key(label, duration, scope)
		unique, suffix = key, 2
		while unique in used_keys:
			unique, suffix = f"{key}_{suffix}", suffix + 1
		used_keys.add(unique)
		result_windows.append({
			"key": unique, "label": label or None, "window_seconds": window_seconds(provider, unique, duration), "scope": scope, "model": model,
			"used_percent": _finite(getattr(window, "used_percent", None)),
			"resets_at": _timestamp(getattr(window, "reset_at", None)),
		})
	return {"fetched_at": fetched_at, "plan": plan, "banked_resets": _banked_resets(provider, raw), "banked_applicable": _banked_applicable(provider, raw), "windows": result_windows}


def anthropic_scoped_windows(payload):
	"""Model-scoped windows (such as Fable's weekly) from the ``limits`` list of Anthropic's usage body, shaped like ``normalize_snapshot``'s; None when the body has no such list.

	Account-wide entries (no model in their ``scope``) are skipped: Hermes already reports them from the body's fixed keys.
	"""
	if not isinstance(payload, dict) or not isinstance(payload.get("limits"), list):
		return None
	windows = []
	for entry in payload["limits"][:MAX_SCOPED_LIMITS]:
		if not isinstance(entry, dict):
			continue
		scope = entry.get("scope")
		model = scope.get("model") if isinstance(scope, dict) else None
		name = (model.get("display_name") or model.get("id")) if isinstance(model, dict) else None
		group = entry.get("group")
		period = _ANTHROPIC_GROUP_PERIODS.get(group) if isinstance(group, str) else None
		if not isinstance(name, str) or not name.strip() or "@" in name or period is None:
			continue
		label = f"{name.strip()[:48]} {period}"
		key, slug = window_key(label, None, "model")
		if slug is None:
			continue
		windows.append({
			"key": key, "label": label, "window_seconds": window_seconds("anthropic", key, None), "scope": "model", "model": slug,
			"used_percent": _finite(entry.get("percent")), "resets_at": _iso_epoch(entry.get("resets_at")),
		})
	return windows


def _reset_kind(grant):
	if grant.get("gives_back_weekly") is True:
		return "fable"
	if grant.get("type") in ("session", "weekly", "full"):
		return grant["type"]
	clears = grant.get("clears") if isinstance(grant.get("clears"), list) else []
	session = "five_hour" in clears
	other = any(limit != "five_hour" for limit in clears)
	return "session" if session and not other else "weekly" if other and not session else "full"


def anthropic_reset_grants(payload):
	"""The account's limit resets from the ``cedar_ember`` block of Anthropic's usage body, or None when the body has no such block (asked without it, or a failed read).

	An ineligible account has none. Paused grants and ones with nothing left are dropped; one that cannot be used now (most need a limit reached first) is kept with ``usable`` false and Anthropic's reason. ``weekly_share_used`` is how much of the weekly limit model-scoped usage took, which a Fable reset gives back.
	"""
	block = payload.get("cedar_ember") if isinstance(payload, dict) else None
	if not isinstance(block, dict):
		return None
	shares = payload.get("weekly_scoped_shares")
	used = [share.get("used_percent_of_weekly") for share in shares[:MAX_SCOPED_LIMITS] if isinstance(share, dict)] if isinstance(shares, list) else []
	used = [_finite(value) for value in used if _finite(value) is not None and 0 <= value <= 100]
	result = {"grants": [], "weekly_share_used": min(100.0, sum(used)) if used else None}
	if block.get("eligible") is not True:
		return result
	cooling = isinstance(block.get("cooldown_until"), str) and bool(block["cooldown_until"])
	for grant in (block.get("grants") if isinstance(block.get("grants"), list) else [])[:MAX_GRANTS]:
		if not isinstance(grant, dict) or not isinstance(grant.get("id"), str) or not _GRANT_ID_PATTERN.fullmatch(grant["id"]):
			continue
		left = grant.get("resets_left")
		if grant.get("paused") is True or not isinstance(left, int) or isinstance(left, bool) or not 0 < left <= 1000:
			continue
		clears = [limit for limit in grant.get("clears") or [] if isinstance(limit, str) and _SLUG_PATTERN.fullmatch(limit)][:8] if isinstance(grant.get("clears"), list) else []
		reason = grant.get("unavailable_reason") if grant.get("usable_now") is not True else None
		if grant.get("usable_now") is not True and not isinstance(reason, str):
			# Claude Code's own fallback when Anthropic names no reason: a cooldown, then a limit that blocks this reset, then whether it needs a limit reached first.
			blocking = [limit for limit in grant.get("blocking") or [] if isinstance(limit, str)] if isinstance(grant.get("blocking"), list) else []
			reason = "cooldown" if cooling else _BLOCKED_REASONS.get(blocking[0], "blocked_other") if blocking else "needs_limit" if grant.get("use_requires_limit") is not False else "unavailable"
		result["grants"].append({
			"id": grant["id"], "kind": _reset_kind(grant), "resets_left": left, "ends_at": _iso_epoch(grant.get("ends_at")),
			"usable": grant.get("usable_now") is True, "reason": reason if isinstance(reason, str) and _SLUG_PATTERN.fullmatch(reason) else None, "clears": clears,
		})
	return result


def claude_cli_version(clock=time.monotonic, runner=None):
	"""The installed Claude Code CLI's version (``2.1.318``), from ``claude --version`` at most every six hours; None without a CLI."""
	with _CLAUDE_VERSION_LOCK:
		if clock() - _CLAUDE_VERSION["checked"] < CLAUDE_VERSION_TTL_S:
			return _CLAUDE_VERSION["version"]
		_CLAUDE_VERSION["checked"] = clock()
		version = None
		try:
			if runner is None:
				import shutil
				import subprocess
				path = shutil.which("claude")
				output = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=10, stdin=subprocess.DEVNULL).stdout if path else ""
			else:
				output = runner()
			match = re.match(r"\s*(\d{1,4}\.\d{1,4}\.\d{1,6})\b", output or "")
			version = match.group(1) if match else None
		except Exception:
			version = None
		_CLAUDE_VERSION["version"] = version
		return version


def hermes_headers(token):
	"""Headers of an Anthropic OAuth request named as Hermes names its own usage fetch."""
	return {"Authorization": f"Bearer {token}", **ANTHROPIC_HEADERS, "User-Agent": HERMES_ANTHROPIC_USER_AGENT}


def claude_headers(token, version=None):
	"""Headers of an Anthropic OAuth request that names itself as the installed Claude Code CLI, which resets need; without a CLI, as Hermes does (resets are then not listed)."""
	version = claude_cli_version() if version is None else version
	return {**hermes_headers(token), **({"User-Agent": f"claude-cli/{version} (external, cli)"} if version else {})}


def _fetch_anthropic_usage(token):
	"""Anthropic's usage body with the account's resets, read with its token; None on any failure (a 401 is not retried or refreshed)."""
	import httpx
	try:
		with httpx.Client(timeout=CREDITS_TIMEOUT_S, follow_redirects=False) as client:
			response = client.get(ANTHROPIC_RESETS_URL, headers=claude_headers(token))
		return response.json() if response.status_code == 200 else None
	except Exception:
		return None


def _is_oauth_token(token):
	"""Hermes's rule for what may go to Anthropic's OAuth usage endpoint: OAuth and setup tokens, never Console API keys (``agent.anthropic_credentials._is_oauth_token``)."""
	if not token or token.startswith(("sk-ant-api", "sk-ant-usr", "sk-ant-svc", "sk-ant-admin")):
		return False
	return token.startswith(("sk-ant-", "eyJ", "cc-"))


def anthropic_snapshot(payload, fetched_at):
	"""A normalized snapshot from Anthropic's usage body: the windows Hermes maps (utilization is already a percentage), then the model-scoped limits not already among them, then the resets; None when the body is not a usage body."""
	if not isinstance(payload, dict):
		return None
	windows = []
	for name, label, scope in ANTHROPIC_FIXED_WINDOWS:
		block = payload.get(name)
		used = _finite(block.get("utilization")) if isinstance(block, dict) else None
		if used is None:
			continue
		key, model = window_key(label, None, scope)
		windows.append({"key": key, "label": label, "window_seconds": window_seconds("anthropic", key, None), "scope": scope, "model": model,
			"used_percent": used, "resets_at": _iso_epoch(block.get("resets_at"))})
	keys = {window["key"] for window in windows}
	for window in anthropic_scoped_windows(payload) or ():
		if window["key"] not in keys:
			keys.add(window["key"])
			windows.append(window)
	return {"fetched_at": _finite(fetched_at), "plan": None, "banked_resets": None, "banked_applicable": None, "windows": windows, "reset_grants": anthropic_reset_grants(payload)}


def _read_anthropic(token, fetcher, clock):
	"""One Anthropic account's snapshot from its own usage read; a snapshot without windows for a token that must not go to the OAuth endpoint (as Hermes reports it), None when the read failed."""
	if not _is_oauth_token(token):
		return {"fetched_at": _finite(clock()), "plan": None, "banked_resets": None, "banked_applicable": None, "windows": [], "reset_grants": None}
	return anthropic_snapshot(fetcher(token), clock())


def _cached_plan(account_id, token, fetcher, clock):
	"""The account's plan from Anthropic's profile, read at the first collection of this process and then every ``PLAN_INTERVAL_S``, or ``PLAN_RETRY_S`` after a failure (which keeps the last plan)."""
	try:
		key = (_home_key(_default_home()), account_id)
	except Exception:
		key = ("", account_id)
	now = float(clock())
	with _PLAN_LOCK:
		checked, plan, ok = _PLAN_READ.get(key, (None, None, False))
		if checked is not None and 0 <= now - checked < (PLAN_INTERVAL_S if ok else PLAN_RETRY_S):
			return plan
	try:
		fresh = fetcher(token)
	except Exception:
		fresh = None
	with _PLAN_LOCK:
		_PLAN_READ[key] = (now, fresh if fresh is not None else plan, fresh is not None)
	return fresh if fresh is not None else plan


# ─── Native adapters: every private Hermes symbol is imported here and degrades to None. ───


def _native_symbols():
	symbols = {}

	def take(module, name):
		try:
			symbols[name] = getattr(__import__(module, fromlist=[name]), name)
		except Exception:
			symbols[name] = None

	take("agent.credential_pool", "PooledCredential")
	take("agent.credential_pool", "STATUS_DEAD")
	take("hermes_cli.auth", "read_credential_pool")
	take("hermes_cli.inventory", "_pool_entry_route_base_url")
	take("hermes_cli.inventory", "_pool_entry_host")
	take("agent.account_usage", "_codex_backend_urls")
	take("agent.account_usage", "_codex_headers")
	take("agent.account_usage", "fetch_account_usage")
	return symbols


def _claude_code_login(clock=time.time):
	"""Claude Code's OAuth login on this host as {token, expired}, or None. Read-only: honours CLAUDE_CONFIG_DIR like the CLI; refreshing is left to Hermes."""
	config = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
	path = (Path(config).expanduser() if config else Path.home() / ".claude") / ".credentials.json"
	try:
		entry = json.loads(path.read_text(encoding="utf-8-sig")).get("claudeAiOauth")
	except (OSError, ValueError, AttributeError):
		return None
	if not isinstance(entry, dict) or not isinstance(entry.get("accessToken"), str) or not entry["accessToken"].strip():
		return None
	expires_ms = entry.get("expiresAt")
	expired = isinstance(expires_ms, (int, float)) and not isinstance(expires_ms, bool) and expires_ms / 1000.0 <= float(clock())
	return {"token": entry["accessToken"].strip(), "expired": expired}


def _fetch_claude_profile_plan(token):
	"""The organization's rate_limit_tier from Anthropic's OAuth profile with Claude Code's token; None on any failure (a 401 is not retried or refreshed)."""
	import httpx
	try:
		with httpx.Client(timeout=CREDITS_TIMEOUT_S, follow_redirects=False) as client:
			response = client.get("https://api.anthropic.com/api/oauth/profile", headers=hermes_headers(token))
		if response.status_code != 200:
			return None
		organization = response.json().get("organization")
		tier = organization.get("rate_limit_tier") if isinstance(organization, dict) else None
	except Exception:
		return None
	return tier if isinstance(tier, str) and re.fullmatch(r"[A-Za-z0-9_ -]{1,64}", tier) else None


def _collect_claude_code(symbols, clock, login_reader, profile_fetcher=_fetch_claude_profile_plan, refresher=None, usage_fetcher=None):
	"""One Anthropic reading from Claude Code's login, or None when there is no such login."""
	login = login_reader(clock)
	if login is not None and login["expired"]:
		# An expired login is handed to Hermes's public usage fetch without a token, which resolves one the way a chat turn would. With the anthropic pool empty, as here, that ends in Hermes's Claude Code resolver, which refreshes the token, skips a rotation it could not commit and writes the new pair back where Claude Code reads it; an Anthropic API key in Hermes's environment takes precedence and leaves the login expired. The reading it returns is dropped, because it does not say which token it used, and the file is read again.
		public = symbols.get("fetch_account_usage")
		refresh = refresher or (public and (lambda: public("anthropic")))
		if refresh is not None:
			login.clear()
			try:
				refresh()
			except Exception:
				pass
			login = login_reader(clock)
	if login is None:
		return None
	account = {"id": CLAUDE_CODE_ACCOUNT_ID, "label": "Claude Code", "priority": 0, "error": None, "snapshot": None}
	reading = {"provider": "anthropic", "error": None, "accounts": [account]}
	try:
		if login["expired"]:
			account["error"] = "token_expired"
			return reading
		try:
			snapshot = _read_anthropic(login["token"], usage_fetcher or _fetch_anthropic_usage, clock)
		except Exception:
			snapshot = None
		if snapshot is None or not snapshot["windows"]:
			account["error"] = "refresh_failed"
		else:
			# Neither the credentials file (its plan fields are often absent) nor the usage body names the allowance; the profile's tier does.
			snapshot["plan"] = _cached_plan(CLAUDE_CODE_ACCOUNT_ID, login["token"], profile_fetcher, clock)
			account["snapshot"] = snapshot
		return reading
	finally:
		login.clear()


def _route(symbols, provider, entry):
	"""(base_url, host) Hermes's model picker uses for this entry; only called once both helpers are known present."""
	return symbols["_pool_entry_route_base_url"](provider, entry), symbols["_pool_entry_host"](provider, entry)


# Last credit-list read per (home, provider, account), process-wide so every sampler of a home shares it.
_CREDITS_LOCK = threading.Lock()
_CREDITS_READ = {}


def _fetch_accounts(fetch, requests, join_timeout):
	"""Read each (provider, base_url, token, identity_id) concurrently through Hermes's per-credential fetch; returns one snapshot, None (failed) or ``TIMEOUT`` per request.

	Each thread runs in a copy of the caller's context, like Hermes's own pool refresh, so it reads the same profile home.
	"""
	results = [TIMEOUT] * len(requests)

	def read(index, provider, base_url, token, identity_id):
		try:
			results[index] = fetch(provider, base_url=base_url, api_key=token, read_only=True, identity_id=identity_id)
		except Exception:
			results[index] = None

	threads = []
	for index, request in enumerate(requests):
		thread = threading.Thread(target=contextvars.copy_context().run, args=(read, index, *request), name="t3sidebar-limits-fetch", daemon=True)
		thread.start()
		threads.append(thread)
	deadline = time.monotonic() + max(0.0, float(join_timeout))
	for thread in threads:
		thread.join(max(0.0, deadline - time.monotonic()))
	return results


def _token_fingerprint(token):
	"""Same token, same account: the key Hermes's picker also gives a credential it cannot identify otherwise, so it reuses this reading."""
	return "fp:" + hashlib.sha256(token.encode("utf-8")).hexdigest()[:16]


def collect_native(join_timeout=JOIN_TIMEOUT_S, clock=time.time, credits_fetcher=None, claude_login=_claude_code_login, claude_profile=_fetch_claude_profile_plan, claude_refresher=None, anthropic_fetcher=None):
	"""Read every account of the vetted pooled providers: Codex through Hermes's read-only per-credential fetch, Anthropic with its own usage read.

	Must run inside the target home's context: Hermes keys auth.json on the active home.
	"""
	symbols = _native_symbols()
	read_pool = symbols["read_credential_pool"]
	if read_pool is None:
		raise RuntimeError("unavailable")
	pool = read_pool()
	if not isinstance(pool, dict):
		return []
	# Fail closed without Hermes's route for each entry: a guessed URL can send a key to the wrong host (a proxy key to chatgpt.com, Hermes issue #121486), so then nothing is sent at all.
	required = ("fetch_account_usage", "PooledCredential", "_pool_entry_route_base_url", "_pool_entry_host")
	started = float(clock())
	providers, slots, requests = [], [], []
	# Per-account credit lists while Hermes still has the private helpers they need.
	pool_credits = pool_credits_available(symbols)
	# The sampler runs inside its home's override, so this keys the throttle per profile like Hermes's own usage cache.
	try:
		home = _home_key(_default_home())
	except Exception:
		home = ""
	for provider in sorted(slug for slug in pool if slug in VETTED_PROVIDERS):
		rows = [row for row in (pool.get(provider) or []) if isinstance(row, dict) and row.get("id")]
		if not rows:
			# Hermes keeps the provider's pool key after the last credential is removed or logged out; report it so the page can say so instead of silently omitting the provider. A provider never configured has no key at all.
			providers.append({"provider": provider, "error": "logged_out", "accounts": []})
			continue
		reading = {"provider": provider, "error": None, "accounts": []}
		providers.append(reading)
		if any(symbols[name] is None for name in required):
			reading["error"] = "unavailable"
			continue
		try:
			entries = [symbols["PooledCredential"].from_dict(provider, row) for row in rows]
		except Exception:
			reading["error"] = "pool_unreadable"
			continue
		entries.sort(key=lambda entry: (_positive_int(getattr(entry, "priority", 0)) or 0))
		seen = set()
		for entry in entries:
			account_id = str(entry.id)
			if not _ACCOUNT_ID_PATTERN.fullmatch(account_id):
				continue
			priority = getattr(entry, "priority", None)
			account = {
				"id": account_id, "label": _safe_label(getattr(entry, "label", None), account_id),
				"priority": int(priority) if isinstance(priority, int) and not isinstance(priority, bool) else None,
				"error": None, "snapshot": None,
			}
			try:
				if symbols["STATUS_DEAD"] is not None and getattr(entry, "last_status", None) == symbols["STATUS_DEAD"]:
					account["error"] = "credential_dead"
					reading["accounts"].append(account)
					continue
				token = str(entry.runtime_api_key or "").strip()
				if not token:
					account["error"] = "no_credential"
					reading["accounts"].append(account)
					continue
				base_url, host = _route(symbols, provider, entry)
			except Exception:
				account["error"] = "internal_error"
				reading["accounts"].append(account)
				continue
			# Several credentials with one token on one route are one account; like the picker, count it once (lowest priority entry wins). The route keeps apart gateways that share a key, such as two proxies with one password. Codex credentials of one account with different tokens are merged after the fetch, by the identity Hermes decodes from each ChatGPT token.
			fingerprint = _token_fingerprint(token)
			if (host, fingerprint) in seen:
				continue
			seen.add((host, fingerprint))
			reading["accounts"].append(account)
			# The per-account credit list needs the same route and token, kept only in that mode.
			credit = (base_url, token) if pool_credits and provider == "openai-codex" else None
			slots.append((account, reading, host, credit))
			requests.append((provider, base_url, token, fingerprint))
	try:
		hermes_fetch, own_fetch = symbols["fetch_account_usage"], anthropic_fetcher or _fetch_anthropic_usage

		def fetch(provider, **kwargs):
			# Anthropic's own read already carries everything Hermes's fetch would return, so the same GET is not sent twice.
			return _read_anthropic(kwargs["api_key"], own_fetch, clock) if provider == "anthropic" else hermes_fetch(provider, **kwargs)
		results = _fetch_accounts(fetch, requests, join_timeout) if requests else []
		requests.clear()
		identities = set()
		for (account, reading, host, _credit), snapshot in zip(slots, results):
			if snapshot is TIMEOUT:
				account["error"] = "timeout"
				continue
			if snapshot is None:
				account["error"] = "refresh_failed"
				continue
			identity = getattr(snapshot, "identity", None)
			if isinstance(identity, str) and identity:
				# Another credential of an account already listed on this route, per the identity Hermes decodes from the token.
				if (reading["provider"], host, identity) in identities:
					reading["accounts"].remove(account)
					continue
				identities.add((reading["provider"], host, identity))
			try:
				account["snapshot"] = snapshot if isinstance(snapshot, dict) else normalize_snapshot(reading["provider"], snapshot)
			except Exception:
				account["error"] = "internal_error"
				continue
			if not account["snapshot"] or account["snapshot"]["fetched_at"] is None or not account["snapshot"]["windows"]:
				account["error"] = "no_data"
		# Credit lists are read after the usage fetches, so a merged duplicate is never asked; a failure only skips this hour's update.
		fetch_credits = credits_fetcher or (lambda base_url, token: _fetch_codex_credits(symbols, base_url, token))
		for account, reading, _host, credit in slots:
			if credit is None or account not in reading["accounts"]:
				continue
			with _CREDITS_LOCK:
				due = started - _CREDITS_READ.get((home, "openai-codex", account["id"]), float("-inf")) >= CREDITS_INTERVAL_S
				if due:
					_CREDITS_READ[(home, "openai-codex", account["id"])] = started
			if not due:
				continue
			try:
				credits = fetch_credits(*credit)
			except Exception:
				credits = None
			if credits is not None:
				account["credits"] = credits
	finally:
		# Drop this collection's references to the tokens; each fetch thread drops its own when it ends.
		requests.clear()
		slots.clear()
	# Hermes's own anthropic pool wins; only an empty or missing one falls back to Claude Code's login.
	current = next((reading for reading in providers if reading["provider"] == "anthropic"), None)
	if current is None or current["error"] == "logged_out":
		fallback = _collect_claude_code(symbols, clock, claude_login, claude_profile, claude_refresher, anthropic_fetcher)
		if fallback is not None:
			providers = sorted([reading for reading in providers if reading is not current] + [fallback], key=lambda reading: reading["provider"])
	return providers


def forget_credit_read(provider, account_id):
	"""Make one account's credit list due at the next collection, after something outside the sampler (a redeemed reset) changed it."""
	try:
		home = _home_key(_default_home())
	except Exception:
		home = ""
	with _CREDITS_LOCK:
		_CREDITS_READ.pop((home, provider, account_id), None)


def forget_due_credit_reads(now):
	"""Drop the active home's credit reads that are due at ``now`` anyway, so accounts that left the pool do not keep an entry for the life of the process."""
	try:
		home = _home_key(_default_home())
	except Exception:
		home = ""
	with _CREDITS_LOCK:
		for key in [key for key, read_at in _CREDITS_READ.items() if key[0] == home and now - read_at >= CREDITS_INTERVAL_S]:
			del _CREDITS_READ[key]


# ─── Store ───


class LimitsStore:
	"""Short-lived connections to a plugin-owned SQLite file; writers serialize with BEGIN IMMEDIATE."""

	def __init__(self, path, clock=time.time):
		self.path = Path(path)
		self.clock = clock

	@staticmethod
	def ensure_schema(connection):
		connection.execute("""
			CREATE TABLE IF NOT EXISTS limit_samples (
				t REAL NOT NULL,
				provider TEXT NOT NULL,
				account_id TEXT NOT NULL,
				account_label TEXT,
				priority INTEGER,
				plan TEXT,
				banked_resets INTEGER,
				window_key TEXT,
				window_label TEXT,
				window_seconds INTEGER,
				scope TEXT,
				model TEXT,
				used_percent REAL,
				resets_at REAL,
				error TEXT
			)
		""")
		connection.execute("CREATE INDEX IF NOT EXISTS limit_samples_account ON limit_samples (provider, account_id, t)")
		connection.execute("CREATE INDEX IF NOT EXISTS limit_samples_t ON limit_samples (t)")
		connection.execute("""
			CREATE TABLE IF NOT EXISTS limit_provider_status (
				provider TEXT PRIMARY KEY,
				checked_at REAL NOT NULL,
				error TEXT
			)
		""")
		connection.execute("""
			CREATE TABLE IF NOT EXISTS limit_credits (
				provider TEXT NOT NULL,
				account_id TEXT NOT NULL,
				credits_fetched_at REAL,
				credits_json TEXT,
				applicable_count INTEGER,
				PRIMARY KEY (provider, account_id)
			)
		""")
		connection.execute("""
			CREATE TABLE IF NOT EXISTS limit_reset_grants (
				provider TEXT NOT NULL,
				account_id TEXT NOT NULL,
				fetched_at REAL NOT NULL,
				grants_json TEXT NOT NULL,
				weekly_share_used REAL,
				PRIMARY KEY (provider, account_id)
			)
		""")
		# The table of the former experimental per-account switch: per-account lists are no longer optional.
		connection.execute("DROP TABLE IF EXISTS limit_settings")
		connection.execute("""
			CREATE TABLE IF NOT EXISTS limit_sampler_status (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				interval_s REAL,
				started_at REAL,
				last_run_at REAL,
				last_error TEXT
			)
		""")

	@contextmanager
	def _writer(self):
		self.path.parent.mkdir(parents=True, exist_ok=True)
		with closing(sqlite3.connect(self.path, timeout=30, isolation_level=None)) as connection:
			connection.execute("PRAGMA journal_mode=WAL")
			connection.execute("BEGIN IMMEDIATE")
			try:
				self.ensure_schema(connection)
				yield connection
				connection.execute("COMMIT")
			except BaseException:
				if connection.in_transaction:
					connection.execute("ROLLBACK")
				raise

	@contextmanager
	def _reader(self):
		if not self.path.exists():
			yield None
			return
		# mode=rw: never create the file from a read, but still able to open a WAL database whose -shm was cleaned up on close.
		with closing(sqlite3.connect(f"{self.path.resolve().as_uri()}?mode=rw", uri=True, timeout=30)) as connection:
			tables = {name for (name,) in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
			yield connection if "limit_samples" in tables else None

	def record(self, readings, checked_at=None):
		"""Store one collection; return the number of inserted rows. Unchanged snapshots (same fetched_at) add nothing."""
		checked_at = _finite(self.clock() if checked_at is None else checked_at)
		if checked_at is None or checked_at <= 0:
			raise ValueError("checked_at must be a positive finite epoch timestamp")
		inserted = 0
		with self._writer() as connection:
			for reading in readings or ():
				provider = str(reading.get("provider") or "").strip().lower()
				if not provider or len(provider) > 64:
					continue
				connection.execute(
					"INSERT INTO limit_provider_status (provider, checked_at, error) VALUES (?, ?, ?) "
					"ON CONFLICT(provider) DO UPDATE SET checked_at = excluded.checked_at, error = excluded.error",
					(provider, checked_at, _safe_error(reading.get("error"))))
				for account in reading.get("accounts") or ():
					inserted += self._record_account(connection, provider, account, checked_at)
			connection.execute("DELETE FROM limit_samples WHERE t < ?", (checked_at - RETENTION_S,))
			connection.execute("DELETE FROM limit_provider_status WHERE checked_at < ?", (checked_at - RETENTION_S,))
			# An account is shown only while it has samples, so its credit list goes with its last one.
			connection.execute(
				"DELETE FROM limit_credits WHERE NOT EXISTS "
				"(SELECT 1 FROM limit_samples WHERE limit_samples.provider = limit_credits.provider AND limit_samples.account_id = limit_credits.account_id)")
			# A reset list is shown only while fresh, so an older one is never offered again.
			connection.execute("DELETE FROM limit_reset_grants WHERE fetched_at < ?", (checked_at - STALE_AFTER_S,))
		return inserted

	@staticmethod
	def _record_account(connection, provider, account, checked_at):
		account_id = str(account.get("id") or "")
		if not _ACCOUNT_ID_PATTERN.fullmatch(account_id):
			return 0
		label = _safe_label(account.get("label"), account_id)
		priority = account.get("priority")
		priority = priority if isinstance(priority, int) and not isinstance(priority, bool) else None
		inserted = 0
		snapshot = account.get("snapshot")
		fetched_at = _finite(snapshot.get("fetched_at")) if isinstance(snapshot, dict) else None
		applicable = snapshot.get("banked_applicable") if isinstance(snapshot, dict) and fetched_at else None
		if isinstance(applicable, int) and not isinstance(applicable, bool):
			connection.execute(
				"INSERT INTO limit_credits (provider, account_id, applicable_count) VALUES (?, ?, ?) "
				"ON CONFLICT(provider, account_id) DO UPDATE SET applicable_count = excluded.applicable_count",
				(provider, account_id, applicable))
		credits = account.get("credits")
		if isinstance(credits, list):
			# Re-normalized on write so a direct caller cannot store anything beyond status and times.
			clean = normalize_credits({"credits": credits}, checked_at) or []
			connection.execute(
				"INSERT INTO limit_credits (provider, account_id, credits_fetched_at, credits_json) VALUES (?, ?, ?, ?) "
				"ON CONFLICT(provider, account_id) DO UPDATE SET credits_fetched_at = excluded.credits_fetched_at, credits_json = excluded.credits_json",
				(provider, account_id, checked_at, json.dumps(clean, separators=(",", ":"))))
		grants = snapshot.get("reset_grants") if isinstance(snapshot, dict) and fetched_at else None
		if isinstance(grants, dict):
			# Re-cleaned on write so a direct caller cannot store anything beyond the reset fields.
			clean = [grant for grant in map(_clean_grant, (grants.get("grants") or [])[:MAX_GRANTS] if isinstance(grants.get("grants"), list) else []) if grant]
			share = _finite(grants.get("weekly_share_used"))
			connection.execute(
				"INSERT INTO limit_reset_grants (provider, account_id, fetched_at, grants_json, weekly_share_used) VALUES (?, ?, ?, ?, ?) "
				"ON CONFLICT(provider, account_id) DO UPDATE SET fetched_at = excluded.fetched_at, grants_json = excluded.grants_json, weekly_share_used = excluded.weekly_share_used "
				"WHERE excluded.fetched_at >= limit_reset_grants.fetched_at",
				(provider, account_id, fetched_at, json.dumps(clean, separators=(",", ":")), share if share is not None and 0 <= share <= 100 else None))
		windows = [w for w in (snapshot or {}).get("windows") or () if isinstance(w, dict) and w.get("key")] if fetched_at else []
		if windows:
			(last,) = connection.execute(
				"SELECT MAX(t) FROM limit_samples WHERE provider = ? AND account_id = ? AND window_key IS NOT NULL",
				(provider, account_id)).fetchone()
			if last is None or fetched_at > last:
				plan = snapshot.get("plan") if isinstance(snapshot.get("plan"), str) else None
				banked = snapshot.get("banked_resets")
				banked = banked if isinstance(banked, int) and not isinstance(banked, bool) else None
				for window in windows:
					scope = window.get("scope") if window.get("scope") in ("account", "model") else None
					connection.execute(
						"INSERT INTO limit_samples (t, provider, account_id, account_label, priority, plan, banked_resets, window_key, "
						"window_label, window_seconds, scope, model, used_percent, resets_at, error) "
						"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
						(fetched_at, provider, account_id, label, priority, plan, banked, str(window["key"])[:120],
						 (str(window.get("label"))[:64] if window.get("label") else None), _positive_int(window.get("window_seconds")),
						 scope, (str(window.get("model"))[:64] if window.get("model") else None),
						 _finite(window.get("used_percent")), _finite(window.get("resets_at"))))
					inserted += 1
		error = _safe_error(account.get("error"))
		if error:
			# Record an error once per streak; it is cleared by the next newer window sample.
			latest = connection.execute(
				"SELECT window_key, error FROM limit_samples WHERE provider = ? AND account_id = ? ORDER BY t DESC, rowid DESC LIMIT 1",
				(provider, account_id)).fetchone()
			if latest is None or latest[0] is not None or latest[1] != error:
				connection.execute(
					"INSERT INTO limit_samples (t, provider, account_id, account_label, priority, error) VALUES (?, ?, ?, ?, ?, ?)",
					(max(checked_at, fetched_at or 0.0), provider, account_id, label, priority, error))
				inserted += 1
		return inserted

	def write_status(self, status):
		with self._writer() as connection:
			connection.execute(
				"INSERT INTO limit_sampler_status (id, interval_s, started_at, last_run_at, last_error) VALUES (1, ?, ?, ?, ?) "
				"ON CONFLICT(id) DO UPDATE SET interval_s = excluded.interval_s, started_at = excluded.started_at, "
				"last_run_at = excluded.last_run_at, last_error = excluded.last_error",
				(_finite(status.get("interval_s")), _finite(status.get("started_at")), _finite(status.get("last_run_at")),
				 _status_error(status.get("last_error"))))

	def read_status(self):
		with self._reader() as connection:
			if connection is None:
				return None
			row = connection.execute(
				"SELECT interval_s, started_at, last_run_at, last_error FROM limit_sampler_status WHERE id = 1").fetchone()
		if row is None:
			return None
		return {"interval_s": row[0], "started_at": row[1], "last_run_at": row[2], "last_error": row[3]}

	def read_rows(self, since=None):
		"""Rows from ``since`` on, extended back to each account's newest window sample (or newest row without any) so the latest windows, label, priority and error stay exact for accounts that stopped sampling; ``None`` reads everything."""
		with self._reader() as connection:
			if connection is None:
				return [], {}
			columns = ("SELECT t, provider, account_id, account_label, priority, plan, banked_resets, window_key, window_label, "
				"window_seconds, scope, model, used_percent, resets_at, error FROM limit_samples")
			order = " ORDER BY provider, account_id, t, rowid"
			if since is None:
				rows = connection.execute(columns + order).fetchall()
			else:
				# Uncorrelated, so the per-account newest times are computed once rather than per row.
				rows = connection.execute(
					columns + " WHERE t >= MIN(?, (SELECT MIN(latest) FROM (SELECT COALESCE(MAX(CASE WHEN window_key IS NOT NULL THEN t END), MAX(t)) AS latest "
					"FROM limit_samples GROUP BY provider, account_id)))" + order, (since,)).fetchall()
			statuses = {provider: error for provider, error in connection.execute("SELECT provider, error FROM limit_provider_status")}
		return rows, statuses

	def read_account_extras(self):
		"""(credits, reset grants) through one connection, as ``read_credits`` and ``read_reset_grants`` return them; a table missing from an older store reads empty."""
		with self._reader() as connection:
			if connection is None:
				return {}, {}

			def rows(sql):
				# One statement each: a store created before a table existed fails the read instead of being checked first.
				try:
					return connection.execute(sql).fetchall()
				except sqlite3.OperationalError:
					return []
			credits = {(provider, account_id): (fetched, text, applicable) for provider, account_id, fetched, text, applicable in rows(
				"SELECT provider, account_id, credits_fetched_at, credits_json, applicable_count FROM limit_credits")}
			grants = {(provider, account_id): (fetched, text, share) for provider, account_id, fetched, text, share in rows(
				"SELECT provider, account_id, fetched_at, grants_json, weekly_share_used FROM limit_reset_grants")}
		return credits, grants

	def read_reset_grants(self):
		"""{(provider, account_id): (fetched_at, grants_json, weekly_share_used)}; empty for a store created before the table existed."""
		return self.read_account_extras()[1]

	def read_credits(self):
		"""{(provider, account_id): (credits_fetched_at, credits_json, applicable_count)}; empty for a store created before the table existed."""
		with self._reader() as connection:
			if connection is None:
				return {}
			if connection.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'limit_credits'").fetchone() is None:
				return {}
			return {(provider, account_id): (fetched, text, applicable) for provider, account_id, fetched, text, applicable in connection.execute(
				"SELECT provider, account_id, credits_fetched_at, credits_json, applicable_count FROM limit_credits")}


def _status_error(value):
	if value is None:
		return None
	text = str(value)
	prefix, _, name = text.partition(":")
	if prefix in ("collector_failed", "store_failed") and _EXCEPTION_NAME_PATTERN.fullmatch(name):
		return text
	return _safe_error(text)


# ─── Payload ───


def _sampler_block(status):
	status = status if isinstance(status, dict) else {}
	return {
		"interval_s": _finite(status.get("interval_s")),
		"started_at": _finite(status.get("started_at")),
		"last_run_at": _finite(status.get("last_run_at")),
		"last_error": _status_error(status.get("last_error")),
	}


def _credits_block(row, now):
	"""Available, unexpired banked credits by expiry, or None when the list was never read."""
	if row is None or row[0] is None or row[1] is None:
		return None
	fetched_at, text, applicable = row
	try:
		credits = json.loads(text)
	except ValueError:
		return None
	available = [c for c in credits if isinstance(c, dict) and c.get("status") == "available" and (c.get("expires_at") is None or c["expires_at"] > now)]
	available.sort(key=lambda c: (c["expires_at"] is None, c["expires_at"] or 0.0))
	return {"fetched_at": fetched_at, "applicable_count": applicable, "credits": [{"status": "available", "expires_at": c.get("expires_at"), "granted_at": c.get("granted_at")} for c in available]}


def _clean_grant(grant):
	"""One reset as stored and sent: only its id, kind, count, expiry, usability, reason and what it clears."""
	if not isinstance(grant, dict) or not isinstance(grant.get("id"), str) or not _GRANT_ID_PATTERN.fullmatch(grant["id"]) or grant.get("kind") not in RESET_KINDS:
		return None
	left = grant.get("resets_left")
	if not isinstance(left, int) or isinstance(left, bool) or not 0 < left <= 1000:
		return None
	reason = grant.get("reason")
	clears = grant.get("clears") if isinstance(grant.get("clears"), list) else []
	return {"id": grant["id"], "kind": grant["kind"], "resets_left": left, "ends_at": _finite(grant.get("ends_at")), "usable": grant.get("usable") is True,
		"reason": reason if isinstance(reason, str) and _SLUG_PATTERN.fullmatch(reason) else None,
		"clears": [limit for limit in clears if isinstance(limit, str) and _SLUG_PATTERN.fullmatch(limit)][:8]}


def _grants_block(row, now):
	"""An account's limit resets that have not expired, soonest expiry first, or None when never read or older than the freshness limit: a stale list could offer a reset already spent elsewhere."""
	if row is None:
		return None
	fetched_at, text, share = row
	if fetched_at is None or not 0 <= now - fetched_at <= STALE_AFTER_S:
		return None
	try:
		grants = [grant for grant in map(_clean_grant, json.loads(text)) if grant and (grant["ends_at"] is None or grant["ends_at"] > now)]
	except (ValueError, TypeError):
		return None
	grants.sort(key=lambda grant: (grant["ends_at"] is None, grant["ends_at"] or 0.0, RESET_KINDS.index(grant["kind"])))
	return {"fetched_at": fetched_at, "weekly_share_used": share, "grants": grants}


def _history_number(value, digits=0):
	"""Rounded for the wire: whole seconds for times, one decimal for percentages; whole numbers lose their ``.0``."""
	if value is None:
		return None
	rounded = round(value, digits)
	return int(rounded) if rounded == int(rounded) else rounded


def _compact_series(account_id, key, samples):
	"""One account window's history as parallel arrays, keeping only the samples a step chart and the drain average need: both ends, every change of value or reset, and the sample just before each change. A held reading between two kept samples was sampled unchanged."""
	kept = [sample for index, sample in enumerate(samples)
		if index == 0 or index == len(samples) - 1 or sample[1:] != samples[index - 1][1:] or sample[1:] != samples[index + 1][1:]]
	return {"account": account_id, "window": key, "t": [s[0] for s in kept], "remaining_percent": [s[1] for s in kept], "resets_at": [s[2] for s in kept]}


def _remaining(used):
	return None if used is None else max(0.0, min(100.0, 100.0 - used))


def limits_payload(store, *, hours, now, sampler_status=None):
	"""``GET /usage/limits`` body: latest windows per account from its newest sample plus, per account window, the compacted history within ``hours`` (``_compact_series``)."""
	if type(hours) is not int or not 1 <= hours <= MAX_HOURS:
		raise ValueError(f"hours must be an integer between 1 and {MAX_HOURS}")
	now = _finite(now)
	if now is None:
		raise ValueError("now must be a finite epoch timestamp")
	since = now - hours * 3600.0
	rows, statuses = store.read_rows(since)
	credit_rows, grant_rows = store.read_account_extras()
	providers = {}

	def provider_block(slug):
		if slug not in providers:
			providers[slug] = {
				"provider": slug, "label": PROVIDER_LABELS.get(slug, slug), "error": _safe_error(statuses.get(slug)),
				"accounts": {}, "series": {},
			}
		return providers[slug]

	for slug in statuses:
		provider_block(slug)
	for t, slug, account_id, label, priority, plan, banked, key, window_label, seconds, scope, model, used, resets_at, error in rows:
		block = provider_block(slug)
		account = block["accounts"].setdefault(account_id, {"last": None, "fetched_at": None, "sample": None, "windows": []})
		# Rows arrive ascending, so the last one seen wins for label/priority/error.
		account["last"] = (label, priority, error if key is None else None)
		if key is None:
			continue
		if account["fetched_at"] != t:
			account["fetched_at"], account["sample"], account["windows"] = t, (plan, banked), []
		# Only the newest sample's windows survive, so they stay raw until the account is assembled.
		account["windows"].append((key, window_label, seconds, scope, model, used, resets_at))
		if since <= t <= now:
			block["series"].setdefault((account_id, key), []).append((_history_number(t), _history_number(_remaining(used), 1), _history_number(resets_at)))
	result = []
	for slug in sorted(providers):
		block = providers[slug]
		accounts = []
		for account_id, account in block["accounts"].items():
			label, priority, error = account["last"]
			fetched_at = account["fetched_at"]
			plan, banked = account["sample"] or (None, None)
			age = None if fetched_at is None else now - fetched_at
			accounts.append({
				"id": account_id, "label": label, "priority": priority, "plan": plan, "banked_resets": banked,
				"banked_credits": _credits_block(credit_rows.get((slug, account_id)), now),
				"reset_grants": _grants_block(grant_rows.get((slug, account_id)), now),
				"fetched_at": fetched_at, "stale": age is None or age < 0 or age > STALE_AFTER_S, "error": error,
				"windows": [{
					# Samples stored before durations were inferred carry none; window_seconds fills them in the same way.
					"key": key, "label": window_label, "window_seconds": window_seconds(slug, key, seconds), "scope": scope, "model": model,
					"used_percent": used, "remaining_percent": _remaining(used), "resets_at": resets_at,
				} for key, window_label, seconds, scope, model, used, resets_at in account["windows"]],
			})
		accounts.sort(key=lambda a: (a["priority"] is None, a["priority"] or 0, a["label"] or "", a["id"]))
		history = [_compact_series(account_id, key, samples) for (account_id, key), samples in sorted(block.pop("series").items())]
		# A logged-out provider is an authentication state, not a sampling failure.
		logged_out = block["error"] == "logged_out"
		result.append({**block, "error": None if logged_out else block["error"], "auth": "logged_out" if logged_out else "ok", "auth_reason": None, "accounts": accounts, "history": history})
	if sampler_status is None:
		sampler_status = store.read_status()
	return {"generated_at": now, "sampler": _sampler_block(sampler_status), "providers": result}


# ─── Sampler ───


_REGISTRY_LOCK = threading.Lock()
_REGISTRY = {}
_OWNERS_LOCK = threading.RLock()
_OWNERS = {}


class _SamplerOwner:
	"""One registration's sampler; serialize starts with unload so late polls cannot restart it."""

	def __init__(self, home):
		self.home = Path(home).resolve()
		self.key = (os.getpid(), _home_key(self.home))
		self.sampler = None
		self.closed = False

	def start(self, store):
		with _OWNERS_LOCK:
			if self.closed or _OWNERS.get(self.key) is not self:
				return None
			if self.sampler is None:
				self.sampler = LimitsSampler(store, home_resolver=lambda: self.home).start()
			return self.sampler

	def close(self):
		with _OWNERS_LOCK:
			sampler = self._shut()
		# Join outside the lock: an async /runtime poll takes it to start sampling, and a tick can take seconds to notice the stop.
		if sampler is not None:
			sampler.stop()

	def _shut(self):
		"""Under _OWNERS_LOCK: fence later starts and signal this owner's sampler; return it for the caller to join once the lock is released."""
		if self.closed:
			return None
		self.closed = True
		if _OWNERS.get(self.key) is self:
			del _OWNERS[self.key]
		# A currently collecting tick may finish, but no later tick will run, and a stopping sampler no longer holds the process/home sampler slot.
		if self.sampler is not None:
			self.sampler._stop.set()
		return self.sampler


def register_limits_sampler(ctx):
	owner = _SamplerOwner(_default_home())
	ctx.on_unload(owner.close)
	stale = None
	with _OWNERS_LOCK:
		if not owner.closed:
			previous = _OWNERS.get(owner.key)
			if previous is not None:
				stale = previous._shut()
			_OWNERS[owner.key] = owner
	if stale is not None:
		stale.stop()


def start_limits_sampler(store):
	key = (os.getpid(), _home_key(_default_home()))
	with _OWNERS_LOCK:
		owner = _OWNERS.get(key)
		return owner.start(store) if owner is not None else None


def _default_home():
	from hermes_constants import get_hermes_home

	return get_hermes_home()


def _home_key(home):
	try:
		from hermes_constants import hermes_home_key

		return hermes_home_key(home)
	except Exception:
		return os.path.normcase(str(Path(home).expanduser().resolve(strict=False)))


@contextmanager
def _home_scope(home):
	"""Make *home* the active Hermes home for this context, so auth.json and the usage cache resolve to it."""
	try:
		from hermes_constants import reset_hermes_home_override, set_hermes_home_override
	except Exception:
		yield
		return
	token = set_hermes_home_override(home)
	try:
		yield
	finally:
		reset_hermes_home_override(token)


class LimitsSampler:
	"""One daemon thread per process and Hermes home, ticking ``run_once`` every ``interval_s``."""

	def __init__(self, store, home_resolver=None, interval_s=DEFAULT_INTERVAL_S, collector=None, clock=time.time,
			first_delay_s=FIRST_TICK_DELAY_S, join_timeout_s=JOIN_TIMEOUT_S):
		if _finite(interval_s) is None or interval_s <= 0:
			raise ValueError("interval_s must be positive")
		self.store = store
		self.home_resolver = home_resolver or _default_home
		self.interval_s = float(interval_s)
		self.collector = collector
		self.clock = clock
		self.first_delay_s = max(0.0, float(first_delay_s))
		self.join_timeout_s = float(join_timeout_s)
		self.home = None
		self.started_at = None
		self.last_run_at = None
		self.last_error = None
		self._lock = threading.Lock()
		self._thread = None
		self._stop = threading.Event()
		self._registry_key = None

	def status(self):
		return {"interval_s": self.interval_s, "started_at": self.started_at, "last_run_at": self.last_run_at, "last_error": self.last_error}

	def is_running(self):
		thread = self._thread
		return thread is not None and thread.is_alive() and not self._stop.is_set()

	def start(self):
		"""Start the background thread unless one already serves this process and home; return the sampler that does."""
		home = Path(self.home_resolver())
		key = (os.getpid(), _home_key(home))
		with _REGISTRY_LOCK:
			existing = _REGISTRY.get(key)
			if existing is not None and existing.is_running():
				return existing
			self.home = home
			self.started_at = float(self.clock())
			self._stop = threading.Event()
			self._registry_key = key
			# Copy the caller's context so profile-scoped values (secret scope, multiplex flag) follow the thread; each tick re-asserts the home on top.
			context = contextvars.copy_context()
			self._thread = threading.Thread(
				target=context.run, args=(self._loop, self._stop), name="t3sidebar-limits-sampler", daemon=True)
			_REGISTRY[key] = self
			self._thread.start()
		return self

	def stop(self, timeout=5.0):
		self._stop.set()
		thread = self._thread
		if thread is not None and thread is not threading.current_thread():
			thread.join(timeout)
		with _REGISTRY_LOCK:
			if self._registry_key is not None and _REGISTRY.get(self._registry_key) is self:
				del _REGISTRY[self._registry_key]

	def _loop(self, stop):
		delay = self.first_delay_s
		while not stop.wait(delay):
			began = time.monotonic()
			try:
				self.run_once()
			except Exception as exc:  # a sampler thread must outlive anything one tick throws
				LOG.debug("t3sidebar limits sampler tick crashed: %s", type(exc).__name__)
			# Floor the wait so a tick that overran its interval cannot turn into a hot loop.
			delay = max(min(1.0, self.interval_s), self.interval_s - (time.monotonic() - began))

	def _collect(self):
		if self.collector is not None:
			return self.collector()
		return collect_native(join_timeout=self.join_timeout_s, clock=self.clock)

	def run_once(self):
		"""One collection + store write inside the sampler's home; returns a small summary, never raises for collector/store failures."""
		home = self.home or Path(self.home_resolver())
		checked_at = float(self.clock())
		inserted, error = 0, None
		with self._lock, _home_scope(home):
			try:
				readings = self._collect()
			except Exception as exc:
				readings, error = None, f"collector_failed:{type(exc).__name__}"
			forget_due_credit_reads(checked_at)
			if readings is not None:
				try:
					inserted = self.store.record(readings, checked_at=checked_at)
				except Exception as exc:
					error = f"store_failed:{type(exc).__name__}"
			self.last_run_at = float(self.clock())
			self.last_error = _status_error(error)
			if error:
				LOG.debug("t3sidebar limits sampler: %s", self.last_error)
			try:
				self.store.write_status(self.status())
			except Exception as exc:
				LOG.debug("t3sidebar limits sampler status write failed: %s", type(exc).__name__)
		return {"inserted": inserted, "error": self.last_error}
