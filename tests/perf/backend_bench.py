#!/usr/bin/env python3
"""Backend performance regression gate on scratch SQLite fixtures only.

Run (same interpreter resolution as `npm run test:backend`):
	python -W error::ResourceWarning tests/perf/backend_bench.py [--samples 15] [--baseline <git-ref>] [--update-budgets] [--allow-output-change]

Statement counts are the primary, machine-independent gate; wall-clock budgets in backend-budgets.json are deliberately generous so only catastrophic regressions trip on a noisy machine. `--baseline` compares interleaved against another revision on identical fixtures, which is the precise check for a single change. Nothing here reads or writes live Hermes profile storage: every database is created under $TMPDIR and the native listing adapter is patched to open only that scratch file read-only.
"""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AGENT_ROOT = Path(os.environ.get("HERMES_AGENT_ROOT", Path.home() / ".hermes" / "hermes-agent"))

# hermes_bootstrap must be the first Hermes import: it may os.execv into the managed interpreter, and plugin modules importing fastapi before it fail with "No module named 'fastapi'". The PATH python used by `npm run test:backend` already finds it; a bare interpreter needs the agent checkout on sys.path.
try:
	import hermes_bootstrap  # noqa: F401
except ModuleNotFoundError:
	sys.path.insert(0, str(AGENT_ROOT))
	import hermes_bootstrap  # noqa: F401,E402

import argparse  # noqa: E402
from contextlib import closing, contextmanager, ExitStack  # noqa: E402
import gc  # noqa: E402
import hashlib  # noqa: E402
import importlib.util  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import platform  # noqa: E402
import random  # noqa: E402
import sqlite3  # noqa: E402
import statistics  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402
import time  # noqa: E402
from unittest.mock import patch  # noqa: E402

for _path in (str(AGENT_ROOT), str(ROOT / "tests")):
	if _path not in sys.path:
		sys.path.append(_path)

SCRATCH = Path(os.environ.get("TMPDIR") or tempfile.gettempdir())
OUT_DIR = SCRATCH / "t3sidebar-perf"
BUDGETS_PATH = Path(__file__).resolve().with_name("backend-budgets.json")
# Fixed clock: buckets, windows, snooze deadlines and therefore statement counts must not drift with the wall clock.
NOW = 1_800_000_000.0
DAY = 86400.0
PROFILE = "t3sidebar-bench"
# Timing budgets are this many times the measured median, never below the floor, so a tiny read cannot trip on scheduler noise.
BUDGET_FACTOR = 4.0
BUDGET_FLOOR_MS = 5.0


def bench_price(provider, model, usage):
	# Deterministic linear prices keep usage-history timings independent of Hermes's pricing catalog, which can load data lazily and differ between installs. One module-level function so the history cache key stays stable across calls.
	return (usage["input_tokens"] * 3e-6 + usage["output_tokens"] * 15e-6
		+ usage["cache_read_tokens"] * 3e-7 + usage["cache_write_tokens"] * 3.75e-6)


# ─── Fixtures ───


