import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSections, SECTIONS, visibleSource, durableId, aliases, isEmptySession, seconds, sessionTitle } from '../desktop/plugin.js';

// Reference the same classifier with the old per-row runtime scan; compare complete outputs, not only status labels.
function reference(rows, metadata, live, { now = Date.now() / 1000, runtimeKnown = true, query = '', project = '*' } = {}) {
	const matchesFilters = row => {
		if (project !== '*' && (row._limited || (row.cwd || '') !== project)) return false;
		if (!query) return true;
		const text = [sessionTitle(row), row.preview, row.cwd, row.git_branch, ...aliases(row)].filter(Boolean).join(' ').toLowerCase();
		return query.trim().toLowerCase().split(/\s+/).every(token => text.includes(token));
	};
	const result = Object.fromEntries(SECTIONS.map(section => [section, []]));
	for (const row of rows) {
		if (!visibleSource(row)) continue;
		const meta = metadata.sessions[durableId(row)] || { state: 'active', pinned: false };
		const ids = new Set(aliases(row));
		const matches = live.filter(item => ids.has(item.session_key) || ids.has(item.id));
		const status = !runtimeKnown ? 'unknown' : matches.some(i => i.status === 'waiting') ? 'waiting'
			: matches.some(i => i.status === 'working' || i.status === 'starting' || Number.isInteger(i.running_subagents) && i.running_subagents > 0) ? 'working'
			: matches.some(i => !['idle', 'working', 'starting', 'waiting'].includes(i.status)) ? 'unknown' : 'idle';
		const woke = Number.isFinite(meta.woke_at) && meta.woke_at > 0 || meta.state === 'snoozed' && meta.wake_at <= now;
		const section = status === 'waiting' ? 'active' : row.archived === true ? 'archived' : status === 'unknown' ? 'active'
			: meta.state === 'snoozed' && !woke ? 'snoozed' : status === 'working' ? 'working' : meta.pinned ? 'pinned' : 'active';
		const newSession = isEmptySession(row, runtimeKnown ? matches : []);
		if (!matchesFilters({ ...row, newSession })) continue;
		const activity = seconds(row.last_active || row.updated_at || row.started_at || row.created_at);
		const runtimes = matches.filter(item => typeof item.id === 'string' && item.id && item.id !== item.session_key);
		result[section].push({ ...row, key: durableId(row), meta, completion: metadata.completions?.[durableId(row)] || null, section, status, woke, newSession,
			runtimeId: runtimes.length === 1 ? runtimes[0].id : null, activity });
	}
	for (const section of SECTIONS) result[section].sort((a, b) => {
		if (section === 'active' && (a.status === 'waiting') !== (b.status === 'waiting')) return a.status === 'waiting' ? -1 : 1;
		const delta = section === 'snoozed' ? a.meta.wake_at - b.meta.wake_at : b.activity - a.activity;
		return delta || a.key.localeCompare(b.key);
	});
	return result;
}

test('classification indexes runtime identities once instead of scanning every runtime for each stored card', () => {
	let reads = 0;
	const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `session-${i}`, last_active: i + 1 }));
	const live = rows.slice(0, 500).map(row => ({ id: `runtime-${row.id}`, get session_key() { reads++; return row.id; }, status: 'idle', running_subagents: 0 }));
	const sections = buildSections(rows, { sessions: {} }, live, { now: 5000 });
	assert.equal(sections.active.length, 1000);
	assert.ok(reads <= live.length * 4, `runtime identity reads must be linear, got ${reads}`);
});

test('indexed classification retains runtime order, duplicates, aliases, empty evidence and status/metadata precedence', () => {
	let seed = 1789;
	const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
	for (let run = 0; run < 100; run++) {
		const rows = Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, _lineage_root_id: random(3) ? undefined : `root${i}`, _lineage_ids: [`alias${i}`, `alias${random(25)}`], archived: !random(4), source: random(9) ? 'desktop' : 'cron', title: random(2) ? `Title ${i}` : '', preview: random(5) ? '' : 'real history', message_count: random(4), last_active: random(1000), cwd: random(3) ? '/a' : '/b' }));
		const live = Array.from({ length: 40 }, (_, i) => ({ id: random(4) ? `runtime${random(20)}` : `s${random(25)}`, session_key: `${random(2) ? 'alias' : 's'}${random(25)}`, status: ['idle', 'working', 'starting', 'waiting', 'unknown'][random(5)], running_subagents: [null, 0, 1, 2][random(4)], message_count: random(3) }));
		// Repeated references are intentionally separate entries in the native snapshot.
		live.push(live[0], { id: 'same', session_key: 's1', status: 'idle' }, { id: 'same', session_key: 's2', status: 'idle' });
		const metadata = { sessions: Object.fromEntries(rows.filter(() => random(2)).map(row => [row._lineage_root_id || row.id, { state: ['active', 'settled', 'snoozed'][random(3)], wake_at: random(2) ? 4000 : 6000, woke_at: random(4) ? null : 4500, pinned: !!random(2) }])), completions: { s1: { done_at: 4000, done_token: 'turn' } } };
		const options = { now: 5000, runtimeKnown: !!random(5), query: ['', 'title', 'missing'][random(3)], project: ['*', '/a'][random(2)] };
		assert.deepEqual(buildSections(rows, metadata, live, options), reference(rows, metadata, live, options), `seeded case ${run}`);
	}
});
