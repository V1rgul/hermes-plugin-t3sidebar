"""Token, API-equivalent cost and human-message history for the Usage page (`GET /usage/history`).

Hermes only stores exact cumulative usage per session x model x task (`session_model_usage`), without per-call timestamps. To draw a time series without adding storage, each usage row is redistributed over the timestamps of the API calls that produced it: main-loop rows over the session's assistant messages (input side weighted by the context size at that call, output side by the size of the reply), auxiliary rows and rows without matching messages over evenly spaced points. The result is therefore approximate by construction and says so (`approximate: true`).

The module is self-contained (stdlib only at import time) because the dashboard loads it directly via importlib. It never writes: Hermes `state.db` is opened with `mode=ro` for one short read transaction per request.
"""

import bisect
from collections import OrderedDict, defaultdict
import copy
from datetime import datetime, timedelta
import math
from pathlib import Path
import re
import sqlite3
import threading
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


VALID_DAYS = frozenset({1, 7, 30, 90})
# Usage rows record first/last call times with some lag relative to the persisted assistant message, so call matching and window overlap tolerate this much clock skew.
MATCH_SLACK_S = 120.0
SESSION_BATCH = 500
# Subscription routes are priced as the API they resell so the chart shows what the same traffic would have cost at list price; Hermes reports `openai-codex` as "included" otherwise.
API_PROVIDER_FOR = {"openai-codex": "openai", "anthropic": "anthropic"}
TOKEN_CLASSES = ("input", "output", "cache_read", "cache_write")
# Input-side classes scale with the context sent; output-side classes with the reply generated.
INPUT_SIDE = ("input", "cache_read", "cache_write")
# Mirrors hermes_state_sessions.INTERNAL_LISTING_SOURCES for Hermes builds that do not export it.
_FALLBACK_INTERNAL_SOURCES = frozenset({"kanban", "tool", "oneshot"})
# Machine-driven sessions: their user rows are prompts written by Hermes, not by a person.
_NON_HUMAN_SOURCES = frozenset({"cron", "subagent"})
# `display_kind` marks rows Hermes injected into the user role; only a mid-turn steer is typed by the user.
_HUMAN_DISPLAY_KINDS = frozenset({"steer"})
# Older Hermes builds injected the same notifications without a display_kind, so the live DB still holds NULL-kind rows recognisable only by their fixed headers.
_SYNTHETIC_USER_PREFIX = re.compile(
	r"(?:\[IMPORTANT: Background process |\[IMPORTANT: You are running as a scheduled cron job"
	r"|\[CONTEXT COMPACTION|\[ASYNC DELEGATION |\[Your active task list was preserved"
	r"|\[Heartbeat — |\[STILL IN PROGRESS — |\[System: |\[System note: |\[SYSTEM: |\[Cronjob "
	r"|You've reached the maximum number of tool-calling iterations"
	r"|Coordinator handoff, not an additional answer"
	r"|\S \[[^\]\n]+\] @\S+ Kanban t_)"
)
# Enough of the head of a user row to classify it without loading whole prompts into Python.
_USER_HEAD_CHARS = 160
_CACHE_LIMIT = 32
_PRICE_MEMO_LIMIT = 50000

_cache = OrderedDict()
_cache_lock = threading.Lock()
_price_memo = {}
_price_memo_lock = threading.Lock()
# Per-session placements survive across requests and windows, so a poll while one conversation is active re-reads only that conversation's messages.
_LAYOUT_LIMIT = 20000
_layouts = {}
_layout_lock = threading.Lock()


def clear_cache():
	with _cache_lock:
		_cache.clear()
	with _price_memo_lock:
		_price_memo.clear()
	with _layout_lock:
		_layouts.clear()


