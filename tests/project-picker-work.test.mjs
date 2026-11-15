import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import * as mock from './sdk.mock.mjs';
import { createController, captureScope, scopeKey, ProjectPicker } from '../desktop/plugin.js';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true });
// A minimal DevTools hook, as the browser benchmark installs: it counts the function components that actually ran in each commit.
const renders = {};
const walk = root => {
  const stack = [root];
  while (stack.length) {
    const fiber = stack.pop();
    if (typeof fiber.type === 'function' && (fiber.flags & 1)) { const name = fiber.type.displayName || fiber.type.name || 'anonymous'; renders[name] = (renders[name] || 0) + 1; }
    if (fiber.child && (!fiber.alternate || fiber.child !== fiber.alternate.child)) for (let child = fiber.child; child; child = child.sibling) stack.push(child);
  }
};
globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, isDisabled: false, renderers: new Map(), inject() { return 1; }, checkDCE() {},
  onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onCommitFiberRoot(_id, root) { walk(root.current); } };
const { createRoot } = await import('react-dom/client');
let root, controller;
const tick = async () => act(async () => new Promise(resolve => setTimeout(resolve, 0)));
const button = label => [...document.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === label) || null;
const count = name => renders[name] || 0;
const resetRenders = () => { for (const name of Object.keys(renders)) delete renders[name]; };
const typeInto = async (node, value) => {
  await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); });
  await tick();
};
const input = value => typeInto(document.querySelector('[aria-label="Search projects"]'), value);
// The mock popover trigger marks the element it wraps with data-state, as Radix does: one per mounted popover root.
const popoverRoots = () => document.querySelectorAll('.sf-project-options [data-state]').length;
const editorOpen = () => !!document.querySelector('[role=dialog][aria-label="Project actions"]');
afterEach(async () => {
  if (root) { await act(async () => root.unmount()); root = null; }
  controller?.dispose(); controller = null; mock.reset();
});

// 120 synthetic projects, every third one with three folders: 200 folder choices and 40 headings.
function largeCatalog() {
  mock.control.home = '/home/fixture';
  mock.control.projects = Array.from({ length: 120 }, (_, index) => {
    const name = `Project ${String(index).padStart(3, '0')}`, path = `/home/fixture/p${index}`;
    return index % 3 ? { id: `p${index}`, label: name, path, icon: 'repo' } : { id: `p${index}`, label: name, path, icon: 'tools', repos: [{ path }, { path: `${path}-b` }, { path: `${path}-c` }] };
  });
  mock.control.projectCatalog = mock.control.projects.filter(project => project.repos).map(project => ({ id: project.id, name: project.label, folders: project.repos, icon: project.icon, color: null, archived: false }));
}
async function mount(mode = 'filter') {
  controller = createController(mock.ctx);
  root = createRoot(document.getElementById('app'));
  const selected = [], closed = [], scope = captureScope();
  await mock.queryClient.ensureQueryData({ queryKey: [...scopeKey(scope), 'projects'], queryFn: () => controller.projects(scope) });
  await mock.queryClient.ensureQueryData({ queryKey: [...scopeKey(scope), 'project-home'], queryFn: () => controller.projectHome(scope) });
  const filterProject = cwd => selected.push(cwd), close = () => closed.push(true);
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, React.createElement(ProjectPicker, { controller, scope, mode, filterProject, close }))));
  await tick(); await tick();
  return { selected, closed };
}

