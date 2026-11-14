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
const original = mock.icons.Pencil;
afterEach(async () => {
  if (root) { await act(async () => root.unmount()); root = null; }
  mock.icons.Pencil = original;
  mock.control.disposers.forEach(dispose => dispose());
  mock.reset();
});
// The chart's markup without the hover overlay (crosshair and inline tooltip).
const staticMarkup = chart => { const copy = chart.cloneNode(true); copy.querySelectorAll('.su-cross, .su-tip-inline').forEach(node => node.remove()); return copy.outerHTML; };

test('inspecting the pooled limits chart draws only the overlay and leaves the chart itself untouched', async () => {
  // The averaging label's edit button draws a pencil on every render of its chart.
  let pencils = 0;
  mock.icons.Pencil = props => { pencils++; return original(props); };
  plugin.register(mock.ctx);
  root = createRoot(document.querySelector('#app'));
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, mock.control.contributions.find(item => item.id === 'limits').render())));
  await tick(); await tick();
  const chart = document.querySelector('.su-pooled'), plot = chart.querySelector('.su-plot');
  assert.ok(pencils > 0, 'the chart draws its averaging label');
  const before = chart.outerHTML;
  assert.equal(chart.querySelector('.su-cross') === null, true);
  pencils = 0;
  const keys = async name => { await act(async () => plot.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true }))); };
  await keys('ArrowRight'); await keys('ArrowRight'); await keys('ArrowLeft');
  assert.equal(chart.querySelectorAll('.su-cross').length, 1, 'the keyboard inspects the chart');
  assert.match(chart.querySelector('.su-tip-inline').textContent, / units left/);
  assert.equal(staticMarkup(chart), before, 'everything but the overlay is the same markup while inspecting');
  // A pointer over the plot inspects the time under it.
  plot.getBoundingClientRect = () => ({ left: 100, top: 0, right: 600, bottom: 200, width: 500, height: 200, x: 100, y: 0 });
  for (const x of [150, 400, 590]) await act(async () => plot.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true, clientX: x })));
  assert.equal(chart.querySelector('.su-cross').style.left, '98%');
  assert.equal(staticMarkup(chart), before);
  assert.equal(pencils, 0, 'no inspection step re-rendered the chart');
  await keys('Escape');
  assert.equal(chart.outerHTML, before, 'leaving inspection restores the exact markup');
});
