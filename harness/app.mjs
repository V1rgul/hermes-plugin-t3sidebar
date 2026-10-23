// Development-only browser harness. Never imports or executes Hermes/T3 application code.
import React, { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import plugin, { captureScope, scopeKey } from '../desktop/plugin.js';
import * as mock from '../tests/sdk.mock.mjs';
plugin.register(mock.ctx);
window.hermesT3SidebarHarness = mock;
function Workspace() {
  const id = mock.useValue(mock.host.state.activeSessionId);
  const [backendMissing, setBackendMissing] = useState(false), [runtimeError, setRuntimeError] = useState(false);
  const refresh = () => void mock.queryClient.invalidateQueries({ queryKey: scopeKey(captureScope()) });
  return h('div', { className: 'harness-app' },
    h('div', { className: 'harness-top' }, h('strong', null, 'hermes-t3sidebar'), h('span', null, 'Development harness · SYNTHETIC fixtures · not a live Hermes connection')),
    h('div', { className: 'harness-body' },
      h('div', { className: 'harness-sidebar' }, mock.control.contributions[0].render()),
      h('main', { className: 'harness-main' },
        h('div', { className: 'harness-tabs' }, id ? mock.control.rows.find(row => row.id === id)?.title || id : 'New session'),
        h('section', { className: 'harness-content' }, h('span', { className: 'harness-eyebrow' }, 'SYNTHETIC WORKSPACE'),
          h('h1', null, 'A quieter place to pick up your work.'),
          h('p', null, 'The left pane renders the actual hermes-t3sidebar plugin with React and React Query. The SDK adapter and session fixtures are test doubles; this is not verification inside Electron.'),
          h('p', null, 'Waiting for approval or an answer stays in Ready. Working runs dim quietly below. Archive and Unarchive change native history visibility without deleting, stopping or sending a prompt.'),
          h('div', { className: 'harness-card' }, h('h2', null, 'Try the sidebar'),
            h('ul', null, h('li', null, 'Hover a row: Archive or Unarchive. Right-click for the action menu.'), h('li', null, 'Right-click: pin, archive-and-advance, snooze presets or a local date/time.'), h('li', null, 'Filter projects without creating a project tree. Toggle grouping separately.'), h('li', null, 'Use ↑/↓ to move between rows. Shift+F10 opens actions.'))),
          h('div', { className: 'harness-controls' },
            h('button', { onClick: () => { mock.control.backendMissing = !backendMissing; setBackendMissing(!backendMissing); refresh(); } }, backendMissing ? 'Restore mock backend' : 'Simulate missing backend'),
            h('button', { onClick: () => { mock.control.runtimeError = !runtimeError; setRuntimeError(!runtimeError); refresh(); } }, runtimeError ? 'Restore runtime status' : 'Simulate runtime failure'),
            h('button', { onClick: () => { mock.switchScope(mock.host.state.connectionId.get() === 'source-a' ? 'source-b' : 'source-a'); } }, 'Switch mock source')),
          h('p', { className: 'harness-footnote' }, 'The picker tests public profile-routed create/open/cwd handoff with synthetic responses. Home creation is explicitly unavailable; no hidden prompt is sent. Actual backend deployment and native conversation rendering remain separate integration checks.')))));
}
createRoot(document.getElementById('root')).render(h(QueryClientProvider, { client: mock.queryClient }, h(Workspace)));
