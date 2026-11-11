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
const H = 3600, D = 86400;
const tick = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
const $ = selector => document.querySelector(selector);
async function click(node) { assert.ok(node, 'element to click exists'); await act(async () => node.click()); await tick(); }
afterEach(async () => {
  if (root) { await act(async () => root.unmount()); root = null; }
  mock.control.disposers.forEach(dispose => dispose());
  mock.reset();
});

// One Codex account below 80% weekly, holding two banked resets, read a minute ago.
const pool = now => ({ generated_at: now, sampler: null, providers: [{ provider: 'openai-codex', label: 'OpenAI Codex', auth: 'ok', history: [], accounts: [{
  id: 'codex-pro', label: 'codex-pro', priority: 0, plan: 'prolite', fetched_at: now - 60, stale: false, error: null, banked_resets: 2,
  banked_credits: { fetched_at: now - 60, applicable_count: 0, credits: [1, 2].map(days => ({ status: 'available', granted_at: now - 7 * D, expires_at: now + days * D })) },
  windows: [{ key: 'weekly', label: 'Weekly', window_seconds: 604800, remaining_percent: 59, resets_at: now + 3 * D }] }] }] });
const limitsPage = () => mock.control.contributions.find(item => item.id === 'limits');
async function openLimits() {
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, limitsPage().render())));
  await tick(); await tick();
  if ($('.su-disclosure')?.getAttribute('aria-expanded') !== 'true') await click($('.su-disclosure'));
}
async function start() {
  mock.control.usageLimits = pool(Date.now() / 1000);
  plugin.register(mock.ctx);
  root = createRoot($('#app'));
  await openLimits();
}
const dialog = () => $('[role=dialog]');
const confirmButton = () => [...dialog().querySelectorAll('button')].find(node => node.textContent === 'Use reset');
const alertText = () => dialog()?.querySelector('[role=alert]')?.textContent ?? null;
const posts = () => mock.calls.filter(call => call[0] === 'rest' && call[1] === '/usage/limits/redeem').length;
const limitsReads = () => mock.calls.filter(call => call[0] === 'rest' && call[1].startsWith('/usage/limits?')).length;
const redeemButton = () => $('.su-account[data-account="codex-pro"] .su-redeem-use');
const buttonState = () => `${redeemButton().dataset.state}|${redeemButton().getAttribute('aria-disabled') ?? ''}`;
// A redeem response the test answers when it chooses.
function gatedRedeem() {
  const gate = {};
  mock.control.redeemResult = () => new Promise((resolve, reject) => Object.assign(gate, { resolve, reject }));
  return gate;
}
// Holds every usage read in flight until released.
function holdReads() {
  let release;
  mock.control.usageGate = new Promise(resolve => { release = resolve; });
  return async () => { mock.control.usageGate = null; release(); await tick(); await tick(); };
}
const UNCONFIRMED = 'Refresh to check whether it was spent.';

test('a second confirmation while a redemption is in flight sends no second request', async () => {
  await start();
  const gate = gatedRedeem();
  await click(redeemButton());
  // Both presses land before the dialog re-renders as busy, as a fast double press can on a dialog that does not lock itself.
  await act(async () => { confirmButton().click(); confirmButton().click(); });
  await tick();
  assert.equal(posts(), 1, 'one spend for two presses of one confirmation');
  await act(async () => { gate.resolve({ status: 'reset', available_count: 1, windows_reset: 1 }); });
  await tick(); await tick();
  assert.equal(posts(), 1);
  assert.equal(dialog() === null, true, 'the confirmation closes once the reset is used');
});

test('after a failed request the account cannot spend again until the limits were read again, and then only through a new confirmation', async () => {
  await start();
  mock.control.redeemResult = () => { throw new Error('502 bad gateway'); };
  const release = holdReads(), reads = limitsReads();
  await click(redeemButton());
  await click(confirmButton());
  assert.equal(alertText(), `The reset could not be used: 502 bad gateway. ${UNCONFIRMED}`);
  assert.equal(posts(), 1);
  // The outcome is unknown: pressing again in the same confirmation must not spend a second credit.
  mock.control.redeemResult = { status: 'reset', available_count: 1, windows_reset: 1 };
  await click(confirmButton());
  assert.equal(posts(), 1, 'no second request before the limits were read again');
  assert.match(alertText(), /Refresh to check whether it was spent\.$/);
  await click([...dialog().querySelectorAll('button')].find(node => node.textContent === 'Cancel'));
  assert.equal(buttonState(), 'locked|true', 'the account shows its reset as unavailable while the outcome is unknown');
  await click(redeemButton());
  assert.equal(dialog() === null, true, 'a locked reset opens no confirmation');
  // The unknown outcome asked for a re-read; once it completes the action comes back, and a new confirmation may spend.
  await release();
  assert.ok(limitsReads() > reads, 'the limits are read again after the unknown outcome');
  assert.equal(buttonState(), 'usable|');
  await click(redeemButton());
  await click(confirmButton());
  assert.equal(posts(), 2, 'a new confirmation after the re-read spends');
  assert.equal(dialog() === null, true);
});

test('an answer that neither confirms nor refuses the reset blocks the same confirmation, while a definite refusal does not', async () => {
  await start();
  mock.control.redeemResult = { status: 'not_exhausted', available_count: 2, windows_reset: 0 };
  await click(redeemButton());
  await click(confirmButton());
  assert.match(alertText(), /was not spent/);
  mock.control.redeemResult = { status: 'unavailable' };
  await click(confirmButton());
  assert.equal(posts(), 2, 'a definite refusal leaves the confirmation usable');
  assert.match(alertText(), /^Codex could not confirm the reset\./);
  // Even once the limits were read again, this confirmation was given before the unknown outcome.
  await tick(); await tick();
  mock.control.redeemResult = { status: 'reset', available_count: 1, windows_reset: 1 };
  await click(confirmButton());
  assert.equal(posts(), 2, 'a confirmation given before an unknown outcome cannot spend again');
});

test('an outcome that returns after the Source changed is not a success, and the account waits for a newer read', async () => {
  await start();
  const gate = gatedRedeem();
  await click(redeemButton());
  await act(async () => confirmButton().click());
  await tick();
  assert.equal(posts(), 1);
  // Away and back while the request is still in flight: the page returns under a new activation with a fresh read.
  await act(async () => mock.switchScope('source-b'));
  await tick();
  await act(async () => mock.switchScope('source-a'));
  await openLimits();
  assert.equal(buttonState(), 'usable|');
  // The old page's request now succeeds; the read the new page shows predates it.
  await act(async () => { gate.resolve({ status: 'reset', available_count: 1, windows_reset: 1 }); });
  await tick(); await tick();
  mock.control.redeemResult = { status: 'reset', available_count: 0, windows_reset: 1 };
  const release = holdReads();
  await click(redeemButton());
  if (dialog()) { await click(confirmButton()); assert.match(alertText(), /Refresh to check whether it was spent\.$/); }
  assert.equal(posts(), 1, 'no second spend on a read older than the first outcome');
  await release();
});
