"""Synthetic session history for the Usage page of the test Webapp container (tools/test-webapp), written through Hermes's own SessionDB.

Runs inside that container only; every title, message and token count is invented. Sessions are spread over the past nine days on the same working rhythm as seed_limits.py, priced on models Hermes's price table knows, and archived so they fill the Archived shelf instead of the live list. Re-running replaces the sessions it recorded as written, and only those: a session made by hand in the container survives, whatever its model. A container seeded before that record existed keeps its earlier seed sessions, since nothing proves they are the seed's; they hold the seed's titles, so the seed lists them and changes nothing until they are deleted by hand.
"""

from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import random
import sqlite3
import sys
import time
from datetime import datetime
from zoneinfo import ZoneInfo

sys.path.insert(0, "/opt/hermes")
from hermes_state import SessionDB  # noqa: E402

TZ = ZoneInfo("Europe/Paris")
W = "/opt/data/workspace"
# One explicit store for finding the previous sessions and for writing the new ones, rather than whatever home SessionDB would resolve.
DB_PATH = Path("/opt/data/state.db")
# The ids the last run wrote, the only sessions a re-run deletes.
OWNED = Path("/opt/data/demo/seed_usage_ids.json")
ROUTES = [("gpt-5.6-sol", "openai-codex", 0.6), ("claude-opus-5-5", "anthropic", 0.35), ("claude-sonnet-5", "anthropic", 0.05)]
WORK = {
	"acme-shop": ["Add Apple Pay to checkout", "Fix cart total rounding on discounts", "Migrate product images to WebP", "Speed up the category page", "Gift card balance endpoint",
	              "Refactor price formatting helpers", "Add vitest coverage for cart", "Country-specific free shipping", "Fix flaky checkout e2e test", "Upgrade Vite to 7"],
	"infra": ["Rotate TLS certificates", "Add HPA for the shop deployment", "Investigate p95 latency spike", "Terraform state cleanup", "Set up staging namespace",
	          "Alert on 5xx rate", "Move secrets to the vault provider"],
	"mobile-app": ["Push notification quiet hours", "Order tracking map screen", "Fix Android back navigation", "Deep links for order emails", "Crash on empty order list"],
	"docs-site": ["Write the returns policy page", "API reference for gift cards", "Fix broken links in getting started", "Translate FAQ to French"],
}


def busy(t):
	"""Whether *t* falls in working hours (weekday office hours and evenings, plus the hackathon weekend)."""
	local = datetime.fromtimestamp(t, TZ)
	hour = local.hour
	if local.weekday() >= 5:
		return 10 <= hour < 24
	return 9 <= hour < 12 or 14 <= hour < 23


def owned_ids():
	"""Ids of the sessions the last run wrote. Without the record (a fresh container, or one seeded before the record existed) no session is known to be the seed's, so none is deleted: a model, folder or title the seed uses is no proof, since a session made by hand can share them."""
	if not OWNED.exists():
		return []
	return list(json.loads(OWNED.read_text(encoding="utf-8"))["ids"])


def taken_titles(conn, old):
	"""Sessions outside the record that hold a title the seed writes. Hermes keeps titles unique, so the seed would fail on them halfway; they are reported before anything changes. Sessions seeded before the record existed show up here too."""
	titles = {shown for items in WORK.values() for title in items for shown in (title, f"Follow-up: {title}", f"Review: {title}")}
	owned = set(old)
	return [(sid, title) for sid, title in conn.execute("SELECT id, title FROM sessions WHERE title IS NOT NULL") if title in titles and sid not in owned]


def record_owned(ids):
	partial = OWNED.with_name(OWNED.name + ".tmp")
	partial.write_text(json.dumps({"ids": ids}) + "\n", encoding="utf-8")
	os.replace(partial, OWNED)


def main():
	db = SessionDB(DB_PATH)
	rng = random.Random(20261108)
	now = time.time()
	# Each task runs three times (first pass, follow-up and review on other days), which fills the working hours like a real week.
	titles = [(project, title) for project, items in WORK.items() for title in items] * 3
	rng.shuffle(titles)
	old = owned_ids()
	with closing(sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)) as conn:
		taken = taken_titles(conn, old)
	if taken:
		sys.exit("Not seeding: these sessions were not recorded as the seed's but hold titles it writes; delete them, then seed again:\n" + "\n".join(f"  {sid}  {title}" for sid, title in taken))
	for sid in old:
		db.delete_session(sid)
	# Hermes never reuses a deleted id, so every run mints new ones. They are recorded before the first row is written, so an interrupted run still hands every id it may have written to the next one.
	nonce = int(now)
	ids = ["local-" + hashlib.sha256(f"demo-usage-{nonce}-{index}".encode()).hexdigest() for index in range(len(titles))]
	record_owned(ids)
	created = 0
	seen = []
	for index, (project, title) in enumerate(titles):
		# Hermes keeps titles unique; the second pass of a task is its follow-up.
		passes = seen.count(title)
		shown = (title, f"Follow-up: {title}", f"Review: {title}")[passes]
		seen.append(title)
		sid = ids[index]
		# Spread starts over nine days, oldest first, nudged into working hours.
		start = now - 9 * 86400 + index * (8.6 * 86400 / len(titles)) + rng.uniform(0, 3600)
		while not busy(start):
			start += 1800
		model, provider = rng.choices([(m, p) for m, p, _ in ROUTES], weights=[w for *_, w in ROUTES])[0]
		cwd = f"{W}/{project}"
		db.create_session(sid, "local", model=model, cwd=cwd, profile_name="default", git_repo_root=cwd)
		t = start
		exchanges = rng.randint(4, 10)
		for turn in range(exchanges):
			ask = title if turn == 0 else rng.choice(["Looks good, now add tests.", "Can you handle the edge case too?", "Run the checks again.", "Commit it with a clear message.", "Explain the trade-off briefly."])
			db.append_message(sid, "user", content=ask, timestamp=t)
			t += rng.uniform(120, 900)
			db.append_message(sid, "assistant", content=("Done. " + title + ". ") * rng.randint(3, 20), timestamp=t)
			t += rng.uniform(300, 1200)
		calls = exchanges * rng.randint(25, 60)
		# Volumes are on the scale of a heavy agent user's week: long sessions re-read large cached contexts on every call.
		if provider == "openai-codex":
			usage = dict(input_tokens=rng.randint(2_500_000, 7_000_000), output_tokens=rng.randint(300_000, 950_000), cache_read_tokens=rng.randint(60_000_000, 175_000_000))
		else:
			usage = dict(input_tokens=rng.randint(2_000, 20_000), output_tokens=rng.randint(200_000, 600_000), cache_read_tokens=rng.randint(28_000_000, 85_000_000), cache_write_tokens=rng.randint(1_000_000, 3_000_000))
		db.update_token_counts(sid, model=model, billing_provider=provider, api_call_count=calls, source="local", **usage)
		with closing(sqlite3.connect(DB_PATH, timeout=30)) as conn, conn:
			conn.execute("UPDATE sessions SET started_at = ?, last_activity_at = ?, title = ?, title_source = 'auto' WHERE id = ?", (start, t, shown, sid))
			conn.execute("UPDATE session_model_usage SET first_seen = ?, last_seen = ? WHERE session_id = ?", (start, t, sid))
		db.set_session_archived(sid, True)
		created += 1
	print(f"created {created} sessions")


if __name__ == "__main__":
	main()
