import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import * as mock from './sdk.mock.mjs';
import * as flow from '../desktop/plugin.js';

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
const realNow = Date.now;
const tick = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const row = id => document.querySelector(`[data-session-id="${id}"]`);
const cardRenders = () => renders.SessionRow || 0;
const resetRenders = () => { for (const name of Object.keys(renders)) delete renders[name]; };
afterEach(async () => {
  Date.now = realNow;
  if (root) { await act(async () => root.unmount()); root = null; }
  controller?.dispose(); controller = null;
  mock.control.disposers.forEach(dispose => dispose()); mock.reset();
});

// Cards whose visible time does not change within a few minutes, beside the clock-driven values they do not show: a Done card's age, a waiting card's age and a Snoozed card's precise countdown.
function fixture(start) {
  const card = (id, title, last_active, extra = {}) => ({ id, title, cwd: '/projects/clock', last_active, source: 'desktop', archived: false, provider: 'openai-codex', input_tokens: 1200, output_tokens: 300, total_tokens: 1500,
    project: { id: 'synthetic:/projects/clock', name: 'clock', icon: '◇', color: null, cwd: '/projects/clock', is_home: false }, ...extra });
  mock.control.rows = [card('aged', 'Three days old', start - 3 * 86400 - 1000), card('done', 'Finished', start - 30 * 60 - 10, { unread: true }),
    card('asking', 'Asking', start - 10 * 60 - 5), card('snoozed', 'Snoozed for days', start - 7200)];
  mock.control.live = [{ id: 'runtime-asking', session_key: 'asking', status: 'waiting', last_active: start - 10 * 60 - 5 }];
  mock.control.metadata = { version: 1, sessions: { snoozed: { state: 'snoozed', pinned: false, settled_at: null, wake_at: start + 2 * 86400 + 16 * 3600 + 12 * 60, updated_at: start } } };
  mock.host.state.focusedStoredSessionId.set('aged');
}
async function mount() {
  controller = flow.createController(mock.ctx);
  root = createRoot(document.querySelector('#app'));
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, React.createElement(flow.HermesT3Sidebar, { ctx: mock.ctx, controller }))));
  await tick(); await tick();
}
const sessionsKey = () => [...flow.scopeKey(flow.captureScope()), 'sessions'];
const poll = async () => { await act(async () => mock.queryClient.refetchQueries({ queryKey: sessionsKey(), exact: true })); await tick(); };
const times = () => ['aged', 'done', 'asking', 'snoozed'].map(id => row(id).querySelector('.sf-time').textContent).join('|');

test('a poll that only moves the clock re-renders no card whose visible time is unchanged; the open Snooze menu still counts down', async () => {
  // Whole seconds, so minute boundaries fall where the fixture puts them.
  let now = Math.floor(realNow() / 1000) * 1000;
  const start = now / 1000;
  Date.now = () => now;
  fixture(start);
  await mount();
  const before = times();
  assert.match(before, /^3d\|.*Done.*\|.*Input.*\|3d$/, `the fixture shows a stable age, two badges and a rounded countdown (${before})`);
  const previous = mock.queryClient.getQueryData(sessionsKey());
  resetRenders();
  // The hidden ages (30m, 10m) and the precise countdown cross a minute; nothing shown changes.
  now += 61_000;
  await poll();
  assert.equal(mock.queryClient.getQueryData(sessionsKey()), previous, 'the poll exercises structural sharing');
  assert.equal(times(), before);
  assert.equal(cardRenders(), 0, 'no card re-rendered for values it does not show');
  // Opening the Snooze menu shows the precise countdown of the current poll, and later polls keep it current while only that card renders.
  const trigger = row('snoozed').querySelector('[aria-label="Snooze session"]');
  await act(async () => trigger.click()); await tick();
  const info = () => document.querySelector('.sf-snooze-remaining')?.textContent;
  assert.equal(info(), flow.snoozePreciseRemaining(start + 2 * 86400 + 16 * 3600 + 12 * 60, now / 1000));
  assert.equal(info(), '2d 16h 11min left');
  resetRenders();
  now += 60_000;
  await poll();
  assert.equal(info(), '2d 16h 10min left', 'the open menu follows the poll');
  assert.equal(row('snoozed').querySelector('.sf-snooze-time').textContent, '3d');
  assert.equal(cardRenders(), 1, 'only the menu owner re-rendered');
  // A Done card read again shows its age as of the current poll, not the one it last rendered with.
  resetRenders();
  await act(async () => mock.queryClient.setQueryData(sessionsKey(), data => ({ ...data, sessions: data.sessions.map(item => item.id === 'done' ? { ...item, unread: false } : item) })));
  await tick();
  assert.equal(row('done').querySelector('.sf-time').textContent, flow.relative(start - 30 * 60 - 10, now / 1000));
  assert.equal(row('done').querySelector('.sf-time').textContent, '32m');
  assert.ok(cardRenders() >= 1);
  // And the age gives way to a badge again when the card becomes Done.
  await act(async () => mock.queryClient.setQueryData(sessionsKey(), data => ({ ...data, sessions: data.sessions.map(item => item.id === 'aged' ? { ...item, unread: true } : item) })));
  await tick();
  assert.match(row('aged').querySelector('.sf-time').textContent, /Done/);
});
