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
const original = mock.icons.ChevronRight;
afterEach(async () => {
  if (root) { await act(async () => root.unmount()); root = null; }
  mock.icons.ChevronRight = original;
  mock.control.disposers.forEach(dispose => dispose());
  mock.reset();
});

test('unfolding one provider\'s accounts re-renders that provider only', async () => {
  // Every provider section draws one disclosure chevron per render, so the chevron counts section renders by provider.
  const renders = [];
  mock.icons.ChevronRight = props => { renders.push(null); return original(props); };
  plugin.register(mock.ctx);
  root = createRoot(document.querySelector('#app'));
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, mock.control.contributions.find(item => item.id === 'limits').render())));
  await tick(); await tick();
  const sections = [...document.querySelectorAll('.su-provider-limits:not(.su-logged-out)')];
  assert.ok(sections.length >= 2, 'the fixture shows several providers');
  const pooled = () => sections.map(section => section.querySelector('.su-pooled')?.dataset.capacity ?? '');
  const before = pooled();
  renders.length = 0;
  await act(async () => sections[0].querySelector('.su-disclosure').click());
  await tick(); await tick();
  assert.equal(sections[0].querySelector('.su-disclosure').getAttribute('aria-expanded'), 'true');
  assert.equal(renders.length, 1, 'only the unfolded provider\'s section rendered again');
  assert.deepEqual(pooled(), before, 'the charts are unchanged');
  // Chart preferences still reach every provider.
  renders.length = 0;
  const step = sections[1].querySelector('.su-axis-range[data-side="future"] .su-axis-step:not([disabled])');
  await act(async () => step.click());
  await tick(); await tick();
  assert.ok(renders.length >= sections.length, 'a range change re-renders every chart of its window group');
});
