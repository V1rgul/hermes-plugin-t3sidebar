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
const $$ = selector => [...document.querySelectorAll(selector)];
afterEach(async () => {
  if (root) { await act(async () => root.unmount()); root = null; }
  mock.control.disposers.forEach(dispose => dispose());
  mock.reset();
});

const KEY = 'usage-preferences', QUERY = ['hermes-t3sidebar-preferences', 'usage'];
async function openUsage() {
  plugin.register(mock.ctx);
  root = createRoot(document.querySelector('#app'));
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, mock.control.contributions.find(item => item.id === 'usage').render())));
  await tick(); await tick();
}
const pick = async label => { await act(async () => $$('button').find(node => node.textContent === label).click()); await tick(); };
const selected = () => $$('[role=group][aria-label=Split] [aria-pressed=true], [role=group][aria-label=Mode] [aria-pressed=true]').map(node => node.textContent);
const state = () => ({ stored: mock.ctx.storage.get(KEY, null)?.split, published: mock.queryClient.getQueryData(QUERY)?.split, selected: selected() });

test('a preference change that cannot be stored leaves storage, the shared copy and the controls on the saved value', async () => {
  await openUsage();
  mock.ctx.storage.set(KEY, mock.queryClient.getQueryData(QUERY));
  assert.deepEqual(state(), { stored: 'provider', published: 'provider', selected: ['Provider', 'Stacked'] });
  mock.control.storageWriteError = true;
  await pick('Model');
  mock.control.storageWriteError = false;
  assert.deepEqual(state(), { stored: 'provider', published: 'provider', selected: ['Provider', 'Stacked'] }, 'an unsaved choice is neither published nor shown');
  assert.equal(JSON.stringify(mock.queryClient.getQueryData(QUERY)), JSON.stringify(mock.ctx.storage.get(KEY, null)), 'the shared copy is the stored value');
  // Once storage accepts writes again, the same choice applies everywhere.
  await pick('Model');
  assert.deepEqual(state(), { stored: 'model', published: 'model', selected: ['Model', 'Stacked'] });
});