class Fixtures:
	"""One scratch tree shared by every implementation so baseline and candidate read byte-identical data."""

	def __init__(self, root: Path):
		self.root = root
		self.home = root / "home"
		self.native = self.home / "state.db"
		self.metadata = self.home / "plugin-data" / "hermes-t3sidebar" / "state.sqlite3"
		self.limits = self.home / "plugin-data" / "hermes-t3sidebar" / "usage-limits.sqlite3"
		self.regular = [f"regular-{i:04d}" for i in range(500)]
		self.archived = [f"archive-{i:04d}" for i in range(500)]
		self.home.mkdir(parents=True)

	def build(self, plugin_api):
		started = time.perf_counter()
		self._native()
		self._metadata(plugin_api)
		self._limits(plugin_api.usage_limits)
		self.native_digest = digest(self.native)
		return time.perf_counter() - started

	def _native(self):
		"""500 regular + 500 archived conversations, 50 compression chains on each side, 1000 delegated children, messages and usage rows: the shape that made organized backfill and usage history expensive."""
		from hermes_state import SessionDB

		rng = random.Random(20261104)
		sessions, messages, usage, chains = [], [], [], []
		models = [("openai-codex", "gpt-5.5"), ("anthropic", "claude-opus-4-6"), ("openai-codex", "gpt-5.4-mini")]

		def started_at(index, total):
			# Quadratic recency skew: roughly a fifth of conversations fall in the last day, so the 1-day Usage window is not empty and 30 days covers nearly everything.
			return NOW - 30 * DAY * (index / total) ** 2 - 60.0

		def conversation(sid, start, source, archived=0, parent=None, end_reason=None, config=None, turns=None):
			turns = turns if turns is not None else rng.randint(4, 18)
			t = start
			count = 0
			provider, model = models[rng.randrange(len(models))]
			calls = in_tokens = out_tokens = 0
			for _ in range(turns):
				messages.append((sid, "user", "u" * rng.randint(20, 600), None, t, None))
				t += rng.uniform(2, 20)
				for _ in range(rng.randint(1, 3)):
					size = rng.randint(50, 3000)
					tool_calls = "c" * rng.randint(40, 400) if rng.random() < .5 else None
					messages.append((sid, "assistant", "a" * size, tool_calls, t, "r" * rng.randint(0, 800)))
					calls += 1
					in_tokens += rng.randint(2000, 60000)
					out_tokens += size // 3
					t += rng.uniform(1, 30)
					if tool_calls:
						messages.append((sid, "tool", "t" * rng.randint(30, 4000), None, t, None))
						t += rng.uniform(.5, 5)
				count += 1
			first, last = start + 2, t
			usage.append((sid, model, provider, "", calls, in_tokens // 4, out_tokens, in_tokens * 3 // 4, in_tokens // 20, out_tokens // 5, first, last))
			if rng.random() < .3:
				usage.append((sid, "gpt-5.4-mini", "openai-codex", "title_generation", 1, 800, 20, 0, 0, 0, first + 5, first + 5))
			# message_count is filled from the inserted rows afterwards, as the native writer keeps it.
			sessions.append((sid, source, start, archived, parent, end_reason, json.dumps(config) if config else None,
				f"/work/project-{rng.randrange(25)}", in_tokens // 4, out_tokens, 0, model, provider, f"Session {sid}", last))

		total = 1000
		for index, sid in enumerate(self.regular):
			conversation(sid, started_at(2 * index, total), "cli" if index % 3 else "desktop")
		for index, sid in enumerate(self.archived):
			conversation(sid, started_at(2 * index + 1, total), "cli", archived=1)
		# Compression chains: a root that ended in compression plus a tip continuing it. Archived chains are archived through the native lineage writer below, the way Desktop archives them.
		for side, ids in (("regular", self.regular), ("archive", self.archived)):
			for i in range(50):
				root, tip = f"{side}-root-{i:03d}", f"{side}-tip-{i:03d}"
				start = started_at(rng.randrange(total), total) - 3600
				conversation(root, start, "cli", end_reason="compression", turns=6)
				conversation(tip, start + 1800, "cli", parent=root, turns=4)
				if side == "archive":
					chains.append(tip)
		# Delegated subagent rows hang below conversations; listings hide them by the _delegate_from marker and card usage sums them recursively.
		parents = self.regular + self.archived
		for i in range(1000):
			parent = parents[(i * 7) % len(parents)]
			conversation(f"delegate-{i:04d}", NOW - rng.uniform(0, 30 * DAY), "subagent" if i % 2 else "cli",
				parent=parent, config={"_delegate_from": parent}, turns=rng.randint(1, 3))
		self.chain_tips = chains
		self.counts = {"sessions": len(sessions), "messages": len(messages), "usage_rows": len(usage)}

		# Seed compact columns directly, avoiding lifecycle hooks and plugin notifications; only the archive flip uses the native writer, with notify=False so the real profile's plugins are never loaded.
		with closing(SessionDB(self.native)) as db:
			conn = db._conn
			assert conn is not None
			# The native connection is in autocommit mode, where `with conn:` opens no transaction and every inserted row would pay its own fsync; one explicit transaction keeps the build to seconds.
			conn.execute("BEGIN IMMEDIATE")
			try:
				conn.executemany("""INSERT INTO sessions(id, source, started_at, archived, parent_session_id, end_reason, model_config, cwd,
					input_tokens, output_tokens, message_count, model, billing_provider, title, last_activity_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", sessions)
				conn.executemany("INSERT INTO messages(session_id, role, content, tool_calls, timestamp, reasoning) VALUES (?, ?, ?, ?, ?, ?)", messages)
				conn.executemany("""INSERT INTO session_model_usage(session_id, model, billing_provider, task, api_call_count, input_tokens, output_tokens,
					cache_read_tokens, cache_write_tokens, reasoning_tokens, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", usage)
				conn.execute("UPDATE sessions SET message_count = (SELECT COUNT(*) FROM messages m WHERE m.session_id = sessions.id)")
				conn.execute("COMMIT")
			except BaseException:
				conn.execute("ROLLBACK")
				raise
			for tip in chains:
				assert db.set_session_archived(tip, True, notify=False)
		# Fold the WAL into the main file once every native connection is closed, so the read-only digest check below covers all fixture data.
		with closing(sqlite3.connect(self.native)) as connection:
			connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")

	def _metadata(self, plugin_api):
		"""~1000 organized sessions (active, pinned, settled, future snoozes) plus completion markers and runs; nothing is due, so state() stays on the read-only fast path."""
		store = plugin_api.HermesT3SidebarStore(self.metadata, lambda: NOW)
		# One real mutation creates the current schema through production code; bulk rows follow in one transaction.
		store.mutate(self.regular[0], plugin_api.SessionAction(action="pin"))
		ids = self.regular[1:] + self.archived
		rows = []
		for index, sid in enumerate(ids):
			kind = index % 7
			if kind in (0, 1):
				rows.append((sid, "settled", NOW - index, None, 0, NOW - index, None))
			elif kind == 2:
				rows.append((sid, "snoozed", None, NOW + 3600 + index, 0, NOW - index, None))
			else:
				rows.append((sid, "active", None, None, int(kind == 3), NOW - index, None))
		with closing(sqlite3.connect(self.metadata)) as connection, connection:
			connection.executemany("INSERT INTO session_metadata(session_id, state, settled_at, wake_at, pinned, updated_at, woke_at) VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
			connection.executemany("INSERT INTO session_completions(session_id, done_at, done_token) VALUES (?, ?, ?)",
				[(sid, NOW - i, f"turn-{i}") for i, sid in enumerate(self.regular[:300])])
			connection.executemany("INSERT INTO completion_receipts(session_id, turn_id) VALUES (?, ?)",
				[(sid, f"turn-{i}") for i, sid in enumerate(self.regular[:300])])
			connection.executemany("INSERT INTO session_runs(session_id, started_at, ended_at, turn_id, pending) VALUES (?, ?, ?, ?, ?)",
				[(sid, NOW - 600 - i, None if i % 4 else NOW - i, f"run-{i}", int(i % 5 == 0)) for i, sid in enumerate(self.regular[:200])])
		self.metadata_ids = (self.regular[0], *ids)

	def _limits(self, limits):
		"""Five Codex accounts and Claude Code, ten days of 15-minute samples (~13k rows) with realistic step changes, error streaks and banked credits."""
		store = limits.LimitsStore(self.limits, clock=lambda: NOW)
		# A real record() creates the schema and WAL mode through production code.
		store.record([], checked_at=NOW - 10 * DAY)
		accounts: list[tuple[str, str, str, int, str, list[tuple[str, str, int, str, str | None]]]] = [("openai-codex", f"codex-{i}", f"codex-{i}", i, "pro" if i else "team",
			[("five_hour", "Session", 18000, "account", None), ("weekly", "Weekly", 604800, "account", None)]) for i in range(5)]
		accounts.append(("anthropic", "claude-code", "Claude Code", 0, "default_claude_max_20x",
			[("five_hour", "Current session", 18000, "account", None), ("weekly", "Current week", 604800, "account", None),
			("weekly:opus", "Current week (Opus)", 604800, "model", "opus")]))
		rows = []
		ticks = int(10 * DAY // 900)
		for provider, account_id, label, priority, plan, windows in accounts:
			for tick in range(ticks):
				t = NOW - (ticks - tick) * 900 + 30
				# Readings change every few ticks, the way the provider's percentages move, so history compaction keeps a realistic fraction of samples.
				if account_id == "codex-4" and 300 <= tick < 320:
					if tick == 300:
						rows.append((t, provider, account_id, label, priority, None, None, None, None, None, None, None, None, None, "refresh_failed"))
					continue
				for key, window_label, seconds, scope, model in windows:
					period = seconds / 900
					phase = (tick % period) / period
					used = round(min(100.0, phase * (60 + 7 * priority) + (tick // 3 % 4)), 1)
					resets = t - (tick % period) * 900 + seconds
					rows.append((t, provider, account_id, label, priority, plan, 2 if provider == "openai-codex" else None,
						key, window_label, seconds, scope, model, used, resets, None))
		credits = json.dumps([{"status": "available", "granted_at": NOW - 5 * DAY, "expires_at": NOW + 20 * DAY},
			{"status": "available", "granted_at": NOW - 2 * DAY, "expires_at": NOW + 27 * DAY}, {"status": "redeemed", "granted_at": NOW - 9 * DAY, "expires_at": None}])
		with closing(sqlite3.connect(self.limits)) as connection, connection:
			connection.executemany("""INSERT INTO limit_samples(t, provider, account_id, account_label, priority, plan, banked_resets, window_key,
				window_label, window_seconds, scope, model, used_percent, resets_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", rows)
			connection.executemany("INSERT INTO limit_provider_status(provider, checked_at, error) VALUES (?, ?, NULL)", [("openai-codex", NOW - 60), ("anthropic", NOW - 60)])
			connection.executemany("INSERT INTO limit_credits(provider, account_id, credits_fetched_at, credits_json, applicable_count) VALUES (?, ?, ?, ?, ?)",
				[("openai-codex", f"codex-{i}", NOW - 1800, credits, i % 2) for i in range(5)])
		store.write_status({"interval_s": 300.0, "started_at": NOW - 10 * DAY, "last_run_at": NOW - 60, "last_error": None})
		self.limit_rows = len(rows)


def digest(path):
	sha = hashlib.sha256()
	with open(path, "rb") as handle:
		for block in iter(lambda: handle.read(1 << 20), b""):
			sha.update(block)
	return sha.hexdigest()


# ─── Implementations under test ───


class Impl:
	"""The plugin's backend modules loaded from one source tree under a unique module name, exactly as Hermes loads dashboard/plugin_api.py via importlib."""

	def __init__(self, label, root: Path):
		self.label = label
		self.root = root
		name = f"t3sidebar_bench_{label}_{hashlib.sha256(str(root).encode()).hexdigest()[:10]}_plugin_api"
		spec = importlib.util.spec_from_file_location(name, root / "dashboard" / "plugin_api.py")
		assert spec is not None and spec.loader is not None
		module = importlib.util.module_from_spec(spec)
		sys.modules[name] = module
		spec.loader.exec_module(module)
		self.api = module
		# Older revisions may predate a module; their scenarios are reported as skipped rather than failing the comparison.
		self.history = getattr(module, "usage_history", None)
		self.limits = getattr(module, "usage_limits", None)


def scenarios(fx: Fixtures):
	"""(name, description, needs(impl) -> bool, prepare(impl) -> callable, reset(impl) | None). Reset runs untimed before every sample."""

	def metadata(impl):
		store = impl.api.HermesT3SidebarStore(fx.metadata, lambda: NOW)
		return store.state

	def listing(organized):
		def prepare(impl):
			return lambda: impl.api.native_sessions(PROFILE, 0, 500, organized)
		return prepare

	def archives(impl):
		return lambda: impl.api.native_archives(PROFILE, 0, 500)

	def history(days):
		def prepare(impl):
			return lambda: impl.history.history_payload(fx.native, days=days, tz="Europe/Paris", now=NOW, pricing=bench_price)
		return prepare

	def history_cold(impl):
		impl.history.clear_cache()

	def history_layouts_only(impl):
		# A poll after new activity misses the payload cache (the change marker moved) but keeps per-session layouts; drop only the payload cache to measure that path.
		with impl.history._cache_lock:
			impl.history._cache.clear()

	def limits(hours):
		def prepare(impl):
			store = impl.limits.LimitsStore(fx.limits, clock=lambda: NOW)
			return lambda: impl.limits.limits_payload(store, hours=hours, now=NOW, sampler_status=None)
		return prepare

	has_api = lambda impl: True  # noqa: E731
	has_history = lambda impl: impl.history is not None  # noqa: E731
	has_layouts = lambda impl: impl.history is not None and hasattr(impl.history, "_layouts")  # noqa: E731
	has_limits = lambda impl: impl.limits is not None  # noqa: E731
	result = [
		("metadata_state", "HermesT3SidebarStore.state(), 1000 organized + 300 done + 200 runs, no due snooze", has_api, metadata, None),
		("native_sessions_plain", "native_sessions 500-card page, no organized IDs", has_api, listing(()), None),
		("native_sessions_loaded_ids", "native_sessions with the 1000 metadata IDs (500 on the page, 500 archived)", has_api, listing(fx.metadata_ids), None),
		("native_sessions_archived_ids", "native_sessions with 500 retained archived organized IDs", has_api, listing(tuple(fx.archived)), None),
		("native_archives", "native_archives 500-card page", has_api, archives, None),
	]
	for days in (1, 7, 30):
		result.append((f"usage_history_{days}d_cold", f"history_payload days={days}, caches cleared", has_history, history(days), history_cold))
	result.append(("usage_history_7d_layouts", "history_payload days=7, payload cache missed, per-session layouts warm", has_layouts, history(7), history_layouts_only))
	for days in (1, 7, 30):
		result.append((f"usage_history_{days}d_cached", f"history_payload days={days}, payload cache hit", has_history, history(days), None))
	for hours in (168, 840):
		result.append((f"usage_limits_{hours}h", f"limits_payload hours={hours}, 6 accounts x 10 days of 15-min samples", has_limits, limits(hours), None))
	return result


# ─── Measurement ───


@contextmanager
def traced_statements():
	"""Count every SQL statement on every connection opened meanwhile, the way test_backend_performance.py does; trace callbacks see BEGIN/COMMIT and internal schema reads too, so counts are exact and deterministic."""
	statements = []
	connect = sqlite3.connect

	def traced(*args, **kwargs):
		connection = connect(*args, **kwargs)
		connection.set_trace_callback(statements.append)
		return connection

	with patch.object(sqlite3, "connect", traced):
		yield statements


def timed(fn, reset, impl):
	if reset is not None:
		reset(impl)
	gc.collect()
	started = time.perf_counter()
	value = fn()
	return (time.perf_counter() - started) * 1000.0, value


def percentile(values, fraction):
	# Nearest-rank, matching the earlier docs/performance.md reports.
	ordered = sorted(values)
	return ordered[max(0, math.ceil(fraction * len(ordered)) - 1)]


def summarize(samples):
	return {"median_ms": round(statistics.median(samples), 3), "p95_ms": round(percentile(samples, .95), 3),
		"min_ms": round(min(samples), 3), "samples_ms": [round(value, 3) for value in samples]}


def comparable(value):
	# generated_at echoes the request clock and differs by construction.
	if isinstance(value, dict):
		value = {k: v for k, v in value.items() if k != "generated_at"}
	return json.dumps(value, sort_keys=True, default=str)


def select_scenarios(names, only):
	"""Names selected by the --only substrings. A token that matches nothing would silently measure less and still pass, so it is an error, as is a blank one, which would match everything."""
	if any(not token.strip() for token in only):
		raise ValueError("--only needs a non-blank scenario substring")
	unknown = [token for token in only if not any(token in name for name in names)]
	if unknown:
		raise ValueError(f"--only {', '.join(unknown)} matches no scenario (known: {', '.join(names)})")
	return [name for name in names if not only or any(token in name for token in only)]


def output_difference(baseline, candidate):
	"""Path and values of the first difference between two comparable() outputs, so a failing parity gate says where the output changed."""
	def walk(a, b, path):
		if type(a) is not type(b):
			return f"{path}: {type(a).__name__} in baseline, {type(b).__name__} in candidate"
		if isinstance(a, dict):
			for key in sorted(set(a) | set(b)):
				if key not in b:
					return f"{path}.{key}: only in baseline"
				if key not in a:
					return f"{path}.{key}: only in candidate"
				found = walk(a[key], b[key], f"{path}.{key}")
				if found:
					return found
			return None
		if isinstance(a, list):
			for index, (left, right) in enumerate(zip(a, b)):
				found = walk(left, right, f"{path}[{index}]")
				if found:
					return found
			return None if len(a) == len(b) else f"{path}: {len(a)} items in baseline, {len(b)} in candidate"
		return None if a == b else f"{path}: {a!r} in baseline, {b!r} in candidate"[:300]
	return walk(json.loads(baseline), json.loads(candidate), "$")


def run_scenarios(fx, impls, warmup, samples, only):
	results = {}
	listed = scenarios(fx)
	selected = set(select_scenarios([item[0] for item in listed], only))
	for name, description, needs, prepare, reset in listed:
		if name not in selected:
			continue
		active = [impl for impl in impls if needs(impl)]
		entry = {"description": description, "impls": {}}
		results[name] = entry
		for impl in impls:
			if impl not in active:
				entry["impls"][impl.label] = {"skipped": "module or seam absent in this revision"}
		if not active:
			continue
		calls = {}
		for impl in list(active):
			try:
				calls[impl.label] = prepare(impl)
				timed(calls[impl.label], reset, impl)
			except Exception as exc:
				# An old baseline can be incompatible with the installed Hermes; report it instead of aborting the comparison. The candidate must always work.
				if impl.label == "candidate":
					raise
				active.remove(impl)
				entry["impls"][impl.label] = {"skipped": f"{type(exc).__name__}: {exc}"[:300]}
		times = {impl.label: [] for impl in active}
		for index in range(warmup + samples):
			# Alternate order each round so cache warmth and CPU frequency drift do not systematically favour one side.
			order = active if index % 2 == 0 else list(reversed(active))
			for impl in order:
				elapsed, _ = timed(calls[impl.label], reset, impl)
				if index >= warmup:
					times[impl.label].append(elapsed)
		outputs = {}
		for impl in active:
			# One extra traced call: tracing overhead stays out of the timed samples.
			if reset is not None:
				reset(impl)
			with traced_statements() as statements:
				value = calls[impl.label]()
			outputs[impl.label] = comparable(value)
			entry["impls"][impl.label] = {**summarize(times[impl.label]), "statements": len(statements),
				"statement_kinds": statement_kinds(statements)}
		if len(outputs) > 1:
			entry["same_output"] = len(set(outputs.values())) == 1
			if not entry["same_output"]:
				reference = next(label for label in outputs if label != "candidate")
				entry["output_difference"] = output_difference(outputs[reference], outputs["candidate"])
		sys.stderr.write(f"  {name}: " + ", ".join(f"{label} {entry['impls'][label]['median_ms']:.2f} ms" for label in outputs) + "\n")
	return results


def statement_kinds(statements):
	kinds = {}
	for sql in statements:
		word = (sql.split() or ["?"])[0].upper()
		kinds[word] = kinds.get(word, 0) + 1
	return dict(sorted(kinds.items()))


# ─── Gates ───


def load_budgets(path):
	if not path.is_file():
		return {}
	return json.loads(path.read_text(encoding="utf-8")).get("scenarios", {})


def nice_ceiling(value):
	# Round budgets up to readable numbers so regenerated files do not churn on every run.
	if value <= 20:
		return float(math.ceil(value))
	if value <= 200:
		return float(math.ceil(value / 5) * 5)
	return float(math.ceil(value / 25) * 25)


def apply_gates(results, budgets, candidate, baseline, ratio, min_delta_ms, timing_gate, allow_output_change=False):
	failures = []
	if not results:
		failures.append("no scenario was measured")
	for name, entry in results.items():
		measured = entry["impls"].get(candidate)
		# Only an old baseline may lack a module or seam; a candidate that skips a selected scenario has not been measured.
		if not measured or "skipped" in measured:
			failures.append(f"{name}: the candidate did not run it ({measured['skipped'] if measured else 'not measured'})")
			entry["status"] = ["SKIPPED"]
			continue
		budget = budgets.get(name)
		status = []
		if budget is None:
			failures.append(f"{name}: no budget entry (run with --update-budgets after reviewing the numbers)")
			status.append("NO-BUDGET")
		else:
			if measured["statements"] > budget["statements"]:
				failures.append(f"{name}: {measured['statements']} SQL statements > budget {budget['statements']}")
				status.append("STMT")
			if timing_gate and measured["median_ms"] > budget["median_ms"]:
				failures.append(f"{name}: median {measured['median_ms']:.2f} ms > budget {budget['median_ms']:.0f} ms")
				status.append("TIME")
		base = entry["impls"].get(baseline) if baseline else None
		if base and "skipped" not in base:
			if measured["statements"] > base["statements"]:
				failures.append(f"{name}: {measured['statements']} SQL statements vs baseline {base['statements']}")
				status.append("AB-STMT")
			if timing_gate and measured["median_ms"] > base["median_ms"] * ratio and measured["median_ms"] > base["median_ms"] + min_delta_ms:
				failures.append(f"{name}: median {measured['median_ms']:.2f} ms vs baseline {base['median_ms']:.2f} ms (> x{ratio} and > +{min_delta_ms} ms)")
				status.append("AB-TIME")
		# A faster implementation that drops rows or fields must not pass; an intended contract change says so explicitly.
		if entry.get("same_output") is False and not allow_output_change:
			failures.append(f"{name}: output differs from the baseline at {entry.get('output_difference')} (pass --allow-output-change if the change is intended)")
			status.append("OUTPUT")
		entry["status"] = status or ["ok"]
	return failures


def baseline_skips(results, baseline):
	"""Scenarios the baseline revision could not run, reported so that a missing comparison is never silent."""
	if not baseline:
		return []
	return [f"{name}: baseline skipped ({entry['impls'][baseline]['skipped']})" for name, entry in results.items()
		if "skipped" in entry["impls"].get(baseline, {})]


def table(results, budgets, candidate, baseline):
	header: tuple[str, ...]
	if baseline:
		header = ("scenario", "base med", "cand med", "delta", "cand p95", "base stmt", "cand stmt", "budget", "same", "status")
	else:
		header = ("scenario", "median ms", "p95 ms", "budget ms", "stmts", "budget", "status")
	rows: list[tuple[str, ...]] = [header]
	for name, entry in results.items():
		cand = entry["impls"].get(candidate, {})
		budget = budgets.get(name, {})
		status = ",".join(entry.get("status", ["-"]))
		if "skipped" in cand:
			rows.append((name, *["-"] * (len(header) - 2), "skipped"))
			continue
		if baseline:
			base = entry["impls"].get(baseline, {})
			if "skipped" in base:
				rows.append((name, "-", f"{cand['median_ms']:.2f}", "-", f"{cand['p95_ms']:.2f}", "-", str(cand["statements"]),
					str(budget.get("statements", "-")), "-", status))
				continue
			delta = (cand["median_ms"] - base["median_ms"]) / base["median_ms"] * 100 if base["median_ms"] else 0.0
			rows.append((name, f"{base['median_ms']:.2f}", f"{cand['median_ms']:.2f}", f"{delta:+.1f}%", f"{cand['p95_ms']:.2f}",
				str(base["statements"]), str(cand["statements"]), str(budget.get("statements", "-")),
				"yes" if entry.get("same_output") else "NO", status))
		else:
			rows.append((name, f"{cand['median_ms']:.2f}", f"{cand['p95_ms']:.2f}", f"{budget['median_ms']:.0f}" if budget else "-",
				str(cand["statements"]), str(budget.get("statements", "-")), status))
	widths = [max(len(row[i]) for row in rows) for i in range(len(header))]
	lines = []
	for index, row in enumerate(rows):
		lines.append("  ".join(cell.ljust(widths[i]) if i == 0 else cell.rjust(widths[i]) for i, cell in enumerate(row)))
		if index == 0:
			lines.append("  ".join("-" * width for width in widths))
	return "\n".join(lines)


def write_budgets(path, results, candidate, existing, samples):
	merged = dict(existing)
	for name, entry in results.items():
		measured = entry["impls"].get(candidate)
		if not measured or "skipped" in measured:
			continue
		merged[name] = {"statements": measured["statements"],
			"median_ms": max(BUDGET_FLOOR_MS, nice_ceiling(measured["median_ms"] * BUDGET_FACTOR)),
			"measured_median_ms": measured["median_ms"]}
	document = {
		"_comment": f"Statement counts are exact upper bounds (machine-independent, primary gate). median_ms is {BUDGET_FACTOR:g}x the measured median, floor {BUDGET_FLOOR_MS:g} ms, so only catastrophic regressions trip on a noisy machine. Regenerate with tests/perf/backend_bench.py --update-budgets after reviewing a change.",
		"generated": {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "git": git_describe(ROOT, "HEAD"), "samples": samples,
			"python": platform.python_version(), "sqlite": sqlite3.sqlite_version, "machine": platform.machine()},
		"scenarios": dict(sorted(merged.items())),
	}
	path.write_text(json.dumps(document, indent="\t") + "\n", encoding="utf-8")


# ─── Baseline checkout ───


def default_baseline():
	# Same rule as tests/perf/browser-bench.mjs, so `npm run perf:all` compares both sides against one revision.
	def git(*argv):
		return subprocess.run(["git", "-C", str(ROOT), *argv], check=True, capture_output=True, text=True).stdout.strip()
	try:
		if git("rev-parse", "--abbrev-ref", "HEAD") != "main":
			return git("merge-base", "HEAD", "main")
		return "HEAD" if git("status", "--porcelain", "--", "*.py", "dashboard") else None
	except subprocess.CalledProcessError:
		return None


def git_describe(root, ref):
	try:
		sha = subprocess.run(["git", "-C", str(root), "rev-parse", "--short", ref], check=True, capture_output=True, text=True).stdout.strip()
		dirty = subprocess.run(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=no"], check=True, capture_output=True, text=True).stdout.strip()
		return sha + ("-dirty" if ref == "HEAD" and dirty else "")
	except (OSError, subprocess.CalledProcessError):
		return None


def extract_ref(ref, destination: Path):
	"""Only tracked Python sources of <ref>; the candidate keeps running from the working tree."""
	destination.mkdir(parents=True)
	archive = subprocess.Popen(["git", "-C", str(ROOT), "archive", "--format=tar", ref, "--", ":(glob)**/*.py"], stdout=subprocess.PIPE)
	assert archive.stdout is not None
	try:
		subprocess.run(["tar", "-x", "-C", str(destination)], stdin=archive.stdout, check=True)
	finally:
		archive.stdout.close()
		if archive.wait() != 0:
			raise SystemExit(f"git archive {ref} failed")
	if not (destination / "dashboard" / "plugin_api.py").is_file():
		raise SystemExit(f"{ref} has no dashboard/plugin_api.py")


# ─── Entry point ───


def main(argv=None):
	parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
	parser.add_argument("--samples", type=int, default=int(os.environ.get("T3_PERF_SAMPLES", 15)), help="timed samples per scenario (env T3_PERF_SAMPLES, default 15)")
	parser.add_argument("--warmup", type=int, default=int(os.environ.get("T3_PERF_WARMUP", 3)), help="untimed warmup runs (env T3_PERF_WARMUP, default 3)")
	parser.add_argument("--baseline", metavar="GIT_REF", help="also run this revision interleaved on the same fixtures and gate the candidate against it; 'none' skips it (default: merge base with main on a branch, HEAD for uncommitted backend changes on main, else none)")
	parser.add_argument("--ab-ratio", type=float, default=float(os.environ.get("T3_PERF_AB_RATIO", 1.25)), help="A/B fails when candidate median > baseline x ratio ... (default 1.25)")
	parser.add_argument("--ab-min-ms", type=float, default=float(os.environ.get("T3_PERF_AB_MIN_MS", 2.0)), help="... and > baseline + this many ms (default 2)")
	parser.add_argument("--only", action="append", default=[], metavar="SUBSTRING", help="run only scenarios whose name contains this (repeatable)")
	parser.add_argument("--budgets", type=Path, default=BUDGETS_PATH)
	parser.add_argument("--update-budgets", action="store_true", help="rewrite the budget file from this run (exact counts, timings x4) instead of gating on it")
	parser.add_argument("--no-timing-gate", action="store_true", help="gate on statement counts only (for very noisy or shared machines)")
	parser.add_argument("--allow-output-change", action="store_true", help="do not fail when the candidate's output differs from the baseline's (an intended contract change)")
	args = parser.parse_args(argv)
	if args.samples < 1 or args.warmup < 0:
		parser.error("--samples must be >= 1 and --warmup >= 0")
	args.baseline = None if args.baseline == "none" else args.baseline or default_baseline()

	OUT_DIR.mkdir(parents=True, exist_ok=True)
	stamp = time.strftime("%Y%m%d-%H%M%S")
	with ExitStack() as stack:
		scratch = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="bench-", dir=OUT_DIR)))
		fx = Fixtures(scratch / "fixtures")
		# Any home lookup during the run resolves to scratch, never the live profile.
		os.environ["HERMES_HOME"] = str(fx.home)
		impls = [Impl("candidate", ROOT)]
		baseline_label = None
		if args.baseline:
			baseline_root = scratch / "baseline"
			extract_ref(args.baseline, baseline_root)
			baseline_label = "baseline"
			impls.insert(0, Impl(baseline_label, baseline_root))
		from hermes_state import SessionDB

		sys.stderr.write("building fixtures...\n")
		build_s = fx.build(impls[-1].api)
		sys.stderr.write(f"  {fx.counts} + {fx.limit_rows} limit rows in {build_s:.1f} s\n")

		def open_db(profile, *, read_only):
			# The plugin only ever asks for read-only listings; refuse anything else so a regression cannot write to the fixture or reach a real profile.
			if profile != PROFILE or read_only is not True:
				raise AssertionError(f"unexpected native open: {profile!r} read_only={read_only!r}")
			return SessionDB(fx.native, read_only=True)

		stack.enter_context(patch("hermes_cli.web_server_sessions._open_session_db_for_profile", open_db))
		# Current builds open the store through their own public-SessionDB helper; older baselines through Hermes's.
		for impl in impls:
			if hasattr(impl.api, "open_session_db"):
				stack.enter_context(patch.object(impl.api, "open_session_db", open_db))
		try:
			select_scenarios([item[0] for item in scenarios(fx)], args.only)
		except ValueError as exc:
			parser.error(str(exc))
		sys.stderr.write(f"running {args.warmup} warmup + {args.samples} samples per scenario...\n")
		results = run_scenarios(fx, impls, args.warmup, args.samples, args.only)
		if digest(fx.native) != fx.native_digest:
			raise SystemExit("native fixture bytes changed during read-only scenarios")

	budgets = load_budgets(args.budgets)
	failures = apply_gates(results, budgets, "candidate", baseline_label, args.ab_ratio, args.ab_min_ms, not args.no_timing_gate, args.allow_output_change)
	if args.update_budgets:
		write_budgets(args.budgets, results, "candidate", budgets, args.samples)
		budgets = load_budgets(args.budgets)
		failures = apply_gates(results, budgets, "candidate", baseline_label, args.ab_ratio, args.ab_min_ms, not args.no_timing_gate, args.allow_output_change)
	skips = baseline_skips(results, baseline_label)
	report = {
		"generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
		"candidate": git_describe(ROOT, "HEAD"),
		"baseline": {"ref": args.baseline, "sha": git_describe(ROOT, args.baseline)} if args.baseline else None,
		"settings": {"samples": args.samples, "warmup": args.warmup, "ab_ratio": args.ab_ratio, "ab_min_ms": args.ab_min_ms,
			"timing_gate": not args.no_timing_gate, "allow_output_change": args.allow_output_change, "only": args.only},
		"environment": {"python": sys.version.split()[0], "executable": sys.executable, "sqlite": sqlite3.sqlite_version,
			"machine": platform.machine(), "cpus": os.cpu_count(), "loadavg": os.getloadavg() if hasattr(os, "getloadavg") else None},
		"fixtures": {**fx.counts, "limit_rows": fx.limit_rows, "metadata_ids": len(fx.metadata_ids), "build_s": round(build_s, 2)},
		"results": results,
		"baseline_skips": skips,
		"failures": failures,
	}
	out = OUT_DIR / f"backend-{stamp}.json"
	out.write_text(json.dumps(report, indent="\t") + "\n", encoding="utf-8")
	print(table(results, budgets, "candidate", baseline_label))
	print(f"\nraw: {out}")
	if args.update_budgets:
		print(f"budgets written: {args.budgets}")
	for skip in skips:
		print(f"SKIP {skip}")
	if failures:
		print("\nFAIL:\n  " + "\n  ".join(failures))
		return 1
	print("\nPASS")
	return 0


if __name__ == "__main__":
	sys.exit(main())
