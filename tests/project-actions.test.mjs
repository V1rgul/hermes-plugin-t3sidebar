import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import React, { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as mock from './sdk.mock.mjs';
import { createController, captureScope, scopeKey, HermesT3Sidebar, PROJECT_ICON_GROUPS, PROJECT_PALETTE } from '../desktop/plugin.js';

const approved = JSON.parse(readFileSync(new URL('./fixtures/project-appearance.json', import.meta.url), 'utf8'));
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
let controller, root, client;
const tick = async () => act(async () => new Promise(resolve => setTimeout(resolve, 15)));
const dialog = () => document.querySelector('[aria-label="Project actions"]');
const button = (label, parent = document) => [...parent.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label);
const click = async node => { assert.ok(node); await act(async () => node.click()); await tick(); };
const rpcCalls = () => mock.calls.filter(call => call[0] === 'requestProfile');
function fixture() {
  client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  controller = createController(mock.ctx, client);
  const scope = captureScope(), project = structuredClone(mock.control.rows.find(row => row.id === 'design').project);
  const key = [...scopeKey(scope), 'sessions'];
  client.setQueryData(key, { sessions: structuredClone(mock.control.rows) });
  return { scope, project, key };
}
afterEach(async () => {
  if (root) { await act(async () => root.unmount()); root = null; }
  controller?.dispose(); controller = null; client?.clear(); client = null; mock.reset();
});

test('native project edits are routed and read back before publishing to every matching card', async () => {
  const { scope, project, key } = fixture();
  for (const patch of [{ name: '  Renamed workspace  ' }, { color: mock.PROFILE_SWATCHES[2] }, { icon: 'rocket' }, { color: null }, { icon: null }]) {
    const start = mock.calls.length;
    const saved = await controller.updateProject(scope, project, patch);
    const calls = mock.calls.slice(start).filter(call => call[0] === 'requestProfile');
    assert.deepEqual(calls.map(call => call[2]), ['projects.list', 'projects.update', 'projects.get']);
    assert.ok(calls.every(call => call[1].connectionId === scope.connectionId && call[1].profile === scope.profile));
    const [field] = Object.keys(patch), expected = field === 'name' ? patch.name.trim() : patch[field];
    assert.equal(saved[field], expected);
    assert.equal(calls[1][3][field], expected ?? '');
    for (const row of client.getQueryData(key).sessions) assert.equal(row.project[field], row.project.id === project.id ? expected : mock.control.rows.find(item => item.id === row.id).project[field]);
  }
});

test('dropped writes and wrong identity/folder readbacks never publish unverified project data', async () => {
  const { scope, project, key } = fixture();
  const before = client.getQueryData(key);
  mock.control.dropProjectWrite = true;
  await assert.rejects(controller.updateProject(scope, project, { icon: 'rocket' }), /did not confirm/);
  assert.equal(client.getQueryData(key), before);
  mock.control.dropProjectWrite = false;
  for (const override of [{ id: 'wrong' }, { folders: [{ path: '/other' }] }]) {
    mock.control.projectReadback = { ...mock.control.projectCatalog.find(item => item.id === project.id), ...override, icon: 'rocket' };
    await assert.rejects(controller.updateProject(scope, project, { icon: 'rocket' }), /did not confirm/);
    assert.equal(client.getQueryData(key), before);
  }
});

test('removed, archived and moved native projects are rejected before writing', async () => {
  const { scope, project } = fixture();
  const record = mock.control.projectCatalog.find(item => item.id === project.id);
  for (const change of [() => { record.archived = true; }, () => { record.archived = false; record.folders = [{ path: '/moved' }]; }, () => { mock.control.projectCatalog = []; }]) {
    change();
    await assert.rejects(controller.updateProject(scope, project, { name: 'Wrong target' }), /changed or was removed/);
  }
  assert.ok(!rpcCalls().some(call => ['projects.update', 'projects.create'].includes(call[2])));
});

test('auto projects adopt once without selecting a workspace and retry lost replies without duplicates', async () => {
  const { scope } = fixture();
  const project = { id: '/automatic', cwd: '/automatic', name: 'Auto', icon: 'tools', color: mock.PROFILE_SWATCHES[1] };
  mock.control.projectLostReply = true;
  await assert.rejects(controller.updateProject(scope, project, { name: 'Adopted' }), /reply lost/);
  const saved = await controller.updateProject(scope, project, { icon: 'rocket' });
  assert.equal(saved.name, 'Adopted'); assert.equal(saved.color, project.color); assert.equal(saved.icon, 'rocket');
  const creates = rpcCalls().filter(call => call[2] === 'projects.create');
  assert.equal(creates.length, 1); assert.equal(creates[0][3].use, false);
  assert.deepEqual(creates[0][3].folders, ['/automatic']);
  assert.equal(mock.control.projectCatalog.filter(item => item.folders.some(folder => folder.path === '/automatic')).length, 1);
});

test('source switch after a project write prevents foreign readback and cache publication', async () => {
  const { scope, project, key } = fixture(), before = client.getQueryData(key);
  mock.control.afterProjectWrite = () => mock.switchScope();
  await assert.rejects(controller.updateProject(scope, project, { color: mock.PROFILE_SWATCHES[4] }), /Source\/profile changed/);
  assert.ok(!rpcCalls().some(call => call[2] === 'projects.get'));
  assert.equal(client.getQueryData(key), before);
});

test('auto-project first clears store native nulls rather than update-only empty-string sentinels', async () => {
  const { scope } = fixture();
  for (const field of ['color', 'icon']) {
    const path = `/auto-clear-${field}`, project = { id: path, cwd: path, name: 'Auto', icon: 'tools', color: mock.PROFILE_SWATCHES[1] };
    const saved = await controller.updateProject(scope, project, { [field]: null });
    assert.equal(saved[field], null);
    const created = rpcCalls().filter(call => call[2] === 'projects.create').at(-1)[3];
    assert.equal(created[field], null);
    assert.equal(saved[field === 'icon' ? 'color' : 'icon'], project[field === 'icon' ? 'color' : 'icon']);
  }
});

test('rich history reads cannot start mid-save and publish stale first-load results after readback', async () => {
  const { scope, project } = fixture();
  controller.dispose();
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { reached = resolve; });
  controller = createController(mock.ctx, client, { capture: captureScope, routes: () => mock.host.profileRoutes(), host: { ...mock.host,
    async requestProfile(route, method, params) {
      if (method === 'projects.update') { reached(); await gate; }
      return mock.host.requestProfile(route, method, params);
    }
  } });
  const saving = controller.updateProject(scope, project, { name: 'After save' });
  await started;
  const before = mock.calls.length;
  for (const method of ['list', 'archives', 'expanded']) {
    const key = [...scopeKey(scope), 'first-load', method];
    await assert.rejects(client.fetchQuery({ queryKey: key, retry: false, queryFn: () => controller[method](scope, 1) }), /Superseded session listing/);
    assert.equal(client.getQueryData(key), undefined);
  }
  assert.equal(mock.calls.length, before, 'no history snapshot is read while saving');
  release(); await saving;
  const saved = await controller.list(scope);
  assert.equal(saved.sessions.find(row => row.id === 'design').project.name, 'After save');
});

