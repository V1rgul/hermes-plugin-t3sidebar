// Development-only browser harness. Never imports or executes Hermes/T3 application code.
import React, { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import plugin, { captureScope, scopeKey } from '../desktop/plugin.js';
import * as mock from '../tests/sdk.mock.mjs';
// Model the public SDK's namespaced JSON storage across real browser reloads.
mock.ctx.storage = {
  get(key, fallback) { try { const value = localStorage.getItem(`hermes.plugin.hermes-t3sidebar.${key}`); return value === null ? fallback : JSON.parse(value); } catch (_) { return fallback; } },
  set(key, value) { localStorage.setItem(`hermes.plugin.hermes-t3sidebar.${key}`, JSON.stringify(value)); },
  remove(key) { localStorage.removeItem(`hermes.plugin.hermes-t3sidebar.${key}`); }
};
plugin.register(mock.ctx);
// The running fixture's native in-flight turn began just over two minutes ago.
mock.control.live.find(item => item.id === 'runtime-worker').turn_started_at = Date.now() / 1000 - 125;
window.hermesT3SidebarHarness = mock;
// Route contributions open in the workspace like Desktop's route tiles; ?route=/path opens one directly.
const route = mock.atom(new URLSearchParams(location.search).get('route') || '/');
const navigate = mock.host.navigate;
mock.host.navigate = path => { navigate(path); route.set(path); };
function Workspace() {
  const id = mock.useValue(mock.host.state.activeSessionId);
  const path = mock.useValue(route);
  const page = mock.control.contributions.find(item => item.area === mock.ROUTES_AREA && item.data?.path === path);
  const [backendMissing, setBackendMissing] = useState(false), [runtimeError, setRuntimeError] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const refresh = () => void mock.queryClient.invalidateQueries({ queryKey: scopeKey(captureScope()) });
  return h('div', { className: 'harness-app' },
    h('div', { className: 'harness-top' }, h('strong', null, 'hermes-t3sidebar'), h('span', null, 'Development harness · SYNTHETIC fixtures · not a live Hermes connection')),
    h('div', { className: 'harness-body' },
      h('div', { className: 'harness-sidebar' }, mock.control.contributions[0].render()),
      page ? h('main', { className: 'harness-main harness-route', 'data-route': path },
        h('div', { className: 'harness-tabs' }, page.title, h('button', { className: 'harness-back', onClick: () => route.set('/') }, 'Back to workspace')),
        h('div', { className: 'harness-page' }, page.render())) :
      h('main', { className: 'harness-main' },
        h('div', { className: 'harness-tabs' }, id ? mock.control.rows.find(row => row.id === id)?.title || id : 'New session'),
        h('section', { className: 'harness-content' }, h('span', { className: 'harness-eyebrow' }, 'SYNTHETIC WORKSPACE'),
          h('h1', null, 'A quieter place to pick up your work.'),
          h('p', null, 'The left pane renders the actual hermes-t3sidebar plugin with React and React Query. The SDK adapter and session fixtures are test doubles; this is not verification inside Electron.'),
          h('p', null, 'Waiting for approval or an answer stays in Ready. Working runs dim quietly below. Archive and Unarchive change native history visibility without deleting, stopping or sending a prompt.'),
          h('div', { className: 'harness-card' }, h('h2', null, 'Try the sidebar'),
            h('ul', null, h('li', null, 'Hover a row: Snooze, Archive or Unarchive. Archived cards omit Snooze.'), h('li', null, 'Right-click: pin, rename a live thread, copy its ID, or filter its project.'), h('li', null, 'Filter projects in the flat list without changing the native workspace.'), h('li', null, 'Use ↑/↓ to move between rows. Shift+F10 opens actions; Shift+Enter archives and advances.'))),
          h('div', { className: 'harness-controls' },
            h('button', { onClick: () => { mock.control.backendMissing = !backendMissing; setBackendMissing(!backendMissing); refresh(); } }, backendMissing ? 'Restore mock backend' : 'Simulate missing backend'),
            h('button', { onClick: () => { mock.control.runtimeError = !runtimeError; setRuntimeError(!runtimeError); refresh(); } }, runtimeError ? 'Restore runtime status' : 'Simulate runtime failure'),
            h('button', { onClick: () => { mock.switchScope(mock.host.state.connectionId.get() === 'source-a' ? 'source-b' : 'source-a'); } }, 'Switch mock source'),
            h('button', { onClick: () => setSettingsOpen(previous => !previous) }, 'Plugin settings')),
          settingsOpen ? mock.control.settings.render() : null,
          h('p', { className: 'harness-footnote' }, 'The picker tests public profile-routed create/open/cwd handoff with synthetic responses. Home creation is explicitly unavailable; no hidden prompt is sent. Actual backend deployment and native conversation rendering remain separate integration checks.')))));
}
createRoot(document.getElementById('root')).render(h(QueryClientProvider, { client: mock.queryClient }, h(Workspace)));