test('a large multi-folder picker mounts no closed popover and typing a broad match re-renders no choice', async () => {
  largeCatalog();
  resetRenders();
  const { selected, closed } = await mount();
  const choices = document.querySelectorAll('.sf-project-choice').length;
  assert.equal(choices, 1 + 200 + 40, 'All projects, every folder and every heading');
  assert.equal(popoverRoots(), 0, 'no choice holds a popover before one is opened');
  assert.equal(count('Popover') + count('PopoverContent'), 0);
  // Every choice still declares its context-menu ownership, so Hermes's capture fallback leaves the gesture to it.
  assert.equal(document.querySelectorAll('.sf-project-options [data-hermes-context-menu-trigger]').length, 240);
  resetRenders();
  await input('p'); await input('pr'); await input('project');
  assert.equal(document.querySelectorAll('.sf-project-choice').length, choices, 'the broad search keeps every choice');
  assert.equal(count('ProjectChoice'), 0, 'kept choices do not render again');
  // Right-click on a folder of a multi-folder project opens its editor, the picker's only popover.
  const folder = button('Filter by Project 003: ~/p3-b');
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  await act(async () => folder.dispatchEvent(event)); await tick();
  assert.equal(event.defaultPrevented, true);
  assert.equal(editorOpen(), true);
  assert.equal(popoverRoots(), 1);
  assert.equal(document.querySelector('[aria-label="Project actions"] .sf-menu-heading').textContent, 'Project 003');
  // Searching while it is open keeps the editor of a choice that still matches.
  resetRenders();
  await input('project 00');
  assert.equal(editorOpen(), true, 'a matching search keeps the open editor');
  assert.ok(count('ProjectChoice') <= 2, `only the owner's group may render again (${count('ProjectChoice')})`);
  // One the search hides drops it, and it does not come back on its own.
  await input('project 01');
  assert.equal(editorOpen(), false);
  await input('');
  assert.equal([editorOpen(), popoverRoots()].join(), 'false,0');
  // Shift+F10 on a heading edits the whole project; the heading's editor is not its first folder's.
  const heading = button('Project Project 006');
  await act(async () => heading.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))); await tick();
  assert.equal(editorOpen(), true);
  assert.equal([...document.querySelectorAll('[aria-label="Project actions"] .sf-menu-path')].length, 3, 'the heading lists all three folders');
  assert.equal(button('Filter by Project 006: ~/p6').getAttribute('data-state'), null, 'its first folder holds no popover');
  // Escape closes it; the editor stays held for its fade, still the only popover root.
  await act(async () => document.querySelector('[role=dialog][aria-label="Project actions"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))); await tick();
  assert.equal([editorOpen(), popoverRoots()].join(), 'false,1');
  // A plain click still selects the raw folder.
  await act(async () => button('Filter by Project 004').click()); await tick();
  assert.deepEqual(selected, ['/home/fixture/p4']);
  assert.equal(closed.length, 1);
});

test('a project heading keeps its editor and rename draft while the search matches any of its folders', async () => {
  largeCatalog();
  await mount();
  const heading = button('Project Project 006');
  await act(async () => heading.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))); await tick();
  await act(async () => button('Rename project').click()); await tick();
  await typeInto(document.querySelector('[aria-label="Project name"]'), 'Renamed draft');
  const folders = () => [...document.querySelectorAll('[aria-label="Project actions"] .sf-menu-path')].map(node => node.textContent);
  // Each query leaves a different folder first in the heading's group; the heading is the same native project throughout.
  for (const query of ['p6-b', 'p6-c', 'project 006']) {
    await input(query);
    assert.equal(editorOpen(), true, `the heading keeps its editor on "${query}"`);
    assert.equal(document.querySelector('[aria-label="Project name"]')?.value, 'Renamed draft', `the rename draft survives "${query}"`);
    assert.deepEqual(folders().sort(), ['/home/fixture/p6', '/home/fixture/p6-b', '/home/fixture/p6-c'], 'the heading still lists every folder of the project');
    assert.equal(popoverRoots(), 1);
  }
  assert.equal(button('Filter by Project 006: ~/p6-c').getAttribute('data-state'), null, 'the matched folder holds no popover of its own');
  // A search hiding the project drops its editor, which does not come back on its own.
  await input('project 01');
  assert.equal([editorOpen(), popoverRoots()].join(), 'false,0');
  await input('');
  assert.equal([editorOpen(), popoverRoots()].join(), 'false,0');
});
