import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import * as mock from './sdk.mock.mjs';
import plugin, * as flow from '../desktop/plugin.js?performance-test';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
let root;
const tick = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
afterEach(async () => {
  if (root) { await act(async () => root.unmount()); root = null; }
  mock.control.disposers.forEach(dispose => dispose());
  mock.reset();
});

// The pooled chart's hover lookups as they were before the binary search, frozen as the reference.
function referencePastAt(past, t) { let value = null; for (const point of past) { if (point.t > t) break; value = point.value; } return value; }
function referenceProjectedAt(points, t) {
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1], b = points[index];
    if (t >= a.t && t <= b.t) return b.t === a.t ? b.value : a.value + (b.value - a.value) * (t - a.t) / (b.t - a.t);
  }
  return null;
}
// Deterministic generator (mulberry32), so a failing case is reproducible from its seed.
function random(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let value = Math.imul(seed ^ seed >>> 15, 1 | seed); value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value; return ((value ^ value >>> 14) >>> 0) / 4294967296; };
}
// Ascending times with repeats (a projection repeats a reset's time for its step up), sometimes a run of three.
function series(rng, length, repeats) {
  const points = [];
  let t = Math.floor(rng() * 100);
  for (let index = 0; index < length; index++) {
    if (!(index && repeats && rng() < 0.3)) t += 1 + Math.floor(rng() * 50);
    points.push({ t, value: Math.round(rng() * 2000) / 10 });
  }
  return points;
}
const probes = (rng, points) => {
  const times = points.map(point => point.t);
  const first = times[0] ?? 0, last = times.at(-1) ?? 0;
  return [...times, ...times.map(t => t + 0.5), ...times.map(t => t - 0.25), first - 1, last + 1, rng() * (last - first) + first, -Infinity, Infinity, NaN];
};

test('the hover lookups give what the forward scans gave, including repeated reset times and the ends', () => {
  let cases = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const rng = random(seed);
    const length = Math.floor(rng() * 40);
    // The past is one point per distinct time; the projection repeats the time of every reset.
    const past = series(rng, length, false), projected = series(rng, length, true);
    for (const t of probes(rng, past)) { assert.equal(Object.is(flow.stepValueAt(past, t), referencePastAt(past, t)), true, `past seed ${seed} t ${t}`); cases++; }
    for (const t of probes(rng, projected)) { assert.equal(Object.is(flow.linearValueAt(projected, t), referenceProjectedAt(projected, t)), true, `projected seed ${seed} t ${t}`); cases++; }
  }
  assert.ok(cases > 20000, 'the generated cases cover many lookups');
  // At a reset's repeated time the projection reads the level arriving at the reset, not the refilled one; just after it, the refilled level.
  const reset = [{ t: 0, value: 10 }, { t: 5, value: 5 }, { t: 5, value: 20 }, { t: 10, value: 15 }];
  assert.equal(flow.linearValueAt(reset, 5), 5);
  assert.equal(flow.linearValueAt(reset, 7.5), 17.5);
  assert.equal(flow.linearValueAt([{ t: 3, value: 1 }, { t: 3, value: 9 }, { t: 3, value: 4 }], 3), 9);
  // Outside the projection, before the first reading and with no points at all, there is no value.
  assert.equal(flow.linearValueAt(reset, -1), null);
  assert.equal(flow.linearValueAt(reset, 11), null);
  assert.equal(flow.linearValueAt([{ t: 1, value: 2 }], 1), null);
  assert.equal(flow.stepValueAt([{ t: 1, value: 2 }, { t: 4, value: 3 }], 0.5), null);
  assert.equal(flow.stepValueAt([{ t: 1, value: 2 }, { t: 4, value: 3 }], 4), 3);
  assert.equal(flow.stepValueAt([], 4), null);
});

