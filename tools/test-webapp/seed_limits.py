"""Synthetic Limits history for the test Webapp container (tools/test-webapp), recorded through the plugin's own LimitsStore.

Runs inside that container only. Every account, label, plan and number is invented; nothing is read from a real Hermes. The simulation is a pure function of a fixed start time, so `follow` can recompute the curve each minute and append the newest sample, keeping the page fresh (the plugin marks readings older than 15 minutes as stale).

Usage: python seed_limits.py backfill   (wipe the plugin's limit tables, write 10 days of history up to now)
       python seed_limits.py follow     (append the current sample every minute, forever)
"""

import json
import math
import random
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, "/opt/data/plugins/hermes-t3sidebar")
from usage_limits import LimitsStore  # noqa: E402

STORE = Path("/opt/data/plugin-data/hermes-t3sidebar/usage-limits.sqlite3")
STATE = Path("/opt/data/demo/limits-start.json")
TZ = ZoneInfo("Europe/Paris")
STEP = 300
HISTORY_S = 10 * 86400
WEEK = 7 * 86400
FIVE_H = 5 * 3600

# Pool order is fill-first: the lowest priority number is drained before the next account is touched.
ACCOUNTS = [
	{"provider": "openai-codex", "id": "demo-codex-business", "label": "acme-business", "priority": 0, "plan": "team", "weekly_units": 20.0,
	 "labels": ("Session", "Weekly"), "weekly_anchor": (1, 8, 0), "credits": []},
	{"provider": "openai-codex", "id": "demo-codex-pro", "label": "personal-pro", "priority": 1, "plan": "prolite", "weekly_units": 100.0,
	 "labels": ("Session", "Weekly"), "weekly_anchor": (4, 13, 30), "credits": [26, 9]},
	{"provider": "anthropic", "id": "demo-claude-max", "label": "claude-max", "priority": 0, "plan": "default_claude_max_20x", "weekly_units": 200.0,
	 "labels": ("Current session", "Current week"), "weekly_anchor": (4, 18, 0), "credits": None},
]
# Units per active hour at full activity; Codex runs hot enough to empty its pool before the next reset, Claude leaves most of its week unused.
RATE = {"openai-codex": 3.8, "anthropic": 1.1}
FIVE_H_SHARE = 1 / 6.0