test('project rename validates blank names and Home is not materialized', async () => {
  const { scope, project } = fixture();
  await assert.rejects(controller.updateProject(scope, project, { name: '  ' }), /non-empty/);
  await assert.rejects(controller.updateProject(scope, { ...project, is_home: true }, { color: null }), /named project/);
  assert.equal(rpcCalls().length, 0);
});

test('Copy path copies the project root, checks clipboard failure and fences stale scope', async () => {
  const { scope, project } = fixture();
  await controller.copyProjectPath(scope, project);
  assert.deepEqual(mock.calls.at(-1), ['clipboard', project.cwd]);
  mock.control.clipboardError = true;
  await assert.rejects(controller.copyProjectPath(scope, project), /not copied/);
  mock.switchScope(); const count = mock.calls.length;
  await assert.rejects(controller.copyProjectPath(scope, project), /Source\/profile changed/);
  assert.equal(mock.calls.length, count);
});

test('Project submenu is last; actions have leading icons and selectors persist native changes', async () => {
  controller = createController(mock.ctx);
  root = createRoot(document.getElementById('app'));
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, React.createElement(HermesT3Sidebar, { ctx: mock.ctx, controller }))));
  await tick(); await tick();
  const open = async () => { await click(button('Actions for Sidebar layout')); await click(button('Project')); assert.ok(dialog()); };
  await open();
  const actions = [...dialog().querySelectorAll('.sf-menu-action')];
  assert.deepEqual(actions.slice(0, 3).map(action => action.textContent), ['Rename', 'Copy path', 'Filter for']);
  assert.ok(actions.slice(0, 3).every(action => action.firstElementChild.className === 'sf-menu-icon' && action.firstElementChild.querySelector('svg')));
  assert.equal(dialog().querySelectorAll('.sf-project-icons button').length, 64);
  assert.equal(dialog().querySelectorAll('[aria-label="Project color"] button').length, 49);
  await click(button('Rename', dialog()));
  const nameInput = dialog().querySelector('[aria-label="Project name"]');
  await act(async () => nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
  assert.ok(dialog()); assert.equal(dialog().querySelector('[aria-label="Project name"]'), nameInput);
  await click(button('Project icon: rocket', dialog()));
  assert.equal(dialog(), null);
  assert.ok(document.querySelector('[data-session-id="design"] [data-codicon="rocket"]'));
  await open(); await click(button('Project color: Amber', dialog()));
  assert.equal(mock.control.rows.find(row => row.id === 'design').project.color, approved.colors[3].value);
  await open(); await click(button('No color', dialog()));
  assert.equal(mock.control.rows.find(row => row.id === 'design').project.color, null);
  await open(); await click(button('Default icon', dialog()));
  assert.equal(mock.control.rows.find(row => row.id === 'design').project.icon, null);
  await open(); await click(button('Copy path', dialog()));
  assert.deepEqual(mock.calls.find(call => call[0] === 'clipboard'), ['clipboard', '/projects/hermes-t3sidebar']);
  await open(); await click(button('Filter for', dialog()));
  assert.equal(dialog(), null);
  assert.equal(document.querySelector('[data-session-id="readme"]'), null);
});

