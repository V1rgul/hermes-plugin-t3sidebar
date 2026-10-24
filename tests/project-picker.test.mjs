import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import * as mock from './sdk.mock.mjs';
import { createController, captureScope, scopeKey, ProjectPicker, projectDisplayPath, projectChoiceGroups } from '../desktop/plugin.js';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
let root, controller;
const tick = async () => act(async () => new Promise(resolve => setTimeout(resolve, 15)));
const button = label => [...document.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === label) || null;
const click = async node => { assert.ok(node); await act(async () => node.click()); await tick(); };
const input = async value => {
	const node = document.querySelector('[aria-label="Search projects"]');
	await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); });
	await tick();
};
async function mount(mode = 'filter') {
	controller = createController(mock.ctx);
	root = createRoot(document.getElementById('app'));
	const selected = [], closed = [];
	const scope = captureScope();
	await mock.queryClient.ensureQueryData({ queryKey: [...scopeKey(scope), 'projects'], queryFn: () => controller.projects(scope) });
	await mock.queryClient.ensureQueryData({ queryKey: [...scopeKey(scope), 'project-home'], queryFn: () => controller.projectHome(scope) });
	await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, React.createElement(ProjectPicker, {
		controller, scope: captureScope(), mode, filterProject: cwd => selected.push(cwd), close: () => closed.push(true)
	}))));
	await tick(); await tick();
	return { selected, closed };
}
const groupedFixture = () => {
	mock.control.home = '/home/fixture';
	mock.control.projects = [
		{ id: 'p_multi', label: 'Multi', path: '/home/fixture/main', icon: 'tools', repos: [{ path: '/home/fixture/main' }, { path: '/home/fixture/second' }] },
		{ id: 'p_single', label: 'Single', path: '/srv/shared', icon: 'repo' }
	];
	mock.control.projectCatalog = [{ id: 'p_multi', name: 'Multi', folders: [{ path: '/home/fixture/main' }, { path: '/home/fixture/second' }], icon: 'tools', color: null, archived: false }];
};
afterEach(async () => {
	if (root) { await act(async () => root.unmount()); root = null; }
	controller?.dispose(); controller = null; mock.reset();
});

test('home shortening uses the exact owning home with segment boundaries and leaves other users intact', () => {
	for (const [path, home, expected] of [
		['/home/fixture', '/home/fixture', '~'], ['/home/fixture/repo', '/home/fixture/', '~/repo'],
		['/home/fixture-other/repo', '/home/fixture', '/home/fixture-other/repo'], ['/home/other/repo', '/home/fixture', '/home/other/repo'],
		['/srv/home/fixture/repo', '/home/fixture', '/srv/home/fixture/repo'], ['/repo', '/', '/repo'],
		['C:\\Users\\Fixture\\repo', 'c:\\users\\fixture', '~\\repo'], ['C:/Users/Fixture/repo', 'C:\\Users\\Fixture', '~/repo'],
		['/home/Fixture/repo', '/home/fixture', '/home/Fixture/repo'], ['/repo', undefined, '/repo']
	]) assert.equal(projectDisplayPath(path, home), expected);
});

test('grouping deduplicates folders, keeps different native identities apart and retains multi-path shape after search', () => {
	const entries = [
		{ id: 'one:a', projectId: 'one', name: 'Same', path: '/home/fixture/a' },
		{ id: 'one:b', projectId: 'one', name: 'Same', path: '/home/fixture/b' },
		{ id: 'one:again', projectId: 'one', name: 'Same', path: '/home/fixture/a' },
		{ id: 'two:c', projectId: 'two', name: 'Same', path: '/elsewhere/c' },
		{ id: '__no_project__', name: 'Home', path: null, isNoProject: true }
	];
	const groups = projectChoiceGroups(entries);
	assert.equal(groups.length, 2); assert.equal(groups[0].choices.length, 2);
	assert.equal(groups[0].multiple, true); assert.equal(groups[1].multiple, false);
	const searched = projectChoiceGroups(entries, '~/b', '/home/fixture');
	assert.equal(searched.length, 1); assert.equal(searched[0].multiple, true);
	assert.deepEqual(searched[0].choices.map(choice => choice.path), ['/home/fixture/b']);
});