def history_payload(db_path, *, days, tz, now, pricing=None):
	"""Return the contract payload for `GET /usage/history`; raises ValueError for unsupported days or an unknown IANA zone."""
	if type(days) is not int or days not in VALID_DAYS:
		raise ValueError("days must be one of 1, 7, 30, 90")
	zone = _zone(tz)
	if isinstance(now, bool) or not isinstance(now, (int, float)) or not math.isfinite(now):
		raise ValueError("now must be a finite epoch timestamp")
	now = float(now)
	buckets, window_end = _buckets(days, zone, now)
	price = pricing if pricing is not None else _hermes_price
	db_key = str(Path(db_path).resolve())
	key = (db_key, days, tz, buckets[0], window_end, price)
	with _connect(db_path) as conn:
		# One read transaction so the change marker and the data describe the same snapshot.
		conn.execute("BEGIN")
		try:
			marker = _change_marker(conn)
			with _cache_lock:
				hit = _cache.get(key)
				if hit is not None and hit[0] == marker:
					_cache.move_to_end(key)
					payload = copy.deepcopy(hit[1])
					payload["generated_at"] = now
					return payload
			payload = _compute(conn, days, tz, now, buckets, window_end, price, db_key)
		finally:
			conn.rollback()
	with _cache_lock:
		_cache[key] = (marker, copy.deepcopy(payload))
		_cache.move_to_end(key)
		while len(_cache) > _CACHE_LIMIT:
			_cache.popitem(last=False)
	return payload


def _zone(tz):
	if type(tz) is not str or not tz or len(tz) > 128:
		raise ValueError("tz must be an IANA time zone name")
	try:
		return ZoneInfo(tz)
	except (ZoneInfoNotFoundError, ValueError, OSError) as error:
		raise ValueError(f"unknown time zone: {tz!r}") from error


def _buckets(days, zone, now):
	"""Bucket starts as UTC epochs plus the end of the last bucket."""
	local_now = datetime.fromtimestamp(now, zone)
	if days == 1:
		# Hour starts are a fixed 3600 s apart in absolute time, so a DST change yields 24 real hours that the client labels in local time; flooring keeps the zone's own minute offset (e.g. :30 zones).
		current = local_now.replace(minute=0, second=0, microsecond=0).timestamp()
		return [current - 3600.0 * (23 - index) for index in range(24)], current + 3600.0
	today = local_now.date()
	starts = []
	for index in range(days + 1):
		day = today - timedelta(days=days - 1 - index)
		starts.append(datetime(day.year, day.month, day.day, tzinfo=zone).timestamp())
	return starts[:-1], starts[-1]


def _connect(db_path):
	uri = Path(db_path).resolve().as_uri() + "?mode=ro"
	conn = sqlite3.connect(uri, uri=True, timeout=5.0, isolation_level=None, check_same_thread=False)
	conn.execute("PRAGMA query_only = 1")
	return _Closing(conn)


class _Closing:
	"""Close on exit; sqlite3.Connection's own context manager only ends transactions."""

	def __init__(self, conn):
		self.conn = conn

	def __enter__(self):
		return self.conn

	def __exit__(self, *exc):
		self.conn.close()
		return False


def _tables(conn):
	return {name for (name,) in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}


def _change_marker(conn):
	# PRAGMA data_version is per connection and this connection is new every time, so derive a cheap content marker instead: new or rewritten messages bump max(id), usage updates bump last_seen and the call/token totals, and deletions shrink the counts.
	tables = _tables(conn)
	marker = [tuple(sorted(tables & {"messages", "session_model_usage", "sessions"}))]
	if "messages" in tables:
		marker.append(conn.execute("SELECT MAX(id), COUNT(*) FROM messages").fetchone())
	if "session_model_usage" in tables:
		marker.append(conn.execute(
			"SELECT COUNT(*), MAX(last_seen), TOTAL(api_call_count), TOTAL(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) FROM session_model_usage"
		).fetchone())
	if "sessions" in tables:
		marker.append(conn.execute("SELECT COUNT(*) FROM sessions").fetchone())
	return tuple(marker)


def _columns(conn, table):
	return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def _non_human_sources():
	try:
		from hermes_state_sessions import INTERNAL_LISTING_SOURCES
		internal = frozenset(INTERNAL_LISTING_SOURCES)
	except Exception:
		internal = _FALLBACK_INTERNAL_SOURCES
	return internal | _NON_HUMAN_SOURCES


def is_human_user_row(display_kind, compressed_summary, head):
	"""Whether a role='user' row was typed by a person rather than injected by Hermes."""
	if compressed_summary:
		return False
	if display_kind is not None and display_kind not in _HUMAN_DISPLAY_KINDS:
		return False
	return head is None or _SYNTHETIC_USER_PREFIX.match(head) is None


def api_provider(billing_provider):
	if not billing_provider:
		return None
	return API_PROVIDER_FOR.get(billing_provider, billing_provider)