def activity(t):
	"""Share of a working hour spent with an agent: weekday office hours, quiet evenings and nights, light weekends, plus bursts."""
	local = datetime.fromtimestamp(t, TZ)
	hour = local.hour + local.minute / 60.0
	if local.weekday() >= 5:
		# A hackathon weekend: long afternoons and evenings, a short night.
		base = 0.7 if 10 <= hour < 24 or hour < 1.5 else 0.0
	elif 9 <= hour < 12 or 14 <= hour < 19:
		base = 1.0
	elif 12 <= hour < 14:
		base = 0.35
	elif 19 <= hour < 23:
		base = 0.3
	else:
		base = 0.0
	rng = random.Random(int(t // STEP))
	burst = 1.0 + 0.6 * math.sin(t / 2700.0) + rng.uniform(-0.35, 0.35)
	return max(0.0, base * burst)


def last_weekly_reset(t, anchor):
	"""Epoch of the most recent weekly reset at (weekday, hour, minute) Paris time, at or before *t*."""
	weekday, hour, minute = anchor
	local = datetime.fromtimestamp(t, TZ)
	day = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
	candidate = day.timestamp() - ((local.weekday() - weekday) % 7) * 86400
	if candidate > t:
		candidate -= WEEK
	return candidate


def simulate(start, until):
	"""Yield (t, readings) every STEP seconds from *start* to *until*."""
	state = {a["id"]: {"week_start": last_weekly_reset(start, a["weekly_anchor"]), "week_used": 0.0, "five_start": None, "five_used": 0.0} for a in ACCOUNTS}
	t = start
	while t <= until:
		for provider in RATE:
			# Recent days run a little hotter, so the projection crosses empty before the next reset.
			ramp = 1.0 + 0.35 * max(0.0, 1.0 - (until - t) / (3 * 86400))
			demand = RATE[provider] * ramp * activity(t) * STEP / 3600.0
			for account in sorted((a for a in ACCOUNTS if a["provider"] == provider), key=lambda a: a["priority"]):
				s = state[account["id"]]
				week_start = last_weekly_reset(t, account["weekly_anchor"])
				if week_start != s["week_start"]:
					s["week_start"], s["week_used"] = week_start, 0.0
				if s["five_start"] is not None and t >= s["five_start"] + FIVE_H:
					s["five_start"], s["five_used"] = None, 0.0
				five_cap = account["weekly_units"] * FIVE_H_SHARE
				room = min(account["weekly_units"] - s["week_used"], five_cap - s["five_used"])
				if demand <= 0 or room <= 0:
					continue
				take = min(demand, room)
				if s["five_start"] is None:
					s["five_start"] = t
				s["week_used"] += take
				s["five_used"] += take
				demand -= take
		yield t, readings_at(t, state)
		t += STEP


def readings_at(t, state):
	by_provider = {}
	for account in ACCOUNTS:
		s = state[account["id"]]
		five_cap = account["weekly_units"] * FIVE_H_SHARE
		five_label, week_label = account["labels"]
		windows = [
			{"key": "five_hour", "label": five_label, "window_seconds": FIVE_H, "scope": "account", "model": None,
			 "used_percent": round(min(100.0, 100.0 * s["five_used"] / five_cap), 1),
			 "resets_at": (s["five_start"] or t) + FIVE_H},
			{"key": "weekly", "label": week_label, "window_seconds": WEEK, "scope": "account", "model": None,
			 "used_percent": round(min(100.0, 100.0 * s["week_used"] / account["weekly_units"]), 1),
			 "resets_at": s["week_start"] + WEEK},
		]
		entry = {"id": account["id"], "label": account["label"], "priority": account["priority"],
		         "snapshot": {"fetched_at": t, "plan": account["plan"], "windows": windows}}
		if account["credits"] is not None:
			entry["snapshot"]["banked_resets"] = len(account["credits"])
			entry["snapshot"]["banked_applicable"] = 0
			# Each credit was granted N days ago and lives 30 days, so the oldest expires inside the chart's week ahead.
			entry["credits"] = [{"status": "available", "granted_at": t - days * 86400, "expires_at": t + (30 - days) * 86400} for days in account["credits"]]
		by_provider.setdefault(account["provider"], {"provider": account["provider"], "accounts": []})["accounts"].append(entry)
	return list(by_provider.values())


def start_time():
	if STATE.exists():
		return json.loads(STATE.read_text())["start"]
	start = (time.time() - HISTORY_S) // STEP * STEP
	STATE.parent.mkdir(parents=True, exist_ok=True)
	STATE.write_text(json.dumps({"start": start}))
	return start


def backfill():
	STATE.unlink(missing_ok=True)
	store = LimitsStore(STORE)
	# On a fresh container the plugin has not polled yet, so neither the folder nor the tables exist.
	STORE.parent.mkdir(parents=True, exist_ok=True)
	with sqlite3.connect(STORE) as connection:
		LimitsStore.ensure_schema(connection)
		for table in ("limit_samples", "limit_provider_status", "limit_credits"):
			connection.execute(f"DELETE FROM {table}")
	count = 0
	for t, readings in simulate(start_time(), time.time()):
		count += store.record(readings, checked_at=t)
	print(f"recorded {count} rows")


def follow():
	store = LimitsStore(STORE)
	while True:
		last = None
		for last in simulate(start_time(), time.time()):
			pass
		if last:
			store.record(last[1], checked_at=last[0])
		time.sleep(60)


if __name__ == "__main__":
	{"backfill": backfill, "follow": follow}[sys.argv[1]]()
