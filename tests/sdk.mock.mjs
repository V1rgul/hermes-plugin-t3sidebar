// TEST/HARNESS ONLY. All session data and backend responses are synthetic fixtures.
import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
export { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { QueryClient } from '@tanstack/react-query';
export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
const h = React.createElement;
export function atom(initial) { let value = initial; const listeners = new Set(); return { get: () => value, set(next) { value = next; listeners.forEach(fn => fn()); }, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } }; }
export function useValue(value) { return useSyncExternalStore(value.subscribe, value.get, value.get); }
export let epoch = 1;
export const gatewayActivationEpoch = () => epoch;
export const calls = [];
export const control = {};
// Public PluginStorage is synchronous JSON persistence, independent of mounts.
export const storageData = new Map();
const clone = value => JSON.parse(JSON.stringify(value));
const now = () => Math.floor(Date.now() / 1000);
// Public composer.getDraft is ID-addressed: mounted unsaved text wins over stash.
// Fixtures expose text only; attachment-only drafts do not imply textual content.
const composer = {
  async getDraft(sessionId) {
    calls.push(['getDraft', sessionId]);
    if (control.draftError) throw new Error('fixture draft unavailable');
    if (control.readDraft) return control.readDraft(sessionId);
    if (Object.hasOwn(control.mountedDrafts, sessionId)) return control.mountedDrafts[sessionId];
    return control.drafts[sessionId] ?? null;
  }
};
export const host = {
  composer,
  state: { connectionId: atom('source-a'), profile: atom('default'), gateway: atom('open'), activeSessionId: atom('runtime-design'), focusedStoredSessionId: atom('design'), focusedSessionOwner: atom({ connectionId: 'source-a', profile: 'default' }) },
  profileRoutes: async () => [{ connectionId: host.state.connectionId.get(), profile: host.state.profile.get(), targetProfile: host.state.profile.get(), mode: 'remote' }],
  async listPersistedSessions(route, options) { calls.push(['list', route, options]); if (control.listError) throw new Error('fixture list unavailable'); return { sessions: clone(control.rows), total: control.total || control.rows.length, limit: 500, offset: 0 }; },
  async request(method, params) { calls.push([method, params]); if (method === 'session.active_list') { if (control.runtimeError) throw new Error('fixture runtime disconnected'); return { sessions: clone(control.live) }; } if (method === 'session.list') return { sessions: clone(control.extra || []).slice(0, params.limit) }; throw new Error(`Unexpected RPC ${method}`); },
  async requestProfile(route, method, params) {
    calls.push(['requestProfile', route, method, clone(params)]);

    if (method === 'session.workspace.move') {
      if (control.moveError) throw new Error('fixture move unavailable');
      const rows = [...control.rows, ...(control.extra || [])].filter(row => row.id === params.session_key || row._lineage_root_id === params.session_key || row._lineage_ids?.includes(params.session_key));
      if (!rows.length) throw new Error('session_not_found');
      if (control.live.some(row => rows.some(stored => [stored.id, stored._lineage_root_id, ...(stored._lineage_ids || [])].includes(row.session_key)) && row.status !== 'idle')) throw new Error('session_busy');
      const project = control.projects.find(item => item.path === params.cwd || item.repos?.some(repo => repo.path === params.cwd));
      if (!control.dropMove) for (const row of rows) Object.assign(row, { cwd: params.cwd, git_branch: null, git_repo_root: null,
        project: { id: project.id, name: project.label || project.name, cwd: params.cwd, icon: project.icon || null, color: project.color || null } });
      control.afterMove?.();
      return { cwd: params.cwd, branch: null, git_repo_root: null };
    }
    if (method === 'session.title') {
      const live = control.live.find(item => item.id === params.session_id);
      if (!live) throw new Error('fixture live runtime missing');
      const row = control.rows.find(item => item.id === live.session_key || item._lineage_root_id === live.session_key || item._lineage_ids?.includes(live.session_key));
      if (!row) throw new Error('fixture stored title missing');
      if (control.renameError) throw new Error('fixture rename unavailable');
      if (params.title !== undefined) {
        control.afterRename?.();
        if (!control.dropRename && !control.renamePending) row.title = params.title;
        return { title: params.title, pending: !!control.renamePending };
      }
      return { title: row.title, session_key: control.renameWrongId || live.session_key };
    }
    if (method === 'session.archive') {
      if (control.archiveError) throw new Error('fixture archive RPC unavailable');
      const rows = [...control.rows, ...(control.extra || [])].filter(row => row.id === params.session_id || row._lineage_root_id === params.session_id || row._lineage_ids?.includes(params.session_id));
      if (!rows.length) throw new Error('fixture stored session missing');
      if (!control.dropArchiveWrite) for (const row of rows) row.archived = params.archived;
      control.afterArchive?.();
      return { archived: params.archived, session_key: params.session_id };
    }
    if (method === 'projects.tree') { if (control.projectError) throw new Error('fixture projects unavailable'); return { projects: clone(control.projects) }; }
    if (method === 'projects.list') {
      if (control.projectError) throw new Error('fixture projects unavailable');
      return { projects: clone(control.projectCatalog) };
    }
    if (method === 'projects.get') {
      if (control.projectReadError) throw new Error('fixture project readback unavailable');
      return { project: clone(control.projectReadback || control.projectCatalog.find(project => project.id === params.id) || null) };
    }
    if (method === 'projects.update' || method === 'projects.create') {
      if (control.projectWriteError) throw new Error('fixture project write unavailable');
      let project = control.projectCatalog.find(item => item.id === params.id);
      if (method === 'projects.create') {
        if (control.projectCatalog.some(item => item.folders.some(folder => folder.path === params.primary_path))) throw new Error('folder already belongs to project');
        project = { id: `p_created_${control.projectCatalog.length}`, name: params.name, icon: params.icon ?? null, color: params.color ?? null,
          folders: params.folders.map(path => ({ path })), archived: false };
        control.projectCatalog.push(project);
      }
      if (!project) throw new Error('fixture project missing');
      if (!control.dropProjectWrite) {
        if (method === 'projects.update') for (const key of ['name', 'icon', 'color']) if (params[key] !== undefined && params[key] !== null) project[key] = params[key] || null;
        for (const row of [...control.rows, ...(control.extra || [])]) if (row.project?.id === project.id || row.project?.id === row.project?.cwd && project.folders.some(folder => folder.path === row.project.cwd)) {
          Object.assign(row.project, { id: project.id, name: project.name, icon: project.icon, color: project.color });
        }
      }
      control.afterProjectWrite?.();
      if (!control.dropProjectWrite) for (const item of control.projects) if (item.id === project.id) Object.assign(item, { label: project.name, name: project.name, icon: project.icon, color: project.color });
      if (control.projectLostReply) { control.projectLostReply = false; throw new Error('fixture project reply lost after commit'); }
      return { project: clone(project) };
    }
    if (method === 'session.create') {
      if (control.createError) throw new Error('fixture create unavailable');
      control.created ||= new Map();
      if (!control.created.has(params.idempotency_key)) control.created.set(params.idempotency_key, { stored_session_id: 'fixture-created', session_id: 'runtime-fixture-created' });
      return clone(control.created.get(params.idempotency_key));
    }
    if (method === 'session.cwd.set') { control.composerCwd = params.cwd; return { cwd: params.cwd }; }
    throw new Error(`Unexpected profile RPC ${method}`);
  },
  openSession(id, options) {
    calls.push(['open', id, options]);
    if (control.openError) throw new Error('fixture open unavailable');
    for (const row of control.rows) if (row.id === id || row._lineage_root_id === id || row._lineage_ids?.includes(id)) row.unread = false;
    host.state.focusedStoredSessionId.set(id); host.state.focusedSessionOwner.set(options.route); control.afterOpen?.();
  }, newChat(route) { calls.push(['new', route]); host.state.focusedStoredSessionId.set(null); }, navigate(path) { calls.push(['navigate', path]); }, notify(value) { calls.push(['notify', value]); }
};
export function switchScope(source = 'source-b', profile = 'default') { epoch++; host.state.connectionId.set(source); host.state.profile.set(profile); host.state.gateway.set('open'); }
export const ctx = {
  os: { async writeClipboard(text) { calls.push(['clipboard', text]); return !control.clipboardError; } },
  storage: {
    get(key, fallback) {
      if (control.storageReadError) throw new Error('fixture storage read failed');
      const raw = storageData.get(key);
      if (raw === undefined) return fallback;
      try { return JSON.parse(raw); } catch { return fallback; }
    },
    set(key, value) {
      if (control.storageWriteError) throw new Error('fixture storage write failed');
      storageData.set(key, JSON.stringify(value));
    },
    remove(key) { storageData.delete(key); }
  },
  async rest(path, options) {
    calls.push(['rest', path, options]); if (control.backendMissing) throw new Error('404 backend not enabled');
    if (path === '/environment') return { profile: control.homeProfile || host.state.profile.get(), home: control.home || '/home/fixture' };
    if (path === '/state') {
      for (const item of Object.values(control.metadata.sessions)) if (item.state === 'snoozed' && item.wake_at <= Date.now() / 1000) Object.assign(item, { state: 'active', woke_at: item.wake_at, updated_at: item.wake_at, wake_at: null });
      return clone(control.metadata);
    }
    if (path === '/runtime') {
      if (control.runtimeError) throw new Error('fixture runtime disconnected');
      return { profile: control.runtimeProfile || host.state.profile.get(), sessions: clone(control.live) };
    }
    if (path.startsWith('/sessions?') || path.startsWith('/archives?')) {
      const archives = path.startsWith('/archives?');
      if (control.listError || (archives ? control.archivesMissing : control.sessionsMissing)) throw new Error('fixture listing unavailable');
      const params = new URLSearchParams(path.split('?')[1]);
      const offset = Number(params.get('offset')), limit = Number(params.get('limit') || 500);
      const history = [...control.rows, ...(control.extra || [])].filter(row => !['cron', 'tool', 'oneshot', 'kanban'].includes(row.source) && (archives ? row.archived === true : row.archived !== true));
      const page = history.slice(offset, offset + limit);
      const organized = !archives && offset === 0 ? history.filter(r => control.metadata.sessions[r._lineage_root_id || r.id]) : [];
      const sessions = [...new Map([...page, ...organized].map(r => [r.id, r])).values()];
      return { profile: (archives ? control.archivesProfile : control.sessionsProfile) || host.state.profile.get(), sessions: clone(sessions), offset, limit, has_more: history.length > offset + limit };
    }
    if (path.endsWith('/delete') && options?.method === 'POST') {
      const id = decodeURIComponent(path.slice('/sessions/'.length, -'/delete'.length)), params = options.body;
      if (control.deleteError) throw new Error('fixture delete unavailable');
      const digest = JSON.stringify({ id, ...params });
      control.deleteReceipts ||= new Map();
      let receipt = control.deleteReceipts.get(params.request_id);
      if (receipt && receipt.digest !== digest) throw new Error('admission_conflict');
      if (!receipt) {
        const rows = [...control.rows, ...(control.extra || [])].filter(row => row.id === id || row._lineage_root_id === id || row._lineage_ids?.includes(id));
        const deleted_ids = rows.length ? [...new Set(rows.flatMap(row => [row.id, row._lineage_root_id, ...(row._lineage_ids || [])]).filter(Boolean))] : [id];
        if (rows.length && (params.expected_revision !== (rows[0].runtime_revision ?? 0) || params.expected_generation !== (rows[0].runtime_generation ?? 0))) throw new Error('stale_revision');
        if (control.live.some(row => deleted_ids.includes(row.session_key) && (row.status !== 'idle' || row.running_subagents > 0))) throw new Error('session_busy');
        receipt = { digest, result: { ok: true, profile: host.state.profile.get(), request_id: params.request_id, session_id: id, operation: 'delete',
          verified_absent: true, already_absent: !rows.length, ...(rows.length ? { revision: params.expected_revision + 1, execution_generation: params.expected_generation } : {}), deleted_ids } };
        if (!control.dropDelete) {
          control.rows = control.rows.filter(row => !deleted_ids.includes(row.id));
          control.extra = (control.extra || []).filter(row => !deleted_ids.includes(row.id));
          control.live = control.live.filter(row => !deleted_ids.includes(row.session_key));
          control.deleteReceipts.set(params.request_id, receipt);
        }
      }
      control.afterDelete?.();
      if (control.deleteLostReply) { control.deleteLostReply = false; throw new Error('fixture reply lost after commit'); }
      return clone(control.deleteResult || receipt.result);
    }
    if (path.endsWith('/workspace')) {
      const id = decodeURIComponent(path.slice('/sessions/'.length, -'/workspace'.length));
      const row = [...control.rows, ...(control.extra || [])].find(row => row.id === id || row._lineage_root_id === id || row._lineage_ids?.includes(id));
      if (!row) throw new Error('session_not_found');
      return clone({ profile: host.state.profile.get(), id, cwd: row.cwd, git_branch: row.git_branch ?? null, git_repo_root: row.git_repo_root ?? null, project: row.project, ...control.workspaceOverride });
    }
    if (path.endsWith('/snapshot')) {
      if (control.snapshotError) throw new Error('fixture snapshot unavailable');
      const id = decodeURIComponent(path.slice('/sessions/'.length, -'/snapshot'.length));
      const row = [...control.rows, ...(control.extra || [])].find(row => row.id === id || row._lineage_root_id === id || row._lineage_ids?.includes(id));
      const value = { profile: host.state.profile.get(), session_id: id, exists: !!row, runtime_revision: row ? row.runtime_revision ?? 0 : 0, runtime_generation: row ? row.runtime_generation ?? 0 : null };
      return { ...value, ...control.snapshotOverride };
    }
    if (path.endsWith('/archive')) {
      if (control.archiveReadError) throw new Error('fixture archive readback unavailable');
      const id = decodeURIComponent(path.slice('/sessions/'.length, -'/archive'.length));
      const row = [...control.rows, ...(control.extra || [])].find(row => row.id === id || row._lineage_root_id === id);
      if (!row) throw new Error('404 stored session missing');
      return { profile: control.archiveReadProfile || host.state.profile.get(), id: control.archiveReadId || id, archived: control.archiveReadMissingFlag ? undefined : row.archived === true };
    }
    const id = decodeURIComponent(path.slice('/sessions/'.length));
    if (!options || options.method !== 'POST') throw new Error('Unexpected REST request');
    if (control.metadataWriteError) throw new Error('fixture metadata write failed');
    if (options.body.action === 'ack_done') {
      if (!control.dropWrite && control.metadata.completions?.[id]?.done_token === options.body.done_token) delete control.metadata.completions[id];
      return clone(control.metadata);
    }
    if (options.body.action === 'ack_wake') {
      const item = control.metadata.sessions[id];
      if (!control.dropWrite && item?.woke_at === options.body.woke_at) item.woke_at = null;
      return clone(control.metadata);
    }
    if (!control.dropWrite) {
      const item = control.metadata.sessions[id] || { state: 'active', settled_at: null, wake_at: null, pinned: false, updated_at: now() };
      const { action, wake_at } = options.body;
      if (action === 'settle') Object.assign(item, { state: 'settled', settled_at: now(), wake_at: null, woke_at: null });
      if (action === 'restore') Object.assign(item, { state: 'active', settled_at: null, wake_at: null, woke_at: null });
      if (action === 'snooze') Object.assign(item, { state: 'snoozed', settled_at: null, wake_at, woke_at: null });
      if (action === 'pin') item.pinned = true;
      if (action === 'unpin') item.pinned = false;
      item.updated_at = now(); control.metadata.sessions[id] = item;
    }
    return clone(control.metadata);
  },
  register(c) { control.contributions.push(c); return () => {}; }, registerSettingsPage(c) { control.settings = c; return () => {}; },
  onEvent(type, listener) { control.listener = listener; return () => { control.listener = null; }; }, onDispose(fn) { control.disposers.push(fn); }
};
export function reset() {
  epoch = 1; queryClient.clear(); calls.length = 0; storageData.clear(); host.composer = composer;
  for (const key of Object.keys(control)) delete control[key];
  Object.assign(control, { drafts: {}, mountedDrafts: {}, projects: [{ id: 'p_fixture', label: 'Synthetic Sidebar', path: '/projects/hermes-t3sidebar', icon: 'tools', color: 'var(--ui-accent)', repos: [{ path: '/projects/hermes-t3sidebar' }] }], contributions: [], disposers: [], rows: [
    { id: 'approval', title: 'Approval request', cwd: '/projects/hermes-t3sidebar', last_active: now() - 200 },
    { id: 'design', title: 'Sidebar layout', cwd: '/projects/hermes-t3sidebar', git_branch: 'feature/sidebar', last_active: now() - 180 },
    { id: 'readme', title: 'Release notes', cwd: '/projects/docs', last_active: now() - 1300, unread: true },
    { id: 'tip', _lineage_root_id: 'root', _lineage_ids: ['root', 'old', 'tip'], title: 'Runtime classification', cwd: '/projects/hermes-t3sidebar', last_active: now() - 4 },
    { id: 'pinned', title: 'Hydraulic sizing', cwd: '/projects/hydraulics', last_active: now() - 300 },
    { id: 'snoozed', title: 'Review tomorrow', cwd: '/projects/docs', last_active: now() - 7200 },
    { id: 'archived', archived: true, title: 'SDK inventory', cwd: '/projects/hermes-t3sidebar', last_active: now() - 5000 },
    { id: 'legacy', archived: false, title: 'Legacy completed entry', cwd: '/projects/docs', last_active: now() - 6000 }
  ], live: [{ id: 'runtime-approval', session_key: 'approval', status: 'waiting', last_active: now() - 200 },
    { id: 'runtime-worker', session_key: 'old', status: 'working', last_active: now() - 4 }],
    metadata: { version: 1, sessions: {
      approval: { state: 'settled', pinned: true, settled_at: now(), wake_at: null, updated_at: now() },
      pinned: { state: 'active', pinned: true, settled_at: null, wake_at: null, updated_at: now() },
      snoozed: { state: 'snoozed', pinned: false, settled_at: null, wake_at: now() + 3600, updated_at: now() },
      legacy: { state: 'settled', pinned: false, settled_at: now() - 600, wake_at: null, updated_at: now() }
    } }
  });
  for (const row of control.rows) {
    row.source = 'desktop';
    row.archived ||= false;
    row.project = { id: `synthetic:${row.cwd}`, name: row.cwd.split('/').at(-1), icon: '◇', color: null, cwd: row.cwd, is_home: false };
    row.provider = 'openai-codex'; row.input_tokens = 1200; row.output_tokens = 300; row.total_tokens = 1500;
  }
  control.projectCatalog = [...new Map(control.rows.map(row => [row.project.id, { ...row.project, folders: [{ path: row.project.cwd }], archived: false }])).values()];
  control.projects = control.projectCatalog.map(project => ({ id: project.id, label: project.cwd === '/projects/hermes-t3sidebar' ? 'Synthetic Sidebar' : project.name, path: project.cwd, icon: project.cwd === '/projects/hermes-t3sidebar' ? 'tools' : project.icon, color: project.color }));
  host.state.connectionId.set('source-a'); host.state.profile.set('default'); host.state.gateway.set('open'); host.state.activeSessionId.set('runtime-design'); host.state.focusedStoredSessionId.set('design'); host.state.focusedSessionOwner.set({ connectionId: 'source-a', profile: 'default' });
}
export function loadArchivePaginationFixtures() {
  control.rows = Array.from({ length: 501 }, (_, i) => ({ id: `synthetic-page-active-${i}`, title: `SYNTHETIC active page ${i}`, archived: false, source: 'desktop' }));
  control.extra = Array.from({ length: 601 }, (_, i) => ({ id: `synthetic-page-archive-${i}`, title: `SYNTHETIC archive page ${i}`, archived: true, source: 'desktop', cwd: '/synthetic/archive-pagination', project: { name: 'Archive pagination', icon: '◇' }, git_branch: 'retained', provider: 'anthropic', total_tokens: 1250 }));
  control.live = []; control.metadata = { version: 1, sessions: {} }; control.runtimeError = false; control.backendMissing = false;
  queryClient.clear(); switchScope('synthetic-pagination-source');
}
export function loadDenseFixtures() {
  control.rows = []; control.extra = []; control.live = []; control.metadata = { version: 1, sessions: {} }; control.runtimeError = false; control.backendMissing = false;
  for (const [section, count] of [['active', 100], ['pinned', 20], ['working', 20], ['snoozed', 20], ['archived', 20]]) {
    for (let i = 0; i < count; i++) {
      const id = `synthetic-${section}-${String(i).padStart(3, '0')}`;
      control.rows.push({ id, archived: section === 'archived', title: `SYNTHETIC ${section} ${i} — a deliberately long title for overflow and ellipsis verification`, source: 'desktop', last_active: now() - i,
        cwd: '/synthetic/layout', project: { id: 'synthetic-layout', name: 'Synthetic layout', icon: '◇', is_home: false }, provider: 'anthropic', input_tokens: 1000, output_tokens: 250, total_tokens: 1250 });
      if (section === 'working') control.live.push({ session_key: id, status: 'working', source: 'desktop' });
      if (['pinned', 'snoozed'].includes(section)) control.metadata.sessions[id] = { state: section === 'pinned' ? 'active' : section, pinned: section === 'pinned', wake_at: now() + 3600, settled_at: null, updated_at: now() };
    }
  }
  queryClient.clear(); switchScope('synthetic-layout-source');
}
export function Button({ variant, size, children, ...props }) { return h('button', props, children); }
// Public color-picker contract, with cosmetic styling only for the harness.
export const PROFILE_SWATCHES = Array.from({ length: 12 }, (_, index) => `hsl(${index * 30} 68% 58%)`);
export function ColorSwatches({ swatches, value, onChange, clearLabel }) {
  return h('div', null, h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 } },
    ...swatches.map(color => h('button', { key: color, type: 'button', 'aria-label': color, 'aria-pressed': value === color, onClick: () => onChange(color),
      style: { width: 20, height: 20, borderRadius: '50%', backgroundColor: color, border: value === color ? '2px solid currentColor' : 'none' } }))),
    h('button', { type: 'button', onClick: () => onChange(null) }, clearLabel));
}
// Public ConfirmDialog contract: cancel is inert, confirm awaits work, errors keep it open.
// The harness omits only the native component's cosmetic success-close delay.
export function ConfirmDialog({ open, onClose, onConfirm, title, description, confirmLabel, cancelLabel = 'Cancel', busyLabel, destructive }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { if (open) { setBusy(false); setError(''); } }, [open]);
  const run = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try { await onConfirm(); onClose(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return open ? createPortal(h('div', { role: 'dialog', 'aria-modal': true, 'aria-label': title, className: 'mock-popover', style: { position: 'fixed', left: 310, top: 80 }, onKeyDown: event => {
    if (event.key === 'Escape' && !busy) onClose();
    if ((event.key === 'Enter' || event.key === ' ') && !busy) { event.preventDefault(); void run(); }
  } }, h('h2', null, title), h('p', null, description), error ? h('div', { role: 'alert' }, error) : null,
  h('button', { type: 'button', disabled: busy, onClick: onClose }, cancelLabel),
  h('button', { type: 'button', disabled: busy, 'data-destructive': destructive, onClick: () => void run() }, busy ? busyLabel : confirmLabel)), document.body) : null;
}
// Test adapter for the public Codicon component; production uses Desktop's icon font.
export function Codicon({ name, size, ...props }) {
  const path = { home: 'M3 11l9-8 9 8M5 10v11h14V10M10 21v-7h4v7', tools: 'M14 3a6 6 0 0 0-7 7L2 15l7 7 5-5a6 6 0 0 0 7-7l-4 4-5-5 4-4Z', discard: 'M3 10l5-5M3 10l5 5M3 10h11a6 6 0 0 1 0 12', calendar: 'M4 5h16v16H4ZM4 10h16M8 2v6M16 2v6M8 14h2M14 14h2M8 18h2' }[name] || 'M3 5h6l2 3h10v12H3Z';
  return h('svg', { ...props, 'data-codicon': name, 'aria-hidden': true, width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor' }, h('path', { d: path }));
}
const PopoverContext = createContext(null);
export function ContextMenu({ children }) { return h(React.Fragment, null, children); }
// Public trigger marks ownership even when an asChild control has its own data-slot.
export function ContextMenuTrigger({ children }) { return React.cloneElement(children, { 'data-slot': 'context-menu-trigger', 'data-hermes-context-menu-trigger': '' }); }
export function Popover({ open, onOpenChange, children }) { const anchor = useRef(null); return h(PopoverContext.Provider, { value: { open, onOpenChange, anchor } }, children); }
export function PopoverTrigger({ children, asChild, ...props }) { const value = useContext(PopoverContext); return React.cloneElement(children, { ...props, ref: node => { value.anchor.current = node; }, onClick: event => { children.props.onClick?.(event); if (!event.defaultPrevented) value.onOpenChange(!value.open); }, 'aria-expanded': value.open }); }
export function PopoverContent({ align, side, children, style, onKeyDown, ...props }) {
  const value = useContext(PopoverContext), content = useRef(null);
  // Native Radix repositions content by its measured size, including larger pickers.
  useLayoutEffect(() => {
    if (!value.open || style?.width !== 'max-content') return;
    const reposition = () => {
      const node = content.current;
      if (!node) return;
      const box = node.getBoundingClientRect();
      node.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - box.width - 8))}px`;
      node.style.top = `${Math.max(8, Math.min(box.top, window.innerHeight - box.height - 8))}px`;
    };
    reposition(); window.addEventListener('resize', reposition);
    return () => window.removeEventListener('resize', reposition);
  });
  const rect = value.anchor.current?.getBoundingClientRect();
  return value.open ? createPortal(h('div', { ...props, ref: content, style: { ...style, ...(style?.width === 'max-content' ? { maxHeight: 'calc(100vh - 16px)', overflowY: 'auto' } : {}), position: 'fixed', left: Math.max(8, Math.min((rect?.right || 280) + 6, window.innerWidth - (style?.width === 'max-content' ? Math.min(510, window.innerWidth - 16) : 300) - 8)), top: Math.max(10, Math.min(rect?.top || 120, window.innerHeight - 440)) }, role: 'dialog', className: 'mock-popover', onKeyDown: event => { onKeyDown?.(event); if (event.key === 'Escape' && !event.defaultPrevented) value.onOpenChange(false); } }, children,
    h('button', { type: 'button', 'aria-label': 'Close session actions', onClick: () => value.onOpenChange(false) }, 'Close')), document.body) : null;
}
export const icons = Object.fromEntries(Object.entries({
  SquarePen: 'M12 5v14M5 12h14', Search: 'M21 21l-6-6M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  Settings2: 'M4 7h16M4 17h16M8 4v6M16 14v6', List: 'M4 6h16M4 12h16M4 18h16', FolderTree: 'M4 4v16h16M4 12h10M14 9h6v6h-6',
  ListFilter: 'M4 5h16M7 12h10M10 19h4', ChevronUp: 'M6 15l6-6 6 6', ChevronDown: 'M6 9l6 6 6-6', ChevronRight: 'M9 6l6 6-6 6',
  HelpCircle: 'M12 8v5M12 16v1M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', LoaderCircle: 'M20 12a8 8 0 1 1-8-8',
  Clock: 'M12 7v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  Sun: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8M12 2v2M12 20v2M2 12h2M20 12h2M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  AlarmClock: 'M12 8v5l3 2M3 3l3 3M21 3l-3 3M21 13a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  CircleCheck: 'M6 12l4 4 8-8M22 12a10 10 0 1 1-20 0', Pin: 'M9 3h6l-1 6 4 4H6l4-4-1-6M12 13v8',
  MessageSquare: 'M4 4h16v12H9l-5 4V4', Undo2: 'M3 10l5-5M3 10l5 5M3 10h11a6 6 0 0 1 0 12',
  Check: 'M5 12l5 5L20 7', Ellipsis: 'M5 12h1M11 12h1M17 12h1', X: 'M6 6l12 12M6 18L18 6', RefreshCw: 'M20 4v6h-6M20 10a8 8 0 1 0 0 7',
  Copy: 'M9 9h12v12H9ZM5 15H3V3h12v2', FolderOpen: 'M3 5h6l2 3h10v12H3Z', CornerDownLeft: 'M9 10l-5 5 5 5M4 15h12a4 4 0 0 0 4-4V4',
  Pencil: 'M16 3l5 5-13 13H3v-5ZM14 5l5 5', Trash2: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7'
}).map(([name, path]) => [name, props => h('svg', { 'data-icon': name, width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: path }))]));
reset();