test('project write errors stay visible in submenu and do not close or fabricate success', async () => {
  controller = createController(mock.ctx);
  root = createRoot(document.getElementById('app'));
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, React.createElement(HermesT3Sidebar, { ctx: mock.ctx, controller }))));
  await tick(); await tick();
  await click(button('Actions for Sidebar layout')); await click(button('Project'));
  mock.control.projectWriteError = true;
  await click(button('Project icon: rocket', dialog()));
  assert.match(dialog().querySelector('[role="alert"]').textContent, /project write unavailable/);
  assert.ok(!document.querySelector('[data-session-id="design"] [data-codicon="rocket"]'));
});

test('appearance catalog matches the approved 64 categorized Codicons and exact 48-color preview', () => {
  assert.deepEqual(PROJECT_ICON_GROUPS, approved.iconGroups);
  assert.deepEqual(PROJECT_PALETTE, approved.colors);
  assert.equal(new Set(PROJECT_ICON_GROUPS.flatMap(group => group.icons)).size, 64);
  assert.equal(new Set(PROJECT_PALETTE.map(color => color.value)).size, 48);
});

async function mountSidebar() {
  controller = createController(mock.ctx);
  root = createRoot(document.getElementById('app'));
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, React.createElement(HermesT3Sidebar, { ctx: mock.ctx, controller }))));
  await tick(); await tick();
}
const context = async node => {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  await act(async () => node.dispatchEvent(event)); await tick();
  assert.equal(event.defaultPrevented, true);
};

test('active filter keeps native project name and icon when that project has no loaded sessions', async () => {
  mock.control.projects.push({ id: 'p_unused', label: 'Unused workspace', path: '/unused', icon: 'rocket', color: '#78c318' });
  await mountSidebar();
  await click(button('Filter sessions')); await click(button('Filter by Unused workspace'));
  assert.equal(button('Filter sessions').title, 'Filter sessions: Unused workspace');
  assert.ok(button('Filter sessions').querySelector('[data-codicon="rocket"]'));
  assert.match(document.body.textContent, /No matching sessions/);
  assert.ok(!mock.calls.some(call => call[2] === 'session.create' || call[0] === 'open'));
});

test('shared native project names leave multi-folder move targets distinguishable', async () => {
  mock.control.projects.push({ id: 'p_multi', label: 'Multi', path: '/multi/first', repos: [{ path: '/multi/first' }, { path: '/multi/second' }] });
  await mountSidebar();
  await click(button('Actions for Sidebar layout')); await click(button('Move to project'));
  assert.ok(button('Move to Multi · /multi/first'));
  assert.ok(button('Move to Multi · /multi/second'));
  assert.equal(mock.calls.some(call => call[2] === 'session.workspace.move'), false);
});

