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
    if (method === 'commands.catalog') {
      if (control.catalogError) throw new Error('fixture command catalog unavailable');
      return { plugin_commands: control.autotitler ? { autotitler: 'Inspect/configure automatic titles' } : {}, plugin_discovery_error: control.pluginDiscoveryError || '' };
    }
    if (method === 'command.dispatch') {
      if (!control.autotitler || params.name !== 'autotitler') throw new Error(`not a quick/plugin/bundle/skill command: ${params.name}`);
      const [, id] = params.arg.split(' ');
      control.afterAutotitle?.();
      if (control.autotitlerOutput !== undefined) return { type: 'plugin', output: control.autotitlerOutput };
      const row = [...control.rows, ...(control.extra || [])].find(item => item.id === id);
      if (!row) return { type: 'plugin', output: `  ${id.slice(0, 8)} skipped no messages` };
      row.title = 'Regenerated title';
      return { type: 'plugin', output: `  ${id.slice(0, 8)} renamed ${row.title}` };
    }
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
    if (path.startsWith('/usage/')) {
      if (control.usageError) throw new Error(control.usageError);
      const params = new URLSearchParams(path.split('?')[1] || '');
      if (path.startsWith('/usage/history?')) return clone(control.usageHistory ?? syntheticUsageHistory(Number(params.get('days')), params.get('tz')));
      if (path.startsWith('/usage/limits?')) return clone(control.usageLimits ?? syntheticUsageLimits(Math.min(840, Number(params.get('hours')) || 168), control.limitsScenario));
    }
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
    if (path.endsWith('/title') && options?.method === 'POST') {
      const id = decodeURIComponent(path.slice('/sessions/'.length, -'/title'.length));
      if (control.storedRenameError) throw new Error('fixture stored rename unavailable');
      const row = [...control.rows, ...(control.extra || [])].find(item => item.id === id);
      if (!row) throw new Error('session_not_found');
      // Core collapses whitespace; the companion reports the stored value.
      const title = options.body.title.trim().replace(/\s+/g, ' ');
      if (!control.dropStoredRename) row.title = title;
      control.afterStoredRename?.();
      return { ok: true, profile: control.storedRenameProfile || host.state.profile.get(), session_id: control.storedRenameWrongId || id, title };
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
        if (control.live.some(row => deleted_ids.includes(row.session_key) && (row.status !== 'idle' || row.running_subagents > 0 || row.awaiting_processes === true))) throw new Error('session_busy');
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
    { id: 'runtime-worker', session_key: 'old', status: 'working', running_subagents: 0, last_active: now() - 4 }],
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
      if (section === 'working') control.live.push({ session_key: id, status: 'working', source: 'desktop', running_subagents: 0 });
      if (['pinned', 'snoozed'].includes(section)) control.metadata.sessions[id] = { state: section === 'pinned' ? 'active' : section, pinned: section === 'pinned', wake_at: now() + 3600, settled_at: null, updated_at: now() };
    }
  }
  queryClient.clear(); switchScope('synthetic-layout-source');
}
function fixtureMidnight(seconds, tz) {
  let format;
  try { format = new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' }); }
  catch (_) { format = new Intl.DateTimeFormat('en-US', { hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' }); }
  let t = Math.floor(seconds);
  for (let guard = 0; guard < 4; guard++) {
    const parts = Object.fromEntries(format.formatToParts(new Date(t * 1000)).map(part => [part.type, Number(part.value)]));
    const since = parts.hour * 3600 + parts.minute * 60 + parts.second;
    if (!since) break;
    // After the first correction a DST shift can leave t just before midnight; step forward instead of a whole day back.
    t += guard > 0 && parts.hour >= 12 ? 86400 - since : -since;
  }
  return t;
}
// Synthetic usage fixtures shaped like the frozen /usage/history and /usage/limits contract; deterministic apart from the clock.
const FIXTURE_MODELS = [['openai-codex', 'gpt-6.1-sol', 1], ['openai-codex', 'gpt-6.1-mini', 0.35], ['anthropic', 'claude-opus-5', 0.6], ['anthropic', 'claude-haiku-5', 0.2], ['copilot', 'gpt-5.5', 0.12]];
export function syntheticUsageHistory(days = 7, tz = 'UTC') {
  const hourly = days === 1, count = hourly ? 24 : days;
  const end = Math.floor(Date.now() / 1000 / 3600) * 3600;
  // Daily buckets start at local midnights in the requested zone, like the backend's.
  const buckets = Array.from({ length: count }, (_, index) => hourly ? end - (count - 1 - index) * 3600 : fixtureMidnight(end - (count - 1 - index) * 86400, tz));
  const wave = (index, phase) => Math.max(0, Math.sin(index * 0.9 + phase) * 0.5 + 0.6 + ((index * 7 + phase * 13) % 5) / 10);
  const by_model = FIXTURE_MODELS.map(([provider, model, weight], seriesIndex) => {
    const tokens = buckets.map((_, index) => Math.round(wave(index, seriesIndex) * weight * (hourly ? 900_000 : 14_000_000)));
    const input = tokens.map(value => Math.round(value * 0.2)), output = tokens.map(value => Math.round(value * 0.05)), cache_read = tokens.map((value, index) => value - input[index] - output[index]);
    return { key: `${provider}/${model}`, label: model, provider, model, tokens, input, output, cache_read, cache_write: tokens.map(() => 0), reasoning: output.map(value => Math.round(value / 3)),
      cost_usd: provider === 'copilot' ? tokens.map(() => 0) : tokens.map(value => Math.round(value * (provider === 'anthropic' ? 2.4 : 1.1)) / 1e6),
      user_messages: tokens.map(value => Math.round(value / (hourly ? 120_000 : 600_000))) };
  });
  const sum = (list, field) => buckets.map((_, index) => list.reduce((total, item) => total + item[field][index], 0));
  const fields = ['tokens', 'input', 'output', 'cache_read', 'cache_write', 'reasoning', 'cost_usd', 'user_messages'];
  const by_provider = [...new Set(by_model.map(item => item.provider))].map(provider => {
    const members = by_model.filter(item => item.provider === provider);
    return { key: provider, label: provider, provider, model: null, ...Object.fromEntries(fields.map(field => [field, sum(members, field)])) };
  });
  const total = field => by_model.reduce((all, item) => all + item[field].reduce((a, b) => a + b, 0), 0);
  return { generated_at: Date.now() / 1000, days, tz, resolution: hourly ? 'hour' : 'day', buckets, by_provider, by_model,
    totals: { tokens: total('tokens'), cost_usd: total('cost_usd'), user_messages: total('user_messages') }, pricing_missing: ['copilot/gpt-5.5'], approximate: true };
}
// Two Codex accounts on different plans (a 20-unit Business seat drained first, then a 100-unit Pro 100) and one Anthropic Max 20x account (200 units weekly), each pool drained in priority order by an office-hours workload: ten days of 15-minute samples with weekly resets as visible step-ups. Consumption is in plan units, the weekday/hour profile follows the local clock (nights and weekends line up with the charts' midnight gridlines), and Codex's last 12 hours run hotter than the days before, as in a burst of work. Scenarios (control.limitsScenario):
// - 'mixed' (default): Codex's burst would leave Pro 100 with unused quota at tomorrow's reset (a waste arrow) yet still empty the pool days before the Business seat resets (the time-to-empty arrow), so its verdict is short; Anthropic's lighter use leaves quota to expire at its reset (waste).
// - 'light': the same accounts with a gentle Codex workload; resets throw quota away and both verdicts are waste.
// - 'steady': consumption that roughly matches each pool's capacity; both verdicts are ok.
// - 'logged-out': 'mixed' with Anthropic logged out in Hermes (no credential left in its pool).
const LIMIT_WEEK = 604800, LIMIT_FIVE_HOURS = 18000;
const resetAfter = (anchor, period, t) => anchor - (Math.ceil((anchor - t) / period) - 1) * period;
function limitLoad(t) {
  const date = new Date(t * 1000), day = date.getDay(), hour = date.getHours() + date.getMinutes() / 60;
  if (day === 0 || day === 6) return hour >= 10 && hour < 18 ? 0.4 : 0;
  return hour >= 9 && hour < 12 ? 4 : hour >= 12 && hour < 14 ? 1.5 : hour >= 14 && hour < 19 ? 4.5 : hour >= 19 && hour < 23 ? 1 : 0;
}
const LIMIT_SCENARIOS = {
  mixed: { base: 0.28, burst: 1.0, team: 0.3, prolite: 0.6, proliteReset: 1.0, teamReset: 4.2, claude: 0.35, claudeLoad: 0.8, claudeReset: 2.5, anthropic: true },
  light: { base: 0.28, burst: 0.37, team: 0.3, prolite: 0.6, proliteReset: 1.0, teamReset: 4.2, claude: 0.35, claudeLoad: 0.8, claudeReset: 2.5, anthropic: true },
  steady: { base: 0.3, burst: 0.56, team: 0.3, prolite: 0.6, proliteReset: 4.6, teamReset: 2.2, claude: 0.35, claudeLoad: 0.7, claudeReset: 4.5, anthropic: true }
};
LIMIT_SCENARIOS['logged-out'] = { ...LIMIT_SCENARIOS.mixed, anthropic: false };
// One pool's samples: the load is taken from accounts in priority order, each refilled at its weekly and five-hour resets. The seed shifts the deterministic ±40% jitter so two pools do not drain in lockstep.
function simulateLimitPool(accounts, { from, fetched, since, scaleAt, seed = 0 }) {
  const step = 900, history = [];
  const round = value => Math.round(value * 10) / 10;
  const percent = account => round(account.remaining / account.units * 100);
  // A five-hour window holds about a third of the account's weekly capacity.
  const fiveLeft = account => round(Math.max(0, 100 - account.fiveUsed / (account.units * 0.3) * 100));
  for (let t = from, index = 0; t < fetched; index++) {
    const next = Math.min(t + step, fetched);
    let need = limitLoad(t) * scaleAt(t) * (0.6 + ((index + seed) * 37 % 17) / 20) * (next - t) / 3600;
    for (const account of accounts) { const take = Math.min(account.remaining, need); account.remaining -= take; account.fiveUsed += take; need -= take; if (need <= 0) break; }
    for (const account of accounts) {
      if (account.weekReset <= next) { account.remaining = account.units; account.weekReset += LIMIT_WEEK; }
      if (account.fiveReset <= next) { account.fiveUsed = 0; account.fiveReset += LIMIT_FIVE_HOURS; }
    }
    t = next;
    if (t >= since) for (const account of accounts) history.push(
      { t, account: account.id, window: 'five_hour', remaining_percent: fiveLeft(account), resets_at: account.fiveReset },
      { t, account: account.id, window: 'weekly', remaining_percent: percent(account), resets_at: account.weekReset });
  }
  const snapshot = account => ({ id: account.id, label: account.label, priority: account.priority, plan: account.plan, ...(Number.isFinite(account.banked_resets) ? { banked_resets: account.banked_resets } : {}),
    fetched_at: fetched, stale: false, error: null, windows: [
      { key: 'five_hour', label: '5-hour', window_seconds: LIMIT_FIVE_HOURS, scope: 'account', model: null, used_percent: round(100 - fiveLeft(account)), remaining_percent: fiveLeft(account), resets_at: account.fiveReset },
      { key: 'weekly', label: 'Weekly', window_seconds: LIMIT_WEEK, scope: 'account', model: null, used_percent: round(100 - percent(account)), remaining_percent: percent(account), resets_at: account.weekReset }
    ] });
  return { history, accounts: accounts.map(snapshot) };
}
export function syntheticUsageLimits(hours = 168, scenario = 'mixed') {
  const shape = LIMIT_SCENARIOS[scenario] || LIMIT_SCENARIOS.mixed;
  const now = Date.now() / 1000, fetched = now - 140, from = Math.floor(now / 900) * 900 - 10 * 86400, since = now - hours * 3600;
  const prepare = list => list.map(account => ({ ...account, remaining: account.units * account.left, weekReset: resetAfter(account.weekly, LIMIT_WEEK, from), fiveReset: resetAfter(account.five, LIMIT_FIVE_HOURS, from), fiveUsed: 0 }));
  const codex = simulateLimitPool(prepare([
    { id: 'acct-team', label: 'chatgptvitibot', priority: 0, plan: 'team', units: 20, banked_resets: 0, weekly: now + shape.teamReset * 86400, five: now + 1.3 * 3600, left: shape.team },
    { id: 'acct-prolite', label: 'chatgpt1', priority: 1, plan: 'prolite', units: 100, banked_resets: 1, weekly: now + shape.proliteReset * 86400, five: now + 3.1 * 3600, left: shape.prolite }
  ]), { from, fetched, since, scaleAt: t => t >= now - 12 * 3600 ? shape.burst : shape.base });
  // Max 20x as Anthropic's usage endpoint names it (rateLimitTier), which the plugin maps to 200 weekly plan units.
  const claude = simulateLimitPool(prepare([
    { id: 'acct-claude', label: 'claude-max', priority: 0, plan: 'default_claude_max_20x', units: 200, weekly: now + shape.claudeReset * 86400, five: now + 2.2 * 3600, left: shape.claude }
  ]), { from, fetched, since, scaleAt: () => shape.claudeLoad, seed: 5 });
  return { generated_at: now, sampler: { interval_s: 300, started_at: now - 10 * 86400, last_run_at: fetched, last_error: null }, providers: [
    { provider: 'openai-codex', label: 'OpenAI Codex', history: codex.history, accounts: codex.accounts },
    shape.anthropic ? { provider: 'anthropic', label: 'Anthropic', history: claude.history, accounts: claude.accounts }
      // Hermes knows the provider but holds no usable credential for it.
      : { provider: 'anthropic', label: 'Anthropic', auth: 'logged_out', auth_reason: 'No usable Anthropic credential in the Hermes pool', accounts: [], history: [] }
  ] };
}
export function Button({ variant, size, children, ...props }) { return h('button', props, children); }
export const ROUTES_AREA = 'routes';
// Public Tip wraps one trigger. The adapter keeps the label as a native title (scalar assertions read it) and, like Desktop's Radix tip, shows a bubble beside the trigger while it is hovered or keyboard-focused, so browser captures can show a tooltip. A pointer press closes it, as Radix does.
export function Tip({ label, side = 'top', children }) {
  const [anchor, setAnchor] = useState(null);
  if (!label) return children;
  const show = event => setAnchor(event.currentTarget.getBoundingClientRect());
  const hide = () => setAnchor(null);
  const keyboardFocus = event => { try { if (event.currentTarget.matches(':focus-visible')) show(event); } catch (_) { /* Selector unsupported: no bubble. */ } };
  const chain = (name, handler) => event => { children.props[name]?.(event); handler(event); };
  // A node label (the Limits footer's one line per provider) has no plain text to put in a title, so only string labels become one.
  const trigger = React.cloneElement(children, { title: children.props.title ?? (typeof label === 'string' ? label : undefined), onPointerEnter: chain('onPointerEnter', show), onPointerLeave: chain('onPointerLeave', hide),
    onPointerDown: chain('onPointerDown', hide), onFocus: chain('onFocus', keyboardFocus), onBlur: chain('onBlur', hide) });
  const position = side === 'bottom' ? { left: anchor?.left + anchor?.width / 2, top: anchor?.bottom + 5 } : side === 'left' ? { left: anchor?.left - 5, top: anchor?.top + anchor?.height / 2 }
    : side === 'right' ? { left: anchor?.right + 5, top: anchor?.top + anchor?.height / 2 } : { left: anchor?.left + anchor?.width / 2, top: anchor?.top - 5 };
  return h(React.Fragment, null, trigger, anchor ? createPortal(h(TipBubble, { side, position }, label), document.body) : null);
}
// Like Radix's collision handling (Desktop passes collisionPadding 12), the bubble shifts back inside the viewport while its arrow keeps pointing at the trigger.
function TipBubble({ side, position, children }) {
  const node = useRef(null);
  useLayoutEffect(() => {
    const bubble = node.current;
    bubble.style.marginLeft = '0px';
    const box = bubble.getBoundingClientRect(), pad = 12;
    const shift = box.left < pad ? pad - box.left : box.right > innerWidth - pad ? innerWidth - pad - box.right : 0;
    bubble.style.marginLeft = `${shift}px`; bubble.style.setProperty('--mock-tip-arrow', `calc(50% - ${shift}px)`);
  });
  return h('div', { ref: node, role: 'tooltip', className: 'mock-tip', 'data-side': side, style: { position: 'fixed', ...position } }, children);
}
// Public SegmentedControl contract: pressed state on plain buttons, string ids.
export function SegmentedControl({ options, value, onChange, className, disabled = false }) {
  return h('div', { className: `mock-segmented ${className || ''}`.trim() }, options.map(({ id, label }) => h('button', { key: id, type: 'button', 'aria-pressed': value === id, disabled, onClick: () => onChange(id) }, label)));
}
export function Input({ size, prefix, suffix, containerClassName, ...props }) { return h('input', props); }
// Core Settings row: label + description with the control beside it.
export function ListRow({ title, description, action, below }) { return h('div', { 'data-list-row': true }, h('div', null, h('span', null, title), description ? h('div', null, description) : null, below), action ? h('div', null, action) : null); }
// Core Settings on/off row: ListRow with a Switch (role=switch, aria-checked) labelled by the row label.
export function ToggleRow({ label, description, checked, disabled, onChange, below }) {
  return h(ListRow, { title: label, description, below, action: h('button', { type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label, disabled, onClick: () => onChange(!checked) }) });
}
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
// Like Radix's dismissable layers, Escape anywhere closes only the topmost open popover; there is no visible Close control.
const openPopovers = [], escapeDocuments = new WeakSet();
function listenForEscape(doc) {
  if (escapeDocuments.has(doc)) return;
  escapeDocuments.add(doc);
  doc.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || !openPopovers.length) return;
    openPopovers.at(-1).current(false);
  });
}
export function PopoverContent({ align, side, children, style, onKeyDown, ...props }) {
  const value = useContext(PopoverContext), content = useRef(null), close = useRef(value.onOpenChange);
  close.current = value.onOpenChange;
  useLayoutEffect(() => {
    if (!value.open) return undefined;
    listenForEscape(document);
    openPopovers.push(close);
    return () => { const index = openPopovers.indexOf(close); if (index >= 0) openPopovers.splice(index, 1); };
  }, [value.open]);
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
  return value.open ? createPortal(h('div', { ...props, ref: content, style: { ...style, ...(style?.width === 'max-content' ? { maxHeight: 'calc(100vh - 16px)', overflowY: 'auto' } : {}), position: 'fixed', left: Math.max(8, Math.min((rect?.right || 280) + 6, window.innerWidth - (style?.width === 'max-content' ? Math.min(510, window.innerWidth - 16) : 300) - 8)), top: Math.max(10, Math.min(rect?.top || 120, window.innerHeight - 440)) }, role: 'dialog', className: 'mock-popover', onKeyDown }, children), document.body) : null;
}
export const icons = Object.fromEntries(Object.entries({
  SquarePen: 'M12 5v14M5 12h14', Search: 'M21 21l-6-6M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  Settings2: 'M4 7h16M4 17h16M8 4v6M16 14v6', List: 'M4 6h16M4 12h16M4 18h16', FolderTree: 'M4 4v16h16M4 12h10M14 9h6v6h-6',
  ListFilter: 'M4 5h16M7 12h10M10 19h4', ChevronUp: 'M6 15l6-6 6 6', ChevronDown: 'M6 9l6 6 6-6', ChevronRight: 'M9 6l6 6-6 6',
  HelpCircle: 'M12 8v5M12 16v1M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', LoaderCircle: 'M20 12a8 8 0 1 1-8-8',
  Clock: 'M12 7v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  Sun: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8M12 2v2M12 20v2M2 12h2M20 12h2M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  Pin: 'M9 3h6l-1 6 4 4H6l4-4-1-6M12 13v8',
  MessageSquare: 'M4 4h16v12H9l-5 4V4', Undo2: 'M3 10l5-5M3 10l5 5M3 10h11a6 6 0 0 1 0 12',
  Check: 'M5 12l5 5L20 7', Ellipsis: 'M5 12h1M11 12h1M17 12h1', X: 'M6 6l12 12M6 18L18 6', RefreshCw: 'M20 4v6h-6M20 10a8 8 0 1 0 0 7',
  Copy: 'M9 9h12v12H9ZM5 15H3V3h12v2', FolderOpen: 'M3 5h6l2 3h10v12H3Z', CornerDownLeft: 'M9 10l-5 5 5 5M4 15h12a4 4 0 0 0 4-4V4',
  Pencil: 'M16 3l5 5-13 13H3v-5ZM14 5l5 5', BarChart3: 'M3 21h18M6 17V9M11 17V5M16 17v-6M21 17v-3', Trash2: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7', AlertTriangle: 'M12 3 2 20h20ZM12 9v5M12 17v.01'
}).map(([name, path]) => [name, props => h('svg', { 'data-icon': name, width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: path }))]));
reset();
