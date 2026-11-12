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
const tick = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
afterEach(async () => {
  if (root) { await act(async () => root.unmount()); root = null; }
  mock.control.disposers.forEach(dispose => dispose());
  mock.reset();
});

test('the Limits chart grid keeps its 22px top margin and every split badge half its primary tone', async () => {
  plugin.register(mock.ctx);
  root = createRoot(document.querySelector('#app'));
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, mock.control.contributions.find(item => item.id === 'limits').render())));
  await tick(); await tick();
  const grids = [...document.querySelectorAll('.su-limits-grid')];
  assert.ok(grids.length > 0);
  assert.deepEqual([...new Set(grids.map(grid => window.getComputedStyle(grid).marginTop))], ['22px']);
  for (const disclosure of document.querySelectorAll('.su-disclosure')) await act(async () => disclosure.click());
  await tick();
  const halves = [...document.querySelectorAll('.su-badge-half')];
  assert.ok(halves.length > 0, 'the account cards show their plan and priority badges');
  assert.deepEqual([...new Set(halves.map(half => half.dataset.tone))], ['primary'], 'the split badge styles only the primary tone');
});
