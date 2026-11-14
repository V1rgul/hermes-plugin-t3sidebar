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
let root, restore = null;
const H = 3600;
const tick = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
afterEach(async () => {
  if (root) { await act(async () => root.unmount()); root = null; }
  restore?.(); restore = null;
  mock.control.disposers.forEach(dispose => dispose());
  mock.reset();
});

// jsdom has no layout: a 400px marks layer, and every mark label 60px wide beside its mark's x (from the mark's left percentage), on the side placement chose.
const PLOT_W = 400;
const rect = (left, width, top, height) => ({ left, right: left + width, top, bottom: top + height, width, height, x: left, y: top });
let layerReads = 0;
function stubGeometry() {
  const original = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains('su-marks')) { layerReads++; return rect(0, PLOT_W, 0, 200); }
    const anchor = this.closest('.su-reset, .su-waste');
    if (!anchor) return original.call(this);
    const x = parseFloat(anchor.style.left) / 100 * PLOT_W;
    if (this.matches('.su-waste-text, .su-reset-text')) return this.dataset.side === 'left' ? rect(x - 66, 60, 90, 10) : rect(x + 6, 60, 90, 10);
    if (this.matches('.su-reset-dot')) return rect(x - 3, 6, 92, 6);
    return rect(x, 0, 0, 200);
  };
  restore = () => { window.HTMLElement.prototype.getBoundingClientRect = original; };
}
// One account at 50% weekly, resetting in 20 hours with no drain: one projected reset that restores and one that discards 50 units, both inside the 1-day and the 7-day projection, and nothing else to mark.
function onePool(now) {
  return { generated_at: now, sampler: null, providers: [{ provider: 'openai-codex', label: 'OpenAI Codex', auth: 'ok', history: [], accounts: [{
    id: 'solo', label: 'solo', priority: 0, plan: 'prolite', fetched_at: now - 60, stale: false, error: null, banked_resets: 0,
    windows: [{ key: 'weekly', label: 'Weekly', window_seconds: 604800, remaining_percent: 50, resets_at: now + 20 * H }] }] }] };
}
const labels = () => [...document.querySelectorAll('.su-marks .su-waste-text, .su-marks .su-reset-text')].map(node => `${node.className}:${node.dataset.side}:${node.dataset.hidden}`);

test('a range change that keeps the same marks places their labels again for the new positions', async () => {
  stubGeometry();
  mock.control.usageLimits = onePool(Date.now() / 1000);
  plugin.register(mock.ctx);
  root = createRoot(document.querySelector('#app'));
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, mock.control.contributions.find(item => item.id === 'limits').render())));
  await tick(); await tick();
  const marks = () => [...document.querySelectorAll('.su-marks > [data-t]')].map(node => `${node.className}@${node.dataset.t}`);
  const before = marks();
  assert.deepEqual(before.map(item => item.split('@')[0]).sort(), ['su-reset', 'su-waste']);
  // Mid-plot, the expiry label takes the right side and the restore label the left.
  assert.deepEqual(labels(), ['su-reset-text:left:false', 'su-waste-text:right:false']);
  // A 1-day projection moves the same marks next to the plot's right edge.
  await act(async () => document.querySelector('.su-axis-range[data-side="future"] .su-axis-step[data-direction="left"]').click());
  await tick(); await tick();
  assert.equal(document.querySelector('.su-pooled').dataset.future, '24');
  assert.deepEqual(marks(), before, 'the marks themselves are the same');
  assert.deepEqual(labels(), ['su-reset-text:right:true', 'su-waste-text:left:false'], 'no label is left where it would leave the plot or cover another');
  // A render that moves nothing does not place them again.
  layerReads = 0;
  await act(async () => document.querySelector('.su-disclosure').click());
  await tick();
  assert.equal(layerReads, 0, 'unfolding the accounts re-renders the chart without measuring its marks');
});
