// Classification and project-picker preparation do not repeat per-card or per-folder work; the picker's output is compared with the former implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSections, isEmptySession, projectChoiceGroups, projectDisplayPath } from '../desktop/plugin.js';

test('classification derives each card\'s aliases once, including the empty-session check', () => {
	let reads = 0;
	const row = { id: 'tip', resolved_id: 'tip', message_count: 0, source: 'desktop' };
	// Not enumerable, so the card copy does not read it: every read is an alias derivation.
	Object.defineProperty(row, '_lineage_ids', { enumerable: false, get() { reads++; return ['tip']; } });
	const result = buildSections([row], { version: 1, sessions: {} }, []);
	assert.equal(result.active[0].newSession, true);
	assert.equal(reads, 1);
});

test('the empty-session check gives the same answer with or without the derived aliases', () => {
	const rows = [
		{ id: 'a', message_count: 0 }, { id: 'b', message_count: 0, _lineage_ids: ['root', 'b'], _lineage_root_id: 'root' },
		{ id: 'c', message_count: 0, title: 'Named' }, { id: 'd' }, { id: 'e', resolved_id: 'f', message_count: 0 }
	];
	const runtimes = [[], [{ message_count: 0 }], [{ message_count: 2 }]];
	for (const row of rows) for (const live of runtimes) {
		const ids = [...new Set([row.id, row.resolved_id, row._lineage_root_id || row.id, ...(row._lineage_ids || [])].filter(Boolean))];
		assert.equal(isEmptySession(row, live, ids), isEmptySession(row, live), JSON.stringify([row, live]));
	}
});

// The former preparation, kept only as the reference for its output.
function referenceGroups(entries, query = '', home) {
	const groups = new Map(), text = new Map();
	for (const choice of entries) {
		if (choice.isNoProject || choice.id === '__no_project__' || typeof choice.path !== 'string' || !choice.path) continue;
		const id = choice.projectId || choice.id;
		if (!groups.has(id)) groups.set(id, { id, name: choice.name, choices: [] });
		const group = groups.get(id);
		if (!group.choices.some(item => item.path === choice.path)) group.choices.push(choice);
	}
	const ordered = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).map(group => ({
		...group, multiple: group.choices.length > 1,
		choices: group.choices.sort((a, b) => a.path.localeCompare(b.path))
	}));
	for (const group of ordered) for (const choice of group.choices) text.set(choice, [group.name, choice.path, projectDisplayPath(choice.path, home)].map(value => value.toLowerCase()));
	const needle = query.trim().toLowerCase();
	return ordered.map(group => ({ ...group, choices: group.choices.filter(choice => text.get(choice).some(value => value.includes(needle))) })).filter(group => group.choices.length);
}
function prng(seed) {
	return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
}

test('project groups keep the former output, order and first-seen choice objects on seeded inputs', () => {
	const random = prng(20261111), pick = values => values[Math.floor(random() * values.length)];
	const cases = [[], [{ id: '__no_project__', name: 'Home', path: null, isNoProject: true }]];
	for (let index = 0; index < 300; index++) {
		cases.push(Array.from({ length: Math.floor(random() * 40) }, (_, n) => {
			const project = pick(['p1', 'p2', 'p3', 'p4']);
			return { id: `${project}:${n}`, projectId: random() < 0.9 ? project : undefined, name: pick(['Alpha', 'alpha', 'Beta', 'Gamma', 'Alpha']),
				path: pick(['/home/u/a', '/home/u/b', '/srv/c', '/home/u/a', '', null, 'C:\\Users\\u\\d']), isNoProject: random() < 0.05 };
		}));
	}
	for (const entries of cases) for (const query of ['', 'a', 'HOME', '~/b', 'zz']) for (const home of [undefined, '/home/u', 'C:\\Users\\u']) {
		const expected = referenceGroups(entries, query, home), actual = projectChoiceGroups(entries, query, home);
		assert.deepEqual(actual, expected);
		// The same objects, not equal copies: identities are the input positions.
		const positions = groups => groups.map(group => group.choices.map(choice => entries.indexOf(choice)));
		assert.deepEqual(positions(actual), positions(expected));
	}
});
