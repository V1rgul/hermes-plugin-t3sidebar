import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import * as mock from './sdk.mock.mjs';
import plugin from '../desktop/plugin.js';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const originalRest = mock.ctx.rest, originalNow = Date.now;
let root, clock;
const tick = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
const $ = selector => document.querySelector(selector);
// The clock only moves when the test says so, so the order of outcome, read start and confirmation is explicit.
const advance = () => { clock += 100; };
async function click(node) { assert.ok(node, 'element to click exists'); await act(async () => node.click()); await tick(); }
const redeemButton = id => $(`.su-account[data-account="${id}"] .su-redeem-use`);
const dialogButton = label => [...document.querySelectorAll('[role=dialog] button')].find(node => node.textContent === label);
const postedAccounts = () => mock.calls.filter(call => call[0] === 'rest' && call[1] === '/usage/limits/redeem').map(call => call[2].body.account);
afterEach(async () => {
  if (root) { await act(async () => root.unmount()); root = null; }
  mock.control.disposers.forEach(dispose => dispose());
  mock.reset();
  mock.ctx.rest = originalRest; Date.now = originalNow;
});

// Two Codex accounts at 50% weekly, each holding banked resets, read a minute ago.
const pool = () => { const now = Date.now() / 1000; return { generated_at: now, sampler: null, providers: [{ provider: 'openai-codex', label: 'OpenAI Codex', auth: 'ok', history: [], accounts: ['a', 'b'].map(id => ({
  id, label: id, plan: 'prolite', priority: 0, fetched_at: now - 60, stale: false, error: null, banked_resets: 2,
  windows: [{ key: 'weekly', label: 'Weekly', window_seconds: 604800, remaining_percent: 50, resets_at: now + 86400 }] })) }] }; };
async function expand() { if ($('.su-disclosure')?.getAttribute('aria-expanded') === 'false') await click($('.su-disclosure')); }
async function open(view = 'limits') {
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, mock.control.contributions.find(item => item.id === view).render())));
  await tick(); await tick();
  if (view === 'limits') await expand();
}
async function start(source) {
  clock = 2_000_000_000_000; Date.now = () => clock;
  mock.switchScope(source);
  mock.control.usageLimits = pool();
  plugin.register(mock.ctx);
  root = createRoot($('#app'));
  await open();
}
// Every redeem response is answered by the test.
function gatedRedeems() {
  const gates = [];
  mock.control.redeemResult = ({ account }) => new Promise((resolve, reject) => gates.push({ account, resolve, reject }));
  return gates;
}
// Every limits read is answered by the test, one by one, with the snapshot taken when it started.
function gatedReads() {
  const reads = [];
  mock.ctx.rest = (path, options) => {
    if (!path.startsWith('/usage/limits?')) return originalRest(path, options);
    mock.calls.push(['rest', path, options]);
    const value = structuredClone(mock.control.usageLimits);
    return new Promise(resolve => reads.push({ resolve: () => resolve(value) }));
  };
  return reads;
}
async function deliver(read) { advance(); await act(async () => read.resolve()); await tick(); await tick(); await expand(); }
async function confirm(id) { advance(); await click(redeemButton(id)); await click(dialogButton('Use reset')); }

test('a limits read already under way when a returned Source/profile learns of an unknown outcome does not release the reset', async () => {
  await start('pre-outcome-aba');
  const source = mock.host.state.connectionId.get(), gates = gatedRedeems();
  await confirm('a');
  assert.deepEqual(postedAccounts(), ['a']);
  // The Source changes and comes back while the request is in transit; the page opened again starts its first limits read, which the test holds.
  await act(async () => mock.switchScope('pre-outcome-away')); await open();
  const reads = gatedReads();
  await act(async () => mock.switchScope(source)); await open();
  assert.equal(reads.length, 1, 'the returned page started one limits read');
  // The old request now reports a reset, which cannot be credited to the activation now shown, so the outcome stays unknown.
  advance(); await act(async () => gates[0].resolve({ status: 'reset', available_count: 1, windows_reset: 2 })); await tick(); await tick();
  // The held read was answered from before the outcome.
  await deliver(reads[0]);
  mock.control.redeemResult = { status: 'not_exhausted' };
  if (redeemButton('a')) { await confirm('a'); if ($('[role=dialog]')) await click(dialogButton('Cancel')); }
  assert.deepEqual(postedAccounts(), ['a'], 'a read that started before the outcome cannot allow a second spend');
  // A read started after the outcome settles it, and a new confirmation may then spend.
  assert.equal(reads.length, 2, 'the outcome started a newer limits read');
  await deliver(reads[1]);
  assert.equal(redeemButton('a').dataset.state, 'usable', 'a newer read releases the account');
  await confirm('a');
  assert.deepEqual(postedAccounts(), ['a', 'a'], 'a confirmation opened after the newer read may spend');
});

test('a limits read left running by a closed Limits page does not release the reset it predates', async () => {
  await start('pre-outcome-left');
  const reads = gatedReads();
  // A refresh is under way when the reset is confirmed.
  advance(); await click($('.su-refresh'));
  assert.equal(reads.length, 1);
  const gates = gatedRedeems();
  await confirm('a');
  // The Limits page is left for the Usage page, so the refresh keeps running without the page.
  await open('usage');
  advance(); await act(async () => gates[0].reject(new Error('transport failed after dispatch'))); await tick(); await tick();
  // The Limits page opened again finds the old refresh answered from before the outcome.
  await open('limits');
  await deliver(reads[0]);
  mock.control.redeemResult = { status: 'not_exhausted' };
  assert.equal(redeemButton('a').dataset.state, 'locked', 'the account still waits for a newer read');
  await click(redeemButton('a'));
  if (dialogButton('Use reset')) { await click(dialogButton('Use reset')); await click(dialogButton('Cancel')); }
  assert.deepEqual(postedAccounts(), ['a'], 'a read that started before the outcome cannot allow a second spend');
  const newer = reads.at(-1);
  assert.equal(reads.length > 1, true, 'opening the page again started a newer limits read');
  await deliver(newer);
  assert.equal(redeemButton('a').dataset.state, 'usable', 'a newer read releases the account');
  await confirm('a');
  assert.deepEqual(postedAccounts(), ['a', 'a'], 'a confirmation opened after the newer read may spend');
});
