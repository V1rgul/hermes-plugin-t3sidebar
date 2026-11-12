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
const stored = () => JSON.stringify(mock.ctx.storage.get(KEY, null));
const published = () => JSON.stringify(mock.queryClient.getQueryData(QUERY));

test('a preference change writes and publishes one value, merged into what is stored now', async () => {
  await openUsage();
  // Another page changes the stored period after this one loaded its copy.
  mock.ctx.storage.set(KEY, { ...mock.queryClient.getQueryData(QUERY), days: 30 });
  await pick('Model');
  assert.equal(published(), stored(), 'the copy every page reads is the value that was stored');
  assert.deepEqual([mock.queryClient.getQueryData(QUERY).days, mock.queryClient.getQueryData(QUERY).split], [30, 'model'], 'the other page\'s period survives and the new split applies');
});

test('when storage cannot be read, the change is merged into the copy on screen rather than into defaults', async () => {
  await openUsage();
  await pick('Independent');
  mock.control.storageReadError = true;
  await pick('Model');
  mock.control.storageReadError = false;
  assert.equal(published(), stored());
  assert.deepEqual([mock.queryClient.getQueryData(QUERY).mode, mock.queryClient.getQueryData(QUERY).split], ['independent', 'model'], 'an unreadable store does not reset the earlier choice');
});
