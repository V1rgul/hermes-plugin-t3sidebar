import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import * as mock from './sdk.mock.mjs';
import plugin, { USAGE_METRICS } from '../desktop/plugin.js';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true });
// A minimal DevTools hook, as the browser benchmark installs: it counts the function components that actually ran in each commit (a bailed-out subtree keeps its child pointer and carries no PerformedWork flag).
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
let root;
const tick = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const reset = () => { for (const name of Object.keys(renders)) delete renders[name]; };
const count = name => renders[name] || 0;
afterEach(async () => {
  if (root) { await act(async () => root.unmount()); root = null; }
  mock.control.disposers.forEach(dispose => dispose());
  mock.reset();
});
async function key(node, name) { await act(async () => node.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true }))); await tick(); }
// The static part of a chart: everything but its inspection overlay.
const staticMarkup = () => $$('.su-chart[data-metric]').map(chart => { const copy = chart.cloneNode(true); copy.querySelectorAll('.su-cross, .su-dot, .su-tip').forEach(node => node.remove()); return copy.outerHTML; }).join('');
const crosses = () => $$('.su-chart[data-metric]').map(chart => chart.querySelector('.su-cross')?.style.left ?? '').join();

test('inspecting a usage bucket redraws only the four overlays, and a fetch with unchanged data redraws no chart', async t => {
  // Every figure a chart prints goes through its metric's formatter: the total, legend, y axis and, while inspecting, the tooltip rows.
  let formatted = 0;
  for (const metric of USAGE_METRICS) { const format = metric.format; metric.format = value => { formatted++; return format(value); }; t.after(() => { metric.format = format; }); }
  // A fixed payload, so a refetch returns equal data and the query keeps its data object.
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  mock.control.usageHistory = mock.syntheticUsageHistory(7, tz);
  plugin.register(mock.ctx);
  root = createRoot($('#app'));
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, mock.control.contributions.find(item => item.id === 'usage').render())));
  await tick(); await tick();
  assert.equal($$('.su-chart[data-metric]').length, 4);
  assert.ok(count('UsageChart') >= 4, 'the charts rendered');
  const before = staticMarkup();
  reset();
  let tipRows = 0;
  const countTips = () => { tipRows += $$('.su-tip-row').length; };
  formatted = 0;
  // Keyboard inspection on one chart moves the shared bucket of all four.
  const plot = $('.su-chart[data-metric="tokens"] .su-plot');
  for (const name of ['End', 'ArrowLeft', 'ArrowLeft', 'ArrowRight']) { await key(plot, name); countTips(); }
  const keyed = crosses();
  assert.equal(new Set(keyed.split(',')).size, 1, 'the four crosshairs share one bucket');
  assert.equal($$('.su-tip').length, 4);
  // The pointer over another chart inspects the bucket under it, in all four.
  const other = $$('.su-chart[data-metric] .su-plot')[2];
  other.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 100, width: 600, height: 100, x: 0, y: 0 });
  for (const x of [10, 300, 590]) { await act(async () => other.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true, clientX: x }))); countTips(); }
  const pointed = crosses();
  assert.notEqual(pointed, keyed);
  assert.equal(new Set(pointed.split(',')).size, 1);
  // Keys continue from the bucket the pointer chose.
  await key(other, 'ArrowLeft'); countTips();
  assert.notEqual(crosses(), pointed);
  assert.equal(staticMarkup(), before, 'the charts around the overlays are the same markup');
  assert.ok(tipRows > 8 * 4, 'every step showed the four tooltips');
  assert.equal(formatted, tipRows, 'each step formatted its tooltip rows and nothing of the static chart: totals, legends and axes were not drawn again');
  assert.equal(count('AxisRangeControl'), 0, 'no period control re-rendered');
  assert.equal(count('UsageChart'), 4 * 8, 'each step re-ran the four charts for their overlays only');
  await key(other, 'Escape');
  assert.equal($$('.su-cross').length, 0);
  // A refetch in flight and its arrival with equal data change only the fetch state.
  reset();
  let release;
  mock.control.usageGate = new Promise(resolve => { release = resolve; });
  await act(async () => $('.su-refresh').click());
  await tick();
  assert.equal($('.su-refresh').dataset.spinning, 'true');
  mock.control.usageGate = null; release(); await tick(); await tick();
  assert.equal($('.su-refresh').dataset.spinning, 'false');
  assert.equal(count('UsageChart'), 0, 'an unchanged refresh redraws no chart');
  assert.equal(staticMarkup(), before);
  // New data still redraws them.
  const changed = mock.syntheticUsageHistory(7, tz);
  changed.totals = { ...changed.totals, user_messages: changed.totals.user_messages + 1 };
  changed.by_provider = changed.by_provider.map((item, index) => index ? item : { ...item, user_messages: item.user_messages.map((value, bucket) => bucket === item.user_messages.length - 1 ? value + 1 : value) });
  mock.control.usageHistory = changed;
  reset();
  await act(async () => $('.su-refresh').click());
  await tick(); await tick();
  assert.ok(count('UsageChart') >= 4, 'a refresh with new data redraws the charts');
  assert.notEqual(staticMarkup(), before);
});