def _hermes_price(provider, model, usage):
	"""Default pricing: Hermes list prices for one usage row, or None when Hermes has no price."""
	if not provider or not model:
		return None
	calls = max(1, int(usage.get("request_count") or 1))
	# Hermes applies whole-request context tiers (e.g. GPT-6 above 272K prompt tokens) to a single request, so a row summed over many calls must be priced as `calls` average requests or every busy session would land in the expensive tier.
	average = tuple(int(round((usage.get(name) or 0) / calls)) for name in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens"))
	memo_key = (provider, model, calls, average)
	with _price_memo_lock:
		if memo_key in _price_memo:
			return _price_memo[memo_key]
	try:
		from agent.usage_pricing import CanonicalUsage, estimate_usage_cost
		result = estimate_usage_cost(model, CanonicalUsage(
			input_tokens=average[0], output_tokens=average[1], cache_read_tokens=average[2],
			cache_write_tokens=average[3], reasoning_tokens=average[4], request_count=1,
		), provider=provider)
	except Exception:
		return None
	# "included" means Hermes found no billable price for this route, which for an API-equivalent figure is the same as unknown.
	if result.amount_usd is None or result.status in ("unknown", "included"):
		value = None
	else:
		value = float(result.amount_usd) * calls
	with _price_memo_lock:
		if len(_price_memo) >= _PRICE_MEMO_LIMIT:
			_price_memo.clear()
		_price_memo[memo_key] = value
	return value


def _usage_dict(row, classes):
	usage = {"input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0, "reasoning_tokens": 0, "request_count": max(1, row.calls)}
	for name in classes:
		usage[f"{name}_tokens"] = getattr(row, name)
	if "output" in classes:
		usage["reasoning_tokens"] = row.reasoning
	return usage


# Small enough to stay below every whole-request context tier, large enough that Decimal per-million rates survive float conversion.
_PROBE_TOKENS = 1000


def _class_rates(price, provider, model, rates):
	"""Per-token price of each class for one route, or None when any class is unpriced; memoised in `rates` for one payload."""
	key = (provider, model)
	if key in rates:
		return rates[key]
	empty = {"input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0, "reasoning_tokens": 0, "request_count": 1}
	# A zero-token probe isolates any flat per-request fee so it does not skew the class proportions.
	base = price(provider, model, empty)
	result = None
	if base is not None:
		result = {}
		for name in TOKEN_CLASSES:
			value = price(provider, model, {**empty, f"{name}_tokens": _PROBE_TOKENS})
			if value is None:
				result = None
				break
			result[name] = max(0.0, (float(value) - float(base)) / _PROBE_TOKENS)
	rates[key] = result
	return result


def row_class_costs(price, provider, row, rates=None):
	"""Split a row's API-equivalent cost into token classes; returns (costs by class, priced)."""
	rates = {} if rates is None else rates
	costs = dict.fromkeys(TOKEN_CLASSES, 0.0)
	total = price(provider, row.model, _usage_dict(row, TOKEN_CLASSES))
	if total is None:
		return costs, False
	total = max(0.0, float(total))
	present = [name for name in TOKEN_CLASSES if getattr(row, name) > 0]
	if not present:
		# Only a flat per-request fee can price a tokenless row; it follows the calls like input does.
		costs["input"] = total
		return costs, True
	if len(present) == 1 or total == 0.0:
		costs[present[0]] = total
		return costs, True
	# The whole-row price is authoritative because context tiers apply per request; per-class rates only provide the proportions, which is exact when pricing is linear and close when a tier multiplier differs per class. Probing rates per route keeps this at one pricing call per row.
	unit = _class_rates(price, provider, row.model, rates)
	weights = {name: getattr(row, name) * unit[name] for name in present} if unit else {}
	if sum(weights.values()) <= 0.0:
		weights = {name: float(getattr(row, name)) for name in present}
	scale = total / sum(weights.values())
	for name, weight in weights.items():
		costs[name] = weight * scale
	return costs, True


_ROW_COLUMNS = "session_id, model, billing_provider, task, api_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, first_seen, last_seen"


class _Row:
	__slots__ = ("session_id", "model", "provider", "task", "calls", "input", "output", "cache_read", "cache_write", "reasoning", "first_seen", "last_seen")

	def __init__(self, record):
		(self.session_id, model, provider, task, calls, self.input, self.output, self.cache_read, self.cache_write, self.reasoning, self.first_seen, self.last_seen) = record
		self.model = model or "unknown"
		self.provider = provider or ""
		self.task = task or ""
		self.calls = max(0, int(calls or 0))
		for name in ("input", "output", "cache_read", "cache_write", "reasoning"):
			setattr(self, name, max(0, int(getattr(self, name) or 0)))

	@property
	def tokens(self):
		return self.input + self.output + self.cache_read + self.cache_write

	@property
	def signature(self):
		return (self.model, self.provider, self.task, self.calls, self.input, self.output, self.cache_read, self.cache_write, self.reasoning, self.first_seen, self.last_seen)


class _Series:
	__slots__ = ("values", "user_messages")

	def __init__(self, width):
		self.values = {name: [0.0] * width for name in (*TOKEN_CLASSES, "reasoning", "cost_usd")}
		self.user_messages = [0] * width


def _even_points(row):
	count = max(1, row.calls)
	first, last = row.first_seen, row.last_seen
	if count == 1 or last <= first:
		return [last] * count
	step = (last - first) / (count - 1)
	return [first + step * index for index in range(count)]


def _compute(conn, days, tz, now, buckets, window_end, price, db_key):
	width = len(buckets)
	start = buckets[0]
	series = {}
	missing = set()
	rates = {}
	user_owner = {}

	def bucket_of(timestamp):
		if timestamp < start or timestamp >= window_end:
			return None
		return bisect.bisect_right(buckets, timestamp) - 1

	def series_for(row):
		key = (row.provider, row.model)
		if key not in series:
			series[key] = _Series(width)
		return series[key]

	def add_row(row, times, in_shares, out_shares):
		in_window = [(bucket_of(timestamp), index) for index, timestamp in enumerate(times)]
		in_window = [(bucket, index) for bucket, index in in_window if bucket is not None]
		if not in_window:
			return
		costs, priced = row_class_costs(price, api_provider(row.provider), row, rates)
		if not priced and row.tokens:
			missing.add(f"{row.provider or 'unknown'}/{row.model}")
		target = series_for(row).values
		for bucket, index in in_window:
			share = in_shares[index]
			for name in INPUT_SIDE:
				target[name][bucket] += getattr(row, name) * share
				target["cost_usd"][bucket] += costs[name] * share
			share = out_shares[index]
			target["output"][bucket] += row.output * share
			target["reasoning"][bucket] += row.reasoning * share
			target["cost_usd"][bucket] += costs["output"] * share

	def add_users(users, rows):
		for timestamp, size, owner, delay in users:
			bucket = bucket_of(timestamp)
			if bucket is None:
				continue
			# Forked/continued sessions copy earlier user rows verbatim (same timestamp and text) into the child, so a message is counted once; the copy answered soonest is the original turn and decides the model.
			identity = (timestamp, size)
			if identity not in user_owner or delay < user_owner[identity][0]:
				user_owner[identity] = (delay, bucket, rows[owner])

	if {"session_model_usage", "messages", "sessions"} <= _tables(conn):
		# Only sessions with a usage row near the window are read, but each is read whole so context weights and call matching stay exact for rows that straddle the window start.
		session_ids = sorted({session_id for (session_id,) in conn.execute(
			"SELECT DISTINCT session_id FROM session_model_usage WHERE first_seen IS NOT NULL AND last_seen IS NOT NULL AND last_seen >= ? AND first_seen <= ?",
			(start - MATCH_SLACK_S, now),
		)})
		non_human = _non_human_sources()
		message_query = _message_query(conn)
		for offset in range(0, len(session_ids), SESSION_BATCH):
			batch = session_ids[offset:offset + SESSION_BATCH]
			for rows, layout in _session_layouts(conn, db_key, batch, non_human, message_query):
				for row, (times, in_shares, out_shares) in zip(rows, layout[0]):
					add_row(row, times, in_shares, out_shares)
				add_users(layout[1], rows)
		for _, bucket, row in user_owner.values():
			series_for(row).user_messages[bucket] += 1

	return _render(days, tz, now, buckets, series, missing)


def _message_query(conn):
	columns = _columns(conn, "messages")
	# octet_length reads the stored size from the record header instead of decoding (and paging in) every prompt as LENGTH must; bytes track characters closely enough for relative weights (1.04x on the live DB).
	size = "octet_length" if sqlite3.sqlite_version_info >= (3, 43, 0) else "LENGTH"
	reasoning = f"COALESCE({size}(reasoning), 0)" if "reasoning" in columns else "0"
	if "reasoning_content" in columns:
		# Hermes mirrors the same reasoning text into both columns; counting both would double the weight of thinking-heavy replies.
		reasoning = f"MAX({reasoning}, COALESCE({size}(reasoning_content), 0))"
	tool_calls = f"COALESCE({size}(tool_calls), 0)" if "tool_calls" in columns else "0"
	display_kind = "display_kind" if "display_kind" in columns else "NULL"
	compressed = "_compressed_summary" if "_compressed_summary" in columns else "0"
	return (
		f"SELECT session_id, role, timestamp, COALESCE({size}(content), 0) + {tool_calls} + {reasoning},"
		f" CASE WHEN role = 'user' THEN {display_kind} END, CASE WHEN role = 'user' THEN {compressed} END,"
		f" CASE WHEN role = 'user' THEN substr(content, 1, {_USER_HEAD_CHARS}) END"
		" FROM messages WHERE session_id IN ({}) AND timestamp IS NOT NULL ORDER BY session_id, timestamp, id"
	)


def _session_layouts(conn, db_key, batch, non_human, message_query):
	"""Yield (usage rows, layout) per session, reusing layouts whose session data has not changed."""
	placeholders = ",".join("?" * len(batch))
	rows_by_session = defaultdict(list)
	for record in conn.execute(f"SELECT {_ROW_COLUMNS} FROM session_model_usage WHERE session_id IN ({placeholders}) AND first_seen IS NOT NULL AND last_seen IS NOT NULL ORDER BY session_id, task, model, billing_provider, billing_base_url, billing_mode", batch):
		rows_by_session[record[0]].append(_Row(record))
	sources = dict(conn.execute(f"SELECT id, source FROM sessions WHERE id IN ({placeholders})", batch))
	markers = {session_id: (top, count) for session_id, top, count in conn.execute(f"SELECT session_id, MAX(id), COUNT(*) FROM messages WHERE session_id IN ({placeholders}) GROUP BY session_id", batch)}
	signatures = {}
	layouts = {}
	stale = []
	with _layout_lock:
		for session_id in batch:
			human = session_id in sources and sources[session_id] not in non_human
			signature = (markers.get(session_id), human, tuple(row.signature for row in rows_by_session[session_id]))
			signatures[session_id] = signature
			hit = _layouts.get((db_key, session_id))
			if hit is not None and hit[0] == signature:
				layouts[session_id] = hit[1]
			else:
				stale.append(session_id)
	if stale:
		messages = defaultdict(list)
		for record in conn.execute(message_query.format(",".join("?" * len(stale))), stale):
			messages[record[0]].append(record[1:])
		fresh = {session_id: _layout(rows_by_session[session_id], messages.get(session_id, ()), signatures[session_id][1]) for session_id in stale}
		layouts.update(fresh)
		with _layout_lock:
			if len(_layouts) + len(fresh) > _LAYOUT_LIMIT:
				_layouts.clear()
			for session_id, layout in fresh.items():
				_layouts[(db_key, session_id)] = (signatures[session_id], layout)
	for session_id in batch:
		if rows_by_session[session_id]:
			yield rows_by_session[session_id], layouts[session_id]


def _layout(rows, messages, human):
	"""Window-independent placement of one session: per row (call times, input shares, output shares) and human user messages as (time, size, owning row index, reply delay)."""
	# In-place compaction rewrites rows with new ids but the same role, timestamp and text, so identical copies are counted once both as context and as calls.
	timestamps = []
	prefix = [0]
	calls = []
	users = []
	seen = set()
	for role, timestamp, size, display_kind, compressed, head in messages:
		identity = (role, timestamp, size)
		if identity in seen:
			continue
		seen.add(identity)
		if role == "assistant":
			# Context is everything persisted strictly before this call.
			calls.append((timestamp, size, prefix[bisect.bisect_left(timestamps, timestamp)]))
		elif role == "user" and human and is_human_user_row(display_kind, compressed, head):
			users.append((timestamp, size))
		timestamps.append(timestamp)
		prefix.append(prefix[-1] + size)
	call_times = [timestamp for timestamp, _, _ in calls]
	placements = []
	for row in rows:
		matched = []
		if not row.task:
			low = bisect.bisect_left(call_times, row.first_seen - MATCH_SLACK_S)
			high = bisect.bisect_right(call_times, row.last_seen + MATCH_SLACK_S)
			matched = calls[low:high]
		if matched:
			times = [timestamp for timestamp, _, _ in matched]
			in_weights = [context + 1 for _, _, context in matched]
			out_weights = [size + 1 for _, size, _ in matched]
			in_total = sum(in_weights)
			out_total = sum(out_weights)
			placements.append((times, [weight / in_total for weight in in_weights], [weight / out_total for weight in out_weights]))
		else:
			times = _even_points(row)
			shares = [1.0 / len(times)] * len(times)
			placements.append((times, shares, shares))
	owned = []
	if users and rows:
		candidates = [index for index, row in enumerate(rows) if not row.task] or list(range(len(rows)))
		dominant = max(candidates, key=lambda index: (rows[index].tokens, rows[index].last_seen))
		for timestamp, size in users:
			# The reply to a message is the next assistant call; with none (failed or pending turn) the session's main model is the best guess.
			index = bisect.bisect_right(call_times, timestamp)
			if index < len(call_times):
				owned.append((timestamp, size, _owner_at(rows, candidates, call_times[index]), call_times[index] - timestamp))
			else:
				owned.append((timestamp, size, dominant, math.inf))
	return placements, owned


def _owner_at(rows, candidates, timestamp):
	"""Index of the usage row that most plausibly made the call at `timestamp` (containing window first, else nearest)."""
	def rank(index):
		row = rows[index]
		if row.first_seen <= timestamp <= row.last_seen:
			distance = 0.0
		else:
			distance = min(abs(timestamp - row.first_seen), abs(timestamp - row.last_seen))
		return (distance, -row.tokens)
	return min(candidates, key=rank)


def _round_preserving_sum(values):
	"""Largest-remainder rounding so an integer series still sums to the rounded float total."""
	floors = [math.floor(value) for value in values]
	shortfall = int(round(sum(values))) - sum(floors)
	if shortfall > 0:
		order = sorted(range(len(values)), key=lambda index: values[index] - floors[index], reverse=True)
		for index in order[:shortfall]:
			floors[index] += 1
	return [int(value) for value in floors]


def _render(days, tz, now, buckets, series, missing):
	width = len(buckets)
	by_model = []
	providers = {}
	for (provider, model), data in series.items():
		arrays = {name: _round_preserving_sum([max(0.0, value) for value in data.values[name]]) for name in (*TOKEN_CLASSES, "reasoning")}
		arrays["tokens"] = [sum(arrays[name][index] for name in TOKEN_CLASSES) for index in range(width)]
		cost = [max(0.0, value) for value in data.values["cost_usd"]]
		users = list(data.user_messages)
		if not any(arrays["tokens"]) and not any(users) and not any(round(value, 6) for value in cost):
			continue
		label = provider or "unknown"
		entry = {"key": f"{label}/{model}", "label": model, "provider": label, "model": model}
		for name in ("tokens", *TOKEN_CLASSES, "reasoning"):
			entry[name] = arrays[name]
		entry["cost_usd"] = cost
		entry["user_messages"] = users
		by_model.append(entry)
		bucket = providers.setdefault(label, {"key": label, "label": label, "provider": label, "model": None, **{name: [0] * width for name in ("tokens", *TOKEN_CLASSES, "reasoning")}, "cost_usd": [0.0] * width, "user_messages": [0] * width})
		# Provider series are sums of the already-rounded model series so the two views always agree to the token.
		for name in ("tokens", *TOKEN_CLASSES, "reasoning", "user_messages"):
			bucket[name] = [left + right for left, right in zip(bucket[name], entry[name])]
		bucket["cost_usd"] = [left + right for left, right in zip(bucket["cost_usd"], cost)]
	by_provider = list(providers.values())
	for entry in (*by_model, *by_provider):
		entry["cost_usd"] = [round(value, 6) for value in entry["cost_usd"]]

	def order(entry):
		return (-sum(entry["tokens"]), entry["key"])

	by_model.sort(key=order)
	by_provider.sort(key=order)
	return {
		"generated_at": now,
		"days": days,
		"tz": tz,
		"resolution": "hour" if days == 1 else "day",
		"buckets": [int(round(value)) for value in buckets],
		"by_provider": by_provider,
		"by_model": by_model,
		"totals": {
			"tokens": sum(sum(entry["tokens"]) for entry in by_provider),
			"cost_usd": round(sum(sum(entry["cost_usd"]) for entry in by_provider), 6),
			"user_messages": sum(sum(entry["user_messages"]) for entry in by_provider),
		},
		"pricing_missing": sorted(missing),
		"approximate": True,
	}
