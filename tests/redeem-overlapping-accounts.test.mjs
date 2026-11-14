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
afterEach(async () => {
  if (root) { await act(async () => root.unmount()); root = null; }
  mock.control.disposers.forEach(dispose => dispose());
  mock.reset();
});

// Two Codex accounts at 50% weekly, each holding banked resets, read a minute ago.
const pool = now => ({ generated_at: now, sampler: null, providers: [{ provider: 'openai-codex', label: 'OpenAI Codex', auth: 'ok', history: [], accounts: ['a', 'b'].map(id => ({
  id, label: id, plan: 'prolite', priority: 0, fetched_at: now - 60, stale: false, error: null, banked_resets: 2,
  windows: [{ key: 'weekly', label: 'Weekly', window_seconds: 604800, remaining_percent: 50, resets_at: now + 86400 }] })) }] });
async function openLimits() {
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, mock.control.contributions.find(item => item.id === 'limits').render())));
  await tick(); await tick();
  if ($('.su-disclosure')?.getAttribute('aria-expanded') !== 'true') await click($('.su-disclosure'));
}
const redeemButton = id => $(`.su-account[data-account="${id}"] .su-redeem-use`);
const dialogButton = label => [...document.querySelectorAll('[role=dialog] button')].find(node => node.textContent === label);
const postedAccounts = () => mock.calls.filter(call => call[0] === 'rest' && call[1] === '/usage/limits/redeem').map(call => call[2].body.account);
// Every redeem response is answered by the test, per account.
function gatedRedeems() {
  const gates = {};
  mock.control.redeemResult = ({ account }) => new Promise((resolve, reject) => { gates[account] = { resolve, reject }; });
  return gates;
}
function holdReads() {
  let release;
  mock.control.usageGate = new Promise(resolve => { release = resolve; });
  return async () => { mock.control.usageGate = null; release(); await tick(); await tick(); };
}

test('a later unknown outcome for a second account keeps the first account waiting for a newer limits read', async () => {
  mock.control.usageLimits = pool(Date.now() / 1000);
  plugin.register(mock.ctx);
  root = createRoot($('#app'));
  await openLimits();
  const gates = gatedRedeems();
  await click(redeemButton('a')); await click(dialogButton('Use reset'));
  assert.deepEqual(postedAccounts(), ['a']);
  // The page is left and opened again while account a's request is still in transit.
  await act(async () => root.render(null));
  await openLimits();
  await click(redeemButton('b')); await click(dialogButton('Use reset'));
  assert.deepEqual(postedAccounts(), ['a', 'b']);
  const release = holdReads();
  await act(async () => gates.a.reject(new Error('transport failed after dispatch')));
  await tick();
  await act(async () => gates.b.reject(new Error('409: redeem_in_progress')));
  await tick();
  await click(dialogButton('Cancel'));
  assert.deepEqual(['a', 'b'].map(id => redeemButton(id).dataset.state), ['locked', 'locked'], 'both uncertain accounts show as waiting');
  // A definite refusal from here on would not lock anything, so only the uncertainty guard can hold this request back.
  mock.control.redeemResult = { status: 'not_exhausted' };
  await click(redeemButton('a'));
  if (dialogButton('Use reset')) await click(dialogButton('Use reset'));
  assert.deepEqual(postedAccounts(), ['a', 'b'], 'account a is not spent again before the limits were read again');
  if ($('[role=dialog]')) await click(dialogButton('Cancel'));
  await release();
  assert.deepEqual(['a', 'b'].map(id => redeemButton(id).dataset.state), ['usable', 'usable'], 'a newer limits read releases both accounts');
  await click(redeemButton('a')); await click(dialogButton('Use reset'));
  assert.deepEqual(postedAccounts(), ['a', 'b', 'a'], 'a confirmation opened after the read may spend');
  // The definite refusal keeps the confirmation open with its reason and does not lock the account.
  await click(dialogButton('Use reset'));
  assert.deepEqual(postedAccounts(), ['a', 'b', 'a', 'a'], 'a definite refusal never locks the action');
});