test('a hover lookup reads a logarithmic number of points, not the whole series', () => {
  const rng = random(7), past = series(rng, 4096, false), projected = series(rng, 4096, true);
  let reads = 0;
  const counted = points => new Proxy(points, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); } });
  const pastProxy = counted(past), projectedProxy = counted(projected);
  let worst = 0;
  for (const share of [0, 0.25, 0.5, 0.75, 0.999, 1.01]) {
    const t = past[0].t + share * (past.at(-1).t - past[0].t);
    reads = 0; flow.stepValueAt(pastProxy, t); worst = Math.max(worst, reads);
    const u = projected[0].t + share * (projected.at(-1).t - projected[0].t);
    reads = 0; flow.linearValueAt(projectedProxy, u); worst = Math.max(worst, reads);
  }
  // Twelve halvings of 4,096 points, plus the segment's two ends.
  assert.ok(worst <= 2 * 12 + 4, `at most a few dozen point reads per lookup (worst ${worst})`);
});

// The overview's window catalog reads every history series of every provider; count those reads through the series' window field.
function countWindowReads(data) {
  const counter = { reads: 0 };
  for (const provider of data.providers) for (const item of provider.history || []) {
    const value = item.window;
    Object.defineProperty(item, 'window', { enumerable: true, configurable: true, get() { counter.reads++; return value; } });
  }
  return counter;
}
const limitsData = () => mock.queryClient.getQueryCache().getAll().map(query => query.state.data).find(data => Array.isArray(data?.providers));
async function renderLimits() {
  plugin.register(mock.ctx);
  root = createRoot(document.querySelector('#app'));
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, mock.control.contributions.find(item => item.id === 'limits').render())));
  await tick(); await tick();
}
const windowButtons = () => [...document.querySelectorAll('.su-limits-controls [role="group"][aria-label="Window"] button')].map(button => button.textContent);
const chartWindows = () => [...document.querySelectorAll('.su-pooled')].map(chart => chart.dataset.window);

test('folding accounts and a fetch in flight do not read the limits history again, while a refresh with a new window does', async () => {
  // A fixed payload, so the query's data object stays the same across refetches.
  const payload = mock.syntheticUsageLimits(168);
  mock.control.usageLimits = payload;
  await renderLimits();
  const counter = countWindowReads(limitsData());
  assert.ok(document.querySelectorAll('.su-pooled').length >= 2, 'the fixture charts several providers');
  assert.deepEqual(windowButtons(), ['5-hour', 'Weekly']);
  // Folding accounts re-renders the page, not its data.
  await act(async () => document.querySelector('.su-disclosure').click());
  await tick();
  assert.equal(document.querySelector('.su-disclosure').getAttribute('aria-expanded'), 'true');
  await act(async () => document.querySelector('.su-disclosure').click());
  await tick();
  assert.equal(counter.reads, 0, 'a fold reads no history');
  // A refetch held in flight changes only the fetch state the toolbar shows.
  let release;
  mock.control.usageGate = new Promise(resolve => { release = resolve; });
  const refetch = mock.queryClient.refetchQueries({ predicate: query => Array.isArray(query.state.data?.providers) });
  await tick(); await tick();
  assert.equal(counter.reads, 0, 'a fetch in flight reads no history');
  // The refresh brings a window only Codex's history still holds (no account reports it), so the catalog is rebuilt from the new data.
  const codex = payload.providers.find(item => item.provider === 'openai-codex');
  const old = codex.history[0];
  mock.control.usageLimits = { ...payload, providers: payload.providers.map(item => item === codex ? { ...item, history: [...item.history, { ...old, window: 'w7200' }] } : item) };
  delete mock.control.usageGate;
  release();
  await act(async () => { await refetch; });
  await tick(); await tick();
  assert.deepEqual(windowButtons(), ['5-hour', 'Weekly', 'w7200'], 'the historical-only window joins the shared selector under its key');
  await act(async () => [...document.querySelectorAll('.su-limits-controls [role="group"][aria-label="Window"] button')].find(button => button.textContent === 'w7200').click());
  await tick(); await tick();
  // Codex charts it; Anthropic, which has no such window, falls back to its weekly one.
  assert.deepEqual(chartWindows(), ['w7200', 'weekly']);
});