test('filter project right-click opens the same appearance menu without selecting a filter or workspace', async () => {
  await mountSidebar();
  await click(button('Filter sessions')); await context(button('Filter by docs'));
  assert.ok(dialog());
  assert.equal(dialog().querySelector('.sf-menu-title').textContent, 'docs');
  assert.equal(dialog().querySelectorAll('.sf-project-colors button').length, 48);
  assert.deepEqual([...dialog().querySelectorAll('.sf-project-icon-category legend')].map(node => node.textContent), approved.iconGroups.map(group => group.label));
  assert.equal(document.querySelector('[aria-label="All projects"]').getAttribute('aria-pressed'), 'true');
  assert.ok(document.querySelector('[data-session-id="design"]'));
  assert.ok(document.querySelector('[data-session-id="readme"]'));
  assert.ok(!mock.calls.some(call => ['open', 'newChat'].includes(call[0]) || call[2] === 'session.create'));
  await click(button('Project icon: law', dialog()));
  assert.equal(dialog(), null);
  assert.ok(mock.control.rows.filter(row => row.project.name === 'docs').every(row => row.project.icon === 'law'));
  assert.ok(mock.control.rows.filter(row => row.project.name !== 'docs').every(row => row.project.icon !== 'law'));
  assert.deepEqual(rpcCalls().filter(call => call[2] !== 'projects.tree').slice(-3).map(call => call[2]), ['projects.list', 'projects.update', 'projects.get']);
  await click(button('Filter sessions')); await context(button('Filter by docs'));
  assert.equal(button('Project icon: law', dialog()).getAttribute('aria-pressed'), 'true');
  await click(button('Project color: Brown', dialog()));
  const brown = approved.colors.find(color => color.name === 'Brown').value;
  assert.ok(mock.control.rows.filter(row => row.project.name === 'docs').every(row => row.project.color === brown));
  await click(button('Filter sessions')); await context(button('Filter by docs'));
  assert.equal(button('Project color: Brown', dialog()).getAttribute('aria-pressed'), 'true');
  await click(button('No color', dialog()));
  assert.ok(mock.control.rows.filter(row => row.project.name === 'docs').every(row => row.project.color === null));
});

test('filter project normal click still selects directly; keyboard context menu can copy without changing the filter', async () => {
  await mountSidebar();
  await click(button('Filter sessions')); await click(button('Filter by docs'));
  assert.equal(document.querySelector('[data-session-id="design"]'), null);
  assert.equal(dialog(), null);
  await click(button('Filter sessions'));
  const choice = button('Filter by docs');
  await act(async () => choice.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })));
  await tick(); assert.ok(dialog());
  await click(button('Copy path', dialog()));
  assert.ok(mock.calls.some(call => call[0] === 'clipboard' && call[1] === '/projects/docs'));
  assert.equal(document.querySelector('[data-session-id="design"]'), null);
});

test('filter project edit failure remains visible and scope changes discard its menu', async () => {
  await mountSidebar();
  await click(button('Filter sessions')); await context(button('Filter by docs'));
  mock.control.dropProjectWrite = true;
  await click(button('Project color: Blue', dialog()));
  assert.match(dialog().querySelector('[role="alert"]').textContent, /did not confirm/);
  assert.equal(mock.control.rows.find(row => row.id === 'readme').project.color, null);
  mock.control.dropProjectWrite = false;
  await act(async () => mock.switchScope()); await tick();
  assert.equal(dialog(), null);
  assert.equal(document.querySelector('[aria-label="Session filters"]'), null);
});

test('filter project context menu owns its gesture before the native window capture coordinator', async () => {
  await mountSidebar();
  await click(button('Filter sessions'));
  let fallbackMenus = 0;
  // AppContextMenu resolves ownership at window capture, before React handlers.
  const coordinator = event => {
    const trigger = event.target.closest('[data-hermes-context-menu-trigger], [data-slot="context-menu-trigger"]');
    if (trigger && !trigger.hasAttribute('data-zone-body')) return;
    event.stopPropagation(); fallbackMenus++;
  };
  window.addEventListener('contextmenu', coordinator, true);
  try {
    const choice = button('Filter by docs');
    await context(choice.querySelector('.sf-project-name'));
    assert.equal(fallbackMenus, 0);
    assert.ok(dialog());
    assert.equal(dialog().querySelector('.sf-menu-title').textContent, 'docs');
    assert.equal(button('All projects').getAttribute('aria-pressed'), 'true');
  } finally { window.removeEventListener('contextmenu', coordinator, true); }
});
