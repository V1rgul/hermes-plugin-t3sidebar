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
afterEach(async () => {
  if (root) { await act(async () => root.unmount()); root = null; }
  mock.control.disposers.forEach(dispose => dispose());
  mock.reset();
});

test('a vertical swipe over a Usage or Limits chart still scrolls the page', async () => {
  plugin.register(mock.ctx);
  root = createRoot(document.querySelector('#app'));
  for (const id of ['usage', 'limits']) {
    await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, mock.control.contributions.find(item => item.id === id).render())));
    await tick(); await tick();
    assert.ok(document.querySelector('.su-plot'), `${id} draws a chart`);
    const css = document.querySelector('.su > style').textContent;
    // The charts only read the pointer position, so the browser keeps vertical panning; horizontal moves stay with the inspection.
    const rules = [...css.matchAll(/(^|\})\s*([^{}]*\.su-plot[^{}]*)\{([^}]*)\}/g)].filter(match => /touch-action/.test(match[3])).map(match => `${match[2].trim()}{${match[3].match(/touch-action:[^;]+/)[0]}}`);
    assert.deepEqual(rules, ['.su-plot{touch-action:pan-y}'], id);
  }
});