for (const mode of ['filter', 'new']) {
	test(`${mode} picker always searches names and paths; All projects appears only for filtering`, async () => {
		groupedFixture(); const { selected } = await mount(mode);
		assert.ok(document.querySelector('[aria-label="Search projects"]'));
		assert.equal(!!button('All projects'), mode === 'filter');
		assert.equal(document.querySelectorAll('.sf-project-name').length, mode === 'filter' ? 3 : 2);
		assert.deepEqual([...document.querySelectorAll('.sf-project-path')].map(node => node.textContent), ['~/main', '~/second', '/srv/shared']);
		await input('  ~/second  ');
		assert.ok(button('Project Multi')); assert.equal(document.querySelectorAll('.sf-project-folder').length, 1);
		assert.equal(button(`${mode === 'filter' ? 'Filter by' : 'New session in'} Single`), null);
		await input('Multi'); assert.equal(document.querySelectorAll('.sf-project-folder').length, 2);
		await input('no-such-project'); assert.match(document.body.textContent, /No matching projects/);
		assert.equal(!!button('All projects'), mode === 'filter');
		await input(''); assert.equal(selected.length, 0);
	});

	test(`${mode} multi-path heading never selects, but right-click owns and edits the native project`, async () => {
		groupedFixture(); const { selected, closed } = await mount(mode);
		const heading = button('Project Multi');
		assert.equal(heading.getAttribute('aria-disabled'), 'true');
		await click(heading); assert.equal(selected.length, 0); assert.equal(closed.length, 0);
		assert.ok(!mock.calls.some(call => call[2] === 'session.create'));
		let fallbackMenus = 0;
		const coordinator = event => { if (!event.target.closest('[data-hermes-context-menu-trigger], [data-slot="context-menu-trigger"]')) { event.stopPropagation(); fallbackMenus++; } };
		window.addEventListener('contextmenu', coordinator, true);
		try {
			const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
			await act(async () => heading.querySelector('.sf-project-name').dispatchEvent(event)); await tick();
			assert.equal(fallbackMenus, 0); assert.equal(event.defaultPrevented, true);
			assert.equal(document.querySelector('[aria-label="Project actions"] .sf-menu-title').textContent, 'Multi');
			assert.equal([...document.querySelectorAll('.sf-menu-action')].find(node => node.textContent === 'Copy path').disabled, true);
			assert.equal([...document.querySelectorAll('.sf-menu-action')].find(node => node.textContent === 'Filter for').disabled, true);
			await click(button('Project icon: rocket'));
			const write = mock.calls.find(call => call[2] === 'projects.update');
			assert.deepEqual(write[3], { id: 'p_multi', icon: 'rocket' });
			assert.equal(selected.length, 0); assert.equal(closed.length, 1);
		} finally { window.removeEventListener('contextmenu', coordinator, true); }
	});

	test(`${mode} path selection uses the exact unshortened folder`, async () => {
		groupedFixture(); const { selected, closed } = await mount(mode);
		const choice = button(`${mode === 'filter' ? 'Filter by' : 'New session in'} Multi: ~/second`);
		assert.ok(choice, [...document.querySelectorAll('button')].map(node => node.getAttribute('aria-label')).join('|'));
		await click(choice);
		assert.equal(closed.length, 1);
		if (mode === 'filter') {
			assert.deepEqual(selected, ['/home/fixture/second']);
			assert.ok(!mock.calls.some(call => call[2] === 'session.create'));
		} else {
			assert.equal(mock.calls.find(call => call[2] === 'session.create')[3].cwd, '/home/fixture/second');
			assert.equal(mock.control.composerCwd, '/home/fixture/second');
		}
	});
}

test('picker search reuses sorted groups and prepared paths until catalog or home changes', async () => {
	groupedFixture(); await mount();
	const compare = String.prototype.localeCompare, lower = String.prototype.toLowerCase;
	let comparisons = 0, pathPreparations = 0;
	String.prototype.localeCompare = function (...args) { comparisons++; return compare.apply(this, args); };
	String.prototype.toLowerCase = function () { if (String(this).startsWith('/home/fixture/')) pathPreparations++; return lower.call(this); };
	try {
		await input('~/second'); await input('Multi'); await input('no-such-project');
		assert.equal(comparisons, 0, 'query changes do not sort the catalog again');
		assert.equal(pathPreparations, 0, 'query changes reuse prepared path search fields');
		assert.match(document.body.textContent, /No matching projects/);
		const prefix = scopeKey(captureScope());
		await act(async () => mock.queryClient.setQueryData([...prefix, 'project-home'], '/home/fixture/second')); await tick();
		await input('~');
		assert.ok(button('Filter by Multi: ~'), 'home changes rebuild shortened paths');
		await act(async () => mock.queryClient.setQueryData([...prefix, 'projects'], { projects: [{ id: 'p_new:/new', projectId: 'p_new', name: 'Renamed', path: '/new' }] })); await tick();
		await input('Renamed'); assert.ok(button('Filter by Renamed'));
		await input('Multi'); assert.match(document.body.textContent, /No matching projects/);
	} finally { String.prototype.localeCompare = compare; String.prototype.toLowerCase = lower; }
});

test('home lookup is routed, profile-qualified and rejects source/profile drift', async () => {
	controller = createController(mock.ctx);
	const scope = captureScope();
	assert.equal(await controller.projectHome(scope), '/home/fixture');
	mock.control.homeProfile = 'foreign';
	await assert.rejects(controller.projectHome(scope), /profile/i);
	mock.switchScope(); const count = mock.calls.length;
	await assert.rejects(controller.projectHome(scope), /Source\/profile changed/);
	assert.equal(mock.calls.length, count);
});
