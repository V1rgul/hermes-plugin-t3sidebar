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
let root;
const tick = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const $ = selector => document.querySelector(selector);
async function click(node) { assert.ok(node, 'element to click exists'); await act(async () => node.click()); await tick(); }
const redeemButton = id => $(`.su-account[data-account="${id}"] .su-redeem-use`);
const dialogButton = label => [...document.querySelectorAll('[role=dialog] button')].find(node => node.textContent === label);
const postedAccounts = () => mock.calls.filter(call => call[0] === 'rest' && call[1] === '/usage/limits/redeem').map(call => call[2].body.account);
afterEach(async () => {
  if (root) { await act(async () => root.unmount()); root = null; }
  mock.control.disposers.forEach(dispose => dispose());
  mock.reset();
});

// One Codex account at 50% weekly, holding banked resets, read a minute ago.
const pool = now => ({ generated_at: now, sampler: null, providers: [{ provider: 'openai-codex', label: 'OpenAI Codex', auth: 'ok', history: [], accounts: [{
  id: 'a', label: 'a', plan: 'prolite', priority: 0, fetched_at: now - 60, stale: false, error: null, banked_resets: 2,
  windows: [{ key: 'weekly', label: 'Weekly', window_seconds: 604800, remaining_percent: 50, resets_at: now + 86400 }] }] }] });
async function openLimits() {
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, mock.control.contributions.find(item => item.id === 'limits').render())));
  await tick(); await tick();
  if ($('.su-disclosure')?.getAttribute('aria-expanded') === 'false') await click($('.su-disclosure'));
}
// Every redeem response is answered by the test.
function gatedRedeem() {
  const gate = {};
  mock.control.redeemResult = () => new Promise((resolve, reject) => Object.assign(gate, { resolve, reject }));
  return gate;
}
// Holds every usage read in flight until released.
function holdReads() {
  let release;
  mock.control.usageGate = new Promise(resolve => { release = resolve; });
  return async () => { mock.control.usageGate = null; await act(async () => release()); await tick(); await tick(); };
}

test('a page opened again shows the account waiting when an attempt from the previous page ends without a known outcome', async () => {
  mock.control.usageLimits = pool(Date.now() / 1000);
  plugin.register(mock.ctx);
  root = createRoot($('#app'));
  await openLimits();
  const source = mock.host.state.connectionId.get(), gate = gatedRedeem();
  await click(redeemButton('a')); await click(dialogButton('Use reset'));
  assert.deepEqual(postedAccounts(), ['a']);
  // Away and back while the request is in transit: the page opened again has read the limits before the outcome.
  await act(async () => mock.switchScope('reopened-away')); await openLimits();
  await act(async () => mock.switchScope(source)); await openLimits();
  assert.equal(redeemButton('a').dataset.state, 'usable');
  // The old page's request reports a reset that cannot be credited to this activation; the newer read it starts is held.
  const release = holdReads();
  await act(async () => gate.resolve({ status: 'reset', available_count: 1, windows_reset: 2 })); await tick(); await tick();
  assert.equal(redeemButton('a').dataset.state, 'locked', 'the page opened again shows the account waiting for the newer read');
  assert.deepEqual(postedAccounts(), ['a']);
  await release();
  assert.equal(redeemButton('a').dataset.state, 'usable', 'the newer read releases the account');
  mock.control.redeemResult = { status: 'not_exhausted' };
  await click(redeemButton('a')); await click(dialogButton('Use reset'));
  assert.deepEqual(postedAccounts(), ['a', 'a'], 'a confirmation opened after the newer read may spend');
});
