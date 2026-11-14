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
const tick = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const $ = selector => document.querySelector(selector);
async function click(node) { assert.ok(node, 'element to click exists'); await act(async () => node.click()); await tick(); }
const redeemButton = id => $(`.su-account[data-account="${id}"] .su-redeem-use`);
const dialogButton = label => [...document.querySelectorAll('[role=dialog] button')].find(node => node.textContent === label);
const postedAccounts = () => mock.calls.filter(call => call[0] === 'rest' && call[1] === '/usage/limits/redeem').map(call => call[2].body.account);
const limitsQuery = () => mock.queryClient.getQueryCache().findAll({ queryKey: ['hermes-t3sidebar-usage', mock.host.state.connectionId.get(), mock.host.state.profile.get(), mock.epoch] }).find(query => query.queryKey[4] === 'limits');
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
async function start(source) {
  clock = 2_000_000_000_000; Date.now = () => clock;
  mock.switchScope(source);
  mock.control.usageLimits = pool();
  plugin.register(mock.ctx);
  root = createRoot($('#app'));
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, mock.control.contributions.find(item => item.id === 'limits').render())));
  await tick(); await tick();
  await expand();
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
async function deliver(read) { await act(async () => read.resolve()); await tick(); await tick(); await expand(); }
// Opens the confirmation and confirms it when it opens; a locked account opens none.
async function tryRedeem(id) {
  await click(redeemButton(id));
  if (!dialogButton('Use reset')) return;
  await click(dialogButton('Use reset'));
  if (dialogButton('Cancel')) await click(dialogButton('Cancel'));
}

test('a limits read answered before an unknown outcome but published after it does not release the reset', async () => {
  await start('read-start-order-published-late');
  const reads = gatedReads(), gates = gatedRedeems();
  clock += 100; await click($('.su-refresh'));
  assert.equal(reads.length, 1, 'a refresh is under way');
  clock += 100; await click(redeemButton('a')); await click(dialogButton('Use reset'));
  assert.deepEqual(postedAccounts(), ['a']);
  // The refresh is answered and the request fails in transit in the same turn: the read's answer is complete before the outcome is recorded, and is put into the cache only after it, when no cancellation can stop it any more. A millisecond passes in between, as it would with a slower continuation.
  clock += 100;
  await act(async () => {
    reads[0].resolve(); gates[0].reject(new Error('transport outcome unknown'));
    queueMicrotask(() => queueMicrotask(() => { clock += 1; }));
  });
  await tick(); await tick();
  await click(dialogButton('Cancel'));
  assert.equal(reads.length, 2, 'the outcome started a newer read');
  assert.equal(limitsQuery().state.fetchStatus, 'fetching', 'the newer read is not answered yet');
  mock.control.redeemResult = { status: 'not_exhausted' };
  await tryRedeem('a');
  assert.deepEqual(postedAccounts(), ['a'], 'a read that started before the outcome cannot allow a second spend');
  assert.equal(redeemButton('a').dataset.state, 'locked', 'the account waits for the newer read');
  // The read started after the outcome releases the account, and a new confirmation may spend.
  await deliver(reads[1]);
  assert.equal(redeemButton('a').dataset.state, 'usable');
  await tryRedeem('a');
  assert.deepEqual(postedAccounts(), ['a', 'a'], 'a confirmation opened after the newer read may spend');
});

test('a limits read started after an unknown outcome within the same millisecond releases the reset', async () => {
  await start('read-start-order-same-millisecond');
  const gates = gatedRedeems();
  // The clock stands still from here on: outcome, newer read and confirmation share one millisecond.
  clock += 100;
  await click(redeemButton('a')); await click(dialogButton('Use reset'));
  const reads = gatedReads();
  await act(async () => gates[0].reject(new Error('transport outcome unknown'))); await tick(); await tick();
  await click(dialogButton('Cancel'));
  assert.equal(reads.length, 1, 'the outcome started a newer read');
  assert.equal(redeemButton('a').dataset.state, 'locked');
  await deliver(reads[0]);
  assert.equal(redeemButton('a').dataset.state, 'usable', 'the newer read releases the account although it finished in the same millisecond');
  mock.control.redeemResult = { status: 'not_exhausted' };
  await tryRedeem('a');
  assert.deepEqual(postedAccounts(), ['a', 'a'], 'a confirmation opened after the newer read may spend');
});
