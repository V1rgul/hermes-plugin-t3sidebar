import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRows, aliases, durableId, visibleSource } from '../desktop/plugin.js';

// Frozen pre-optimization semantics, including direct-key priority and first alias match.
function reference(rich, extra = [], live = [], extraRich = false, archives = []) {
	const rows = new Map();
	for (const row of [...extra.map(r => ({ ...r, _limited: !extraRich })), ...rich.map(r => ({ ...r, _limited: false })), ...archives.map(r => ({ ...r, _limited: false }))]) {
		const key = durableId(row), previousKey = rows.has(key) ? key : [...rows.keys()].find(id => aliases(rows.get(id)).some(alias => aliases(row).includes(alias))), previous = rows.get(previousKey);
		if (!key || !visibleSource(row)) continue;
		if (previousKey && previousKey !== key) rows.delete(previousKey);
		rows.set(key, { ...previous, ...row, _lineage_ids: [...new Set([...(previous ? aliases(previous) : []), ...aliases(row)])] });
	}
	const known = new Set([...rows.values()].flatMap(aliases));
	for (const item of live) {
		if (!visibleSource(item) || !item.session_key || known.has(item.session_key)) continue;
		const row = { ...item, id: item.session_key, _limited: true, _liveOnly: true };
		rows.set(row.id, row); known.add(row.id);
	}
	return [...rows.values()];
}

test('indexed lineage merge preserves baseline ordering, rich/archive precedence and collisions', () => {
	let seed = 12345;
	const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
	for (let run = 0; run < 120; run++) {
		const sets = Array.from({ length: 3 }, () => Array.from({ length: 35 }, () => ({ id: `id${random(18)}`, _lineage_root_id: random(3) ? undefined : `id${random(18)}`, _lineage_ids: Array.from({ length: random(3) }, () => `id${random(18)}`), title: `Version ${random(1000)}`, source: random(10) ? 'desktop' : 'cron', archived: !!random(2) })));
		const live = Array.from({ length: 4 }, () => ({ session_key: `id${random(25)}`, source: 'desktop' }));
		assert.deepEqual(mergeRows(sets[0], sets[1], live, true, sets[2]), reference(sets[0], sets[1], live, true, sets[2]));
	}
});

test('merging unique history visits lineage arrays linearly instead of rescanning all prior rows', () => {
	let iterations = 0;
	const rows = Array.from({ length: 500 }, (_, index) => {
		const id = `session${index}`, lineage = [id];
		lineage[Symbol.iterator] = function* () { iterations++; yield id; };
		return { id, _lineage_ids: lineage };
	});
	assert.equal(mergeRows(rows).length, rows.length);
	assert.ok(iterations <= rows.length * 8, `lineage scans: ${iterations} for ${rows.length} rows`);
});
