// hermes-t3sidebar — independent T3-inspired session browser; plain disk-plugin ESM.
import * as sdk from '@hermes/plugin-sdk';
import { createElement as h, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

const { host, useValue, useQuery, useMutation, useQueryClient, queryClient, gatewayActivationEpoch } = sdk;
export const SECTIONS = ['pinned', 'active', 'working', 'snoozed', 'archived'];
const LABELS = { active: 'Ready', pinned: 'Pinned', working: 'Working', snoozed: 'Snoozed', archived: 'Archived' };
const EMPTY_STATE = { version: 1, sessions: {} };
const EMPTY_ROWS = [];
const DEFAULT_META = { state: 'active', pinned: false };
const ARCHIVE_FIRST_PAGE_SIZE = 100;
const HISTORY_PAGE_SIZE = 500;
const ARCHIVE_TAIL_STALE_MS = 30000;
const HISTORY_PAGE_GC_MS = 300000;
const tokenFormatter = Intl.NumberFormat('en', { useGrouping: false, maximumFractionDigits: 0 });
const millionTokenFormatter = Intl.NumberFormat('en', { useGrouping: false, minimumFractionDigits: 1, maximumFractionDigits: 1 });
const shortDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'short' });
const shortTime = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
const SNOOZE_TIME_KEY = ['hermes-t3sidebar-preferences', 'snooze-time'];
const validSnoozeTime = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
function readSnoozeTime(ctx) {
  try { const value = ctx.storage.get('snooze-time', '09:00'); return validSnoozeTime(value) ? value : '09:00'; }
  catch (_) { return '09:00'; }
}
function useSnoozeTime(ctx) {
  return useQuery({ queryKey: SNOOZE_TIME_KEY, queryFn: () => readSnoozeTime(ctx), initialData: () => readSnoozeTime(ctx), staleTime: Infinity }).data;
}
const activationEpoch = sdk.atom(gatewayActivationEpoch());
export const durableId = row => row._lineage_root_id || row.id;
export const aliases = row => [...new Set([row.id, row.resolved_id, durableId(row), ...(row._lineage_ids || [])].filter(Boolean))];
export function seconds(value) {
  if (typeof value === 'number') return value > 1e12 ? value / 1000 : value;
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed / 1000 : 0;
}
export function relative(value, now = Date.now() / 1000) {
  const at = seconds(value);
  if (!at) return '—';
  const delta = now - at, n = Math.abs(delta);
  const text = n < 60 ? 'now' : n < 3600 ? `${Math.floor(n / 60)}m` : n < 86400 ? `${Math.floor(n / 3600)}h` : `${Math.floor(n / 86400)}d`;
  return delta < -60 ? `in ${text}` : text;
}
export function scopeKey(scope) { return ['hermes-t3sidebar', scope.connectionId, scope.profile, scope.epoch]; }
// Reconnect epochs fence requests, but must not reset durable UI preferences.
const foldStorageKey = scope => JSON.stringify(['folds', scope.connectionId, scope.profile]);
function readFolds(ctx, scope) {
  try {
    const value = ctx.storage.get(foldStorageKey(scope), {});
    return Object.fromEntries(['working', 'snoozed', 'archived'].filter(key => typeof value?.[key] === 'boolean').map(key => [key, value[key]]));
  } catch (_) { return {}; }
}
export function sameScope(a, b) { return a.connectionId === b.connectionId && a.profile === b.profile && a.epoch === b.epoch; }
export function captureScope() {
  return { connectionId: host.state.connectionId.get(), profile: host.state.profile.get() || 'default', epoch: gatewayActivationEpoch() };
}
export function currentRoute(scope, routes) {
  const route = routes.find(r => r.connectionId === scope.connectionId && r.profile === scope.profile);
  if (!route && scope.connectionId !== null) throw new Error('Active source/profile route is unavailable. Retry after reconnecting.');
  return route || null;
}
export function validState(value) {
  if (value?.version !== 1 || !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions)) throw new Error('Unsupported hermes-t3sidebar backend response.');
  for (const item of Object.values(value.sessions)) {
    if (!item || !['active', 'settled', 'snoozed'].includes(item.state) || typeof item.pinned !== 'boolean' ||
      (item.state === 'snoozed' && !(Number.isFinite(item.wake_at) && item.wake_at > 0)) ||
      (item.woke_at != null && !(Number.isFinite(item.woke_at) && item.woke_at > 0))) throw new Error('Invalid hermes-t3sidebar metadata.');
  }
  if (value.completions !== undefined) {
    if (!value.completions || typeof value.completions !== 'object' || Array.isArray(value.completions)) throw new Error('Invalid completion state.');
    for (const item of Object.values(value.completions)) if (!item || typeof item.done_token !== 'string' || !item.done_token.length || item.done_token.length > 256 || !Number.isFinite(item.done_at) || item.done_at <= 0) throw new Error('Invalid completion marker.');
  }
  if (value.runs !== undefined) {
    if (!value.runs || typeof value.runs !== 'object' || Array.isArray(value.runs)) throw new Error('Invalid turn state.');
    for (const item of Object.values(value.runs)) if (!item || !Number.isFinite(item.started_at) || item.started_at <= 0 || item.ended_at != null && !(Number.isFinite(item.ended_at) && item.ended_at > 0)) throw new Error('Invalid turn start.');
  }
  return value;
}
// Elapsed Working time counts from the native in-flight turn when the conversation itself runs (the backend reports a manual
// compaction's first observation there too). A session kept Working only by subagents or awaited background processes counts
// from its last recorded turn. The hook's open turn covers runtimes without native starts.
export function workingSince(status, matches, run) {
  if (status !== 'working') return null;
  const own = matches.filter(item => item.status === 'working' || item.status === 'starting');
  const native = own.map(item => item.turn_started_at).filter(value => Number.isFinite(value) && value > 0);
  if (native.length) return Math.min(...native);
  if (!run) return null;
  return own.length && run.ended_at != null ? null : run.started_at;
}
export const visibleSource = row => !['cron', 'tool', 'oneshot', 'kanban'].includes(String(row.source || '').toLowerCase());
export function compactTokens(row) {
  const valid = value => Number.isFinite(value) && value >= 0;
  const total = valid(row.total_tokens) ? row.total_tokens : valid(row.input_tokens) && valid(row.output_tokens) ? row.input_tokens + row.output_tokens : null;
  if (total === null) return '—';
  if (total === 0) return '0';
  const thousands = Math.round(total / 1000);
  return thousands < 1000 ? `${tokenFormatter.format(thousands)}K` : `${millionTokenFormatter.format(total / 1000000)}M`;
}
export function isEmptySession(row, runtimes = []) {
  if (aliases(row).length > 1) return false; // Native counts describe only the tip, not ancestor history.
  const knownCount = value => Number.isInteger(value) && value >= 0;
  const runtimeCounts = runtimes.map(item => item.message_count).filter(knownCount);
  const count = knownCount(row.message_count) ? row.message_count : runtimeCounts.includes(0) ? 0 : null;
  const contentful = item => typeof item.title === 'string' && item.title.trim() && !/^untitled session$/i.test(item.title.trim()) || typeof item.preview === 'string' && item.preview.trim();
  // Missing counts are unknown history, not proof of a fresh session. Content wins
  // over a stale zero count; runtime evidence is already source/profile-qualified.
  return count === 0 && !runtimeCounts.some(value => value > 0) && ![row, ...runtimes].some(contentful);
}
export const sessionTitle = row => row.newSession ? 'New session' : row.title || 'Untitled session';
const draftIdentity = row => JSON.stringify([durableId(row), row.resolved_id || row.id]);
const draftKey = (scope, row) => ['hermes-t3sidebar-drafts', scope.connectionId, scope.profile, scope.epoch, durableId(row), row.resolved_id || row.id];
const knownWorkspace = row => typeof row.cwd === 'string' || row.project?.is_home === true;
const searchTokens = query => query.trim().toLowerCase().split(/\s+/).filter(Boolean);
function matchesFilters(row, tokens, project, index) {
  if (project !== '*' && ((row._limited && !knownWorkspace(row)) || (row.cwd || '') !== project)) return false;
  if (!tokens.length) return true;
  let text = index?.get(row);
  if (text === undefined) {
    text = [sessionTitle(row), row.preview, row.cwd, row.git_branch, ...aliases(row)].filter(Boolean).join(' ').toLowerCase();
    index?.set(row, text);
  }
  return tokens.every(token => text.includes(token));
}
export function mergeRows(rich, extra = [], live = [], extraRich = false, archives = []) {
  const rows = new Map(), aliasIndex = new Map(), order = new Map();
  let sequence = 0;
  // Archive feed wins over stale active pages, and remains rich/project-filterable.
  for (const row of [...extra.map(r => ({ ...r, _limited: !extraRich })), ...rich.map(r => ({ ...r, _limited: false })), ...archives.map(r => ({ ...r, _limited: false }))]) {
    const key = durableId(row);
    if (!key || !visibleSource(row)) continue;
    const incoming = aliases(row);
    let previousKey = rows.has(key) ? key : undefined;
    if (previousKey === undefined) {
      // Index aliases once; retain the original first-insertion match when an
      // unusual overlapping lineage refers to more than one existing card.
      for (const alias of incoming) for (const candidate of aliasIndex.get(alias) || []) {
        if (previousKey === undefined || order.get(candidate) < order.get(previousKey)) previousKey = candidate;
      }
    }
    const previous = rows.get(previousKey), previousAliases = previous ? aliases(previous) : [];
    for (const alias of previousAliases) {
      const owners = aliasIndex.get(alias);
      owners.delete(previousKey);
      if (!owners.size) aliasIndex.delete(alias);
    }
    if (previousKey && previousKey !== key) { rows.delete(previousKey); order.delete(previousKey); }
    const lineage = [...new Set([...previousAliases, ...incoming])];
    if (!rows.has(key)) order.set(key, sequence++);
    rows.set(key, { ...previous, ...row, _lineage_ids: lineage });
    for (const alias of lineage) {
      if (!aliasIndex.has(alias)) aliasIndex.set(alias, new Set());
      aliasIndex.get(alias).add(key);
    }
  }
  const known = new Set([...rows.values()].flatMap(aliases)), byStoredId = new Map();
  for (const item of live) {
    if (!visibleSource(item) || !item.session_key) continue;
    // Ambiguous runtimes cannot lend one another workspace/provider metadata.
    byStoredId.set(item.session_key, byStoredId.has(item.session_key) ? null : item);
    if (known.has(item.session_key)) continue;
    const row = { ...item, id: item.session_key, _limited: !knownWorkspace(item), _liveOnly: true };
    rows.set(row.id, row); known.add(row.id);
  }
  return [...rows.values()].map(row => {
    const runtime = byStoredId.get(row.id);
    if (!runtime || !isEmptySession(row, [runtime])) return row;
    // Unknown runtime evidence must not erase stored facts. Workspace is one
    // projection: an explicit Home object proves detachment; null alone does not.
    const fields = {};
    if (knownWorkspace(runtime) && runtime.project) Object.assign(fields, { cwd: runtime.cwd ?? null, project: runtime.project });
    if (typeof runtime.provider === 'string' && runtime.provider.trim() && !/^(auto|unknown|default|none)$/i.test(runtime.provider.trim())) fields.provider = runtime.provider;
    return { ...row, ...fields };
  });
}
export function buildSections(rows, metadata, live, { now = Date.now() / 1000, runtimeKnown = true, query = '', project = '*' } = {}) {
  const result = Object.fromEntries(SECTIONS.map(section => [section, []]));
  const tokens = searchTokens(query);
  const runtimeIndex = new Map();
  for (let index = 0; index < live.length; index++) {
    for (const id of new Set([live[index].session_key, live[index].id])) {
      if (!runtimeIndex.has(id)) runtimeIndex.set(id, []);
      runtimeIndex.get(id).push(index);
    }
  }
  for (const row of rows) {
    if (!visibleSource(row)) continue;
    const meta = metadata.sessions[durableId(row)] || DEFAULT_META;
    const ids = new Set(aliases(row));
    // Preserve snapshot order and repeated entries, but do not rescan every runtime per card.
    const positions = new Set();
    for (const id of ids) for (const index of runtimeIndex.get(id) || EMPTY_ROWS) positions.add(index);
    const matches = [...positions].sort((a, b) => a - b).map(index => live[index]);
    // Waiting wins over every metadata shelf and working signal, across the entire lineage.
    const status = !runtimeKnown ? 'unknown' : matches.some(i => i.status === 'waiting') ? 'waiting'
      : matches.some(i => i.status === 'working' || i.status === 'starting' || Number.isInteger(i.running_subagents) && i.running_subagents > 0 || i.awaiting_processes === true) ? 'working'
      : matches.some(i => !['idle', 'working', 'starting', 'waiting'].includes(i.status)) ? 'unknown' : 'idle';
    const woke = Number.isFinite(meta.woke_at) && meta.woke_at > 0 || meta.state === 'snoozed' && meta.wake_at <= now;
    const section = status === 'waiting' ? 'active'
      : row.archived === true ? status === 'working' ? 'working' : 'archived'
      : status === 'unknown' ? 'active'
      : meta.state === 'snoozed' && !woke ? 'snoozed'
      : meta.pinned ? 'pinned'
      : status === 'working' ? 'working' : 'active';
    const newSession = isEmptySession(row, runtimeKnown ? matches : []);
    if (!matchesFilters({ ...row, newSession }, tokens, project)) continue;
    // Runtime last_active is also a resume/reattach clock, not conversation progress.
    const activity = seconds(row.last_active || row.updated_at || row.started_at || row.created_at);
    const runtimes = matches.filter(item => typeof item.id === 'string' && item.id && item.id !== item.session_key);
    result[section].push({ ...row, key: durableId(row), meta, completion: metadata.completions?.[durableId(row)] || null, runStartedAt: workingSince(status, matches, metadata.runs?.[durableId(row)]), section, status, woke, newSession,
      runtimeId: runtimes.length === 1 ? runtimes[0].id : null, activity });
  }
  for (const section of SECTIONS) result[section].sort((a, b) => {
    if (section === 'active' && (a.status === 'waiting') !== (b.status === 'waiting')) return a.status === 'waiting' ? -1 : 1;
    // Working follows elapsed time, longest first, because activity moves on every message; unknown starts follow, by activity.
    if (section === 'working' && (a.runStartedAt == null) !== (b.runStartedAt == null)) return a.runStartedAt == null ? 1 : -1;
    // Native history has no archive timestamp; archives are ordered by last activity.
    const delta = section === 'snoozed' ? a.meta.wake_at - b.meta.wake_at : section === 'working' && a.runStartedAt != null ? a.runStartedAt - b.runStartedAt : b.activity - a.activity;
    return delta || a.key.localeCompare(b.key);
  });
  return result;
}
export function snoozeRemaining(wakeAt, now = Date.now() / 1000) {
  const remaining = Math.max(0, wakeAt - now), minutes = Math.max(remaining > 0 ? 1 : 0, Math.round(remaining / 60));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(remaining / 3600);
  return hours < 24 ? `${hours}h` : `${Math.round(remaining / 86400)}d`;
}
export function snoozePreciseRemaining(wakeAt, now = Date.now() / 1000) {
  const minutes = Math.max(0, Math.ceil((wakeAt - now) / 60));
  return `${Math.floor(minutes / 1440)}d ${Math.floor(minutes / 60) % 24}h ${minutes % 60}min left`;
}
export function snoozePresets(now = Date.now(), presetTime = '09:00') {
  const [hour, minute] = (validSnoozeTime(presetTime) ? presetTime : '09:00').split(':').map(Number);
  const labelTime = `${hour}:${String(minute).padStart(2, '0')}`;
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(hour, minute, 0, 0);
  // Calendar arithmetic preserves the configured local time across daylight-saving changes.
  const monday = new Date(now); monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7)); monday.setHours(hour, minute, 0, 0);
  return [{ label: 'In 1 hour', icon: 'Clock', wake_at: Math.floor(now / 1000) + 3600 },
    { label: 'In 3 hours', icon: 'Clock', wake_at: Math.floor(now / 1000) + 10800 },
    { label: `Tomorrow at ${labelTime}`, icon: 'Sun', wake_at: Math.floor(tomorrow.getTime() / 1000) },
    { label: `Next Monday at ${labelTime}`, codicon: 'calendar', wake_at: Math.floor(monday.getTime() / 1000) }];
}
export function parseLocalWake(value, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Choose a local date and time.');
  const date = new Date(value), wake = date.getTime();
  const [year, month, day, hour, minute] = value.split(/[-T:]/).map(Number);
  if (!Number.isFinite(wake) || date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute) throw new Error('That local time does not exist.');
  if (wake <= now) throw new Error('Choose a future time.');
  return Math.floor(wake / 1000);
}
export function verifyAction(state, id, payload) {
  const item = state.sessions[id];
  const expected = payload.action === 'ack_done' ? !!state.completions && state.completions[id]?.done_token !== payload.done_token
    : payload.action === 'ack_wake' ? item?.woke_at !== payload.woke_at : payload.action === 'settle' ? item?.state === 'settled'
    : payload.action === 'restore' ? item?.state === 'active'
    : payload.action === 'snooze' ? item?.state === 'snoozed' && item?.wake_at === payload.wake_at
    : payload.action === 'pin' ? item?.pinned === true : item?.pinned === false;
  if (!expected) throw new Error('The server did not confirm this change. Refresh and retry.');
  return state;
}
// A single metadata writer per plugin instance. Every await is fenced by activation epoch.
// Read generations + React Query cancellation prevent an old poll overwriting a write.
export function createController(ctx, client = queryClient, env = { capture: captureScope, routes: () => host.profileRoutes(), host }) {
  let disposed = false, writing = false, generation = 0;
  let pendingRoutes = null, archiveHead = null;
  const wakeAcks = new Map(), doneAcks = new Map(), deleteRequests = new Map();
  function check(scope) { if (disposed || !sameScope(scope, env.capture())) throw new Error('Source/profile changed; refresh before trying again.'); }
  async function fenced(scope, fn) { check(scope); const result = await fn(); check(scope); return result; }
  async function routeFor(scope) {
    check(scope);
    // profileRoutes refreshes native profile inventory. Share concurrent work,
    // but never retain settled route authority for a later read or user action.
    if (!pendingRoutes || !sameScope(pendingRoutes.scope, scope)) pendingRoutes = { scope: { ...scope }, work: fenced(scope, () => env.routes()) };
    const pending = pendingRoutes;
    try { return currentRoute(scope, await fenced(scope, () => pending.work)); }
    finally { if (pendingRoutes === pending) pendingRoutes = null; }
  }
  async function projectsFor(scope, route) {
    const value = await fenced(scope, () => env.host.requestProfile(route, 'projects.tree', { preview_limit: 0 }));
    if (!Array.isArray(value?.projects)) throw new Error('Invalid native project tree.');
    const home = { id: '__no_project__', name: 'Home', path: null, isNoProject: true };
    const projects = value.projects.filter(p => p.id !== home.id && !p.isNoProject).flatMap(p => {
      const paths = [...new Set([p.path, ...(p.repos || []).map(repo => repo.path)].filter(path => typeof path === 'string' && path))];
      return paths.map(path => ({ id: `${p.id}:${path}`, projectId: p.id, name: p.label || p.name || p.id, path, icon: p.icon || null, color: p.color || null, isNoProject: false }));
    });
    return { projects: [home, ...projects] };
  }
  function qualified(value, scope, route) {
    if (value?.profile !== (route?.targetProfile || scope.profile) || !Array.isArray(value?.sessions)) throw new Error('Invalid current-profile listing response.');
    return value;
  }
  function readTicket(scope, ticket) {
    check(scope);
    if (writing || ticket !== generation) throw new Error('Superseded session listing.');
  }
  async function archiveFlag(scope, route, id) {
    const value = await fenced(scope, () => ctx.rest(`/sessions/${encodeURIComponent(id)}/archive`));
    if (value?.profile !== (route?.targetProfile || scope.profile) || value?.id !== id || typeof value?.archived !== 'boolean') throw new Error('The server did not confirm the exact native archive state. Refresh and retry.');
    return value.archived;
  }
  async function deleteSnapshot(scope, route, id) {
    const value = await fenced(scope, () => ctx.rest(`/sessions/${encodeURIComponent(id)}/snapshot`));
    if (value?.profile !== (route?.targetProfile || scope.profile) || value?.session_id !== id || typeof value.exists !== 'boolean' ||
      !Number.isInteger(value.runtime_revision) || value.runtime_revision < 0 ||
      (value.exists ? !Number.isInteger(value.runtime_generation) || value.runtime_generation < 0 : value.runtime_revision !== 0 || value.runtime_generation !== null)) {
      throw new Error('The server did not confirm the exact session deletion snapshot.');
    }
    return value;
  }
  function refresh(scope, filters) {
    if (disposed || !sameScope(scope, env.capture())) return;
    // Exact readback confirms an action; full-list refresh is background work.
    // Query errors must not replace the write result or escape unhandled.
    try { void Promise.resolve(client.invalidateQueries(filters)).catch(() => {}); } catch (_) { /* background refresh */ }
  }
  const archiveOrder = value => JSON.stringify([value.has_more, value.sessions.map(row => [durableId(row), row.id])]);
  async function invalidateArchiveTail(scope, offset, ticket) {
    await client.invalidateQueries({ queryKey: [...scopeKey(scope), 'archive-page'], predicate: query => query.queryKey[5] > offset, refetchType: 'none' });
    readTicket(scope, ticket);
  }
  function updateRows(scope, ids, patch, archived) {
    check(scope);
    if (typeof client.getQueriesData !== 'function') return; // Minimal cache adapters may have no loaded lists.
    const matches = row => aliases(row).some(id => ids.has(id)) || ids.has(row.session_key);
    const queries = client.getQueriesData({ queryKey: scopeKey(scope) })
      .filter(([key, data]) => ['sessions', 'expanded', 'archives', 'page', 'archive-page', 'runtime'].includes(key[4]) && Array.isArray(data?.sessions));
    // Transfer only an already-loaded native row, never manufacture a rich row
    // from a runtime or metadata record. Preserve project/history richness.
    let known;
    for (const [key, data] of queries) {
      if (key[4] !== 'runtime') known = data.sessions.find(matches);
      if (known) break;
    }
    for (const [key, data] of queries) {
      const destination = archived === undefined || key[4] === 'runtime' ? null : archived ? 'archives' : 'sessions';
      let sessions = data.sessions.flatMap(row => {
        if (!matches(row)) return [row];
        if (patch === null || destination && key[4] !== destination) return [];
        return [{ ...row, ...patch }];
      });
      if (destination === key[4] && known && !sessions.some(matches)) sessions = [...sessions, { ...known, ...patch }];
      if (sessions.length !== data.sessions.length || sessions.some((row, i) => row !== data.sessions[i])) client.setQueryData(key, { ...data, sessions });
    }
  }
  return {
    dispose() { disposed = true; generation++; pendingRoutes = null; archiveHead = null; deleteRequests.clear(); doneAcks.clear(); }, check,
    async hasDraft(scope, row) {
      check(scope);
      // The public getter is ID-addressed, not route-qualified. Use the same tip as open().
      const composer = env.host.composer, id = row.resolved_id || row.id;
      if (typeof composer?.getDraft !== 'function' || !id) return false;
      const ownerMatches = () => {
        if (!aliases(row).includes(env.host.state?.focusedStoredSessionId?.get())) return true;
        const owner = env.host.state?.focusedSessionOwner?.get();
        return owner?.connectionId === (scope.connectionId ?? 'local') && owner?.profile === scope.profile;
      };
      if (!ownerMatches()) return false;
      try {
        // Reduce at the SDK boundary: no composer text enters QueryCache or plugin storage.
        const present = await fenced(scope, async () => {
          const text = await composer.getDraft(id);
          return typeof text === 'string' && text.trim().length > 0;
        });
        return ownerMatches() && present;
      } catch (_) { check(scope); return false; }
    },
    async list(scope) {
      const ticket = generation;
      readTicket(scope, ticket);
      const route = await routeFor(scope);
      try {
        const value = qualified(await fenced(scope, () => ctx.rest('/sessions?offset=0&limit=500')), scope, route);
        readTicket(scope, ticket); return value;
      } catch (error) {
        readTicket(scope, ticket);
        const value = await fenced(scope, () => env.host.listPersistedSessions(route, { profile: route?.targetProfile || scope.profile, limit: 500 }));
        readTicket(scope, ticket);
        return { ...value, capped: true, companionError: error.message };
      }
    },
    async archives(scope, pages = 0) {
      const ticket = generation;
      readTicket(scope, ticket);
      const route = await routeFor(scope), sessions = [];
      let has_more = true;
      for (let page = 0; page <= pages && has_more; page++) {
        const offset = page ? ARCHIVE_FIRST_PAGE_SIZE + (page - 1) * HISTORY_PAGE_SIZE : 0;
        const limit = page ? HISTORY_PAGE_SIZE : ARCHIVE_FIRST_PAGE_SIZE;
        const pageKey = [...scopeKey(scope), 'archive-page', offset];
        const previous = page ? client.getQueryData?.(pageKey) : null;
        const read = async () => {
          const value = qualified(await fenced(scope, () => ctx.rest(`/archives?offset=${offset}&limit=${limit}`)), scope, route);
          readTicket(scope, ticket);
          if (typeof value.has_more !== 'boolean' || value.sessions.some(row => row.archived !== true)) throw new Error('Invalid native archive listing response.');
          return value;
        };
        // Poll the small head normally. Older pages reconcile on history events, shifted boundaries or a bounded recovery interval, not every head poll.
        const value = page ? await fenced(scope, () => client.fetchQuery({ queryKey: pageKey,
          staleTime: ARCHIVE_TAIL_STALE_MS, gcTime: HISTORY_PAGE_GC_MS, queryFn: read })) : await read();
        readTicket(scope, ticket);
        if (!page || previous !== value) {
          const signature = archiveOrder(value);
          const priorSignature = page ? previous && archiveOrder(previous) : archiveHead && sameScope(archiveHead.scope, scope) && archiveHead.signature;
          // Offset pagination shifts every later boundary after an insertion/removal.
          if (priorSignature !== signature) await invalidateArchiveTail(scope, offset, ticket);
          if (!page) archiveHead = { scope, signature };
        }
        sessions.push(...value.sessions); has_more = value.has_more;
      }
      return { sessions, has_more };
    },
    async runtime(scope) {
      const route = await routeFor(scope);
      return qualified(await fenced(scope, () => ctx.rest('/runtime')), scope, route);
    },
    async expanded(scope, pages) {
      const ticket = generation;
      readTicket(scope, ticket);
      const route = await routeFor(scope), sessions = [];
      let has_more = true;
      for (let page = 1; page <= pages && has_more; page++) {
        const offset = page * 500;
        const value = await fenced(scope, () => client.fetchQuery({ queryKey: [...scopeKey(scope), 'page', offset], staleTime: Infinity, gcTime: HISTORY_PAGE_GC_MS,
          queryFn: async () => { const value = qualified(await fenced(scope, () => ctx.rest(`/sessions?offset=${offset}&limit=500`)), scope, route); readTicket(scope, ticket); return value; } }));
        readTicket(scope, ticket);
        sessions.push(...value.sessions); has_more = value.has_more;
      }
      return { sessions, has_more };
    },
    async metadata(scope) {
      if (writing) throw new Error('hermes-t3sidebar is saving a change.');
      const ticket = generation;
      const value = await fenced(scope, () => ctx.rest('/state'));
      if (ticket !== generation) throw new Error('Superseded metadata read.');
      return validState(value);
    },
    async mutate(scope, id, payload) {
      check(scope);
      if (writing) throw new Error('Another hermes-t3sidebar change is still saving.');
      writing = true; generation++;
      const key = [...scopeKey(scope), 'metadata'];
      const native = payload.action === 'archive' || payload.action === 'unarchive';
      let confirmed = false;
      try {
        await client.cancelQueries({ queryKey: native ? scopeKey(scope) : key, exact: !native }); check(scope);
        if (native) {
          const route = await routeFor(scope), archived = payload.action === 'archive';
          const before = await archiveFlag(scope, route, id); // Unsupported/missing durable rows cannot be written.
          await fenced(scope, () => env.host.requestProfile(route, 'session.archive', { session_id: id, archived }));
          if (await archiveFlag(scope, route, id) !== archived) throw new Error('The server did not confirm this native archive change. Refresh and retry.');
          updateRows(scope, new Set([id]), { archived }, archived);
          let state;
          try {
            state = validState(await fenced(scope, () => ctx.rest('/state')));
            const meta = state.sessions[id];
            const restore = payload.restoreMetadata;
            const metadataPayload = restore ? (restore.state === 'snoozed' && restore.wake_at > Date.now() / 1000 ? { action: 'snooze', wake_at: restore.wake_at } : { action: restore.state === 'settled' ? 'settle' : 'restore' })
              // Record an explicit Ready restoration even for external archives with no plugin metadata,
              // so the companion's organized-row backfill retains an older unarchived conversation.
              : !archived && (!meta || meta.state !== 'active') ? { action: 'restore' } : null;
            if (metadataPayload) {
              await fenced(scope, () => ctx.rest(`/sessions/${encodeURIComponent(id)}`, { method: 'POST', body: metadataPayload }));
              state = verifyAction(validState(await fenced(scope, () => ctx.rest('/state'))), id, metadataPayload);
            }
          } catch (error) { check(scope); throw new Error(`Native ${archived ? 'archive' : 'unarchive'} confirmed, but organization restore failed: ${error.message}`); }
          check(scope); client.setQueryData(key, state);
          return { archived, before };
        }
        if (['pin', 'snooze'].includes(payload.action)) {
          const route = await routeFor(scope);
          if (await archiveFlag(scope, route, id)) throw new Error('Unarchive this session before pinning or snoozing it.');
        }
        await fenced(scope, () => ctx.rest(`/sessions/${encodeURIComponent(id)}`, { method: 'POST', body: payload }));
        const value = verifyAction(validState(await fenced(scope, () => ctx.rest('/state'))), id, payload);
        await client.cancelQueries({ queryKey: key, exact: true }); check(scope);
        client.setQueryData(key, value);
        confirmed = true;
        return value;
      } finally {
        writing = false;
        if (!disposed && sameScope(scope, env.capture())) {
          if (native) client.removeQueries({ predicate: query => sameScope({ connectionId: query.queryKey[1], profile: query.queryKey[2], epoch: query.queryKey[3] }, scope) && query.queryKey[0] === 'hermes-t3sidebar' && query.queryKey[4] === 'page' });
          if (native || !confirmed) refresh(scope, { queryKey: native ? scopeKey(scope) : key, exact: !native });
        }
      }
    },
    async rename(scope, row, input) {
      check(scope);
      const title = input.trim();
      if (!title) throw new Error('Enter a non-empty session title.');
      if (writing) throw new Error('Another hermes-t3sidebar change is still saving.');
      writing = true; generation++;
      try {
        const route = await routeFor(scope);
        const live = qualified(await fenced(scope, () => ctx.rest('/runtime')), scope, route);
        const ids = new Set(aliases(row));
        const matches = live.sessions.filter(item => ids.has(item.session_key) && typeof item.id === 'string' && item.id !== item.session_key);
        if (matches.length !== 1 || matches[0].id !== row.runtimeId) throw new Error('Rename requires the same live runtime. Open the thread and retry.');
        await client.cancelQueries({ queryKey: scopeKey(scope) }); check(scope);
        const result = await fenced(scope, () => env.host.requestProfile(route, 'session.title', { session_id: row.runtimeId, title }));
        if (result?.pending) throw new Error('Rename is pending; it has not been confirmed saved. Refresh before retrying.');
        const saved = await fenced(scope, () => env.host.requestProfile(route, 'session.title', { session_id: row.runtimeId }));
        if (result?.title !== title || saved?.title !== title || !ids.has(saved?.session_key)) throw new Error('The server did not confirm this session title. Refresh and retry.');
        updateRows(scope, ids, { title });
        return title;
      } finally {
        writing = false;
        if (!disposed && sameScope(scope, env.capture())) {
          client.removeQueries({ queryKey: [...scopeKey(scope), 'page'] });
          refresh(scope, { queryKey: scopeKey(scope) });
        }
      }
    },
    async delete(scope, row) {
      check(scope);
      if (writing) throw new Error('Another hermes-t3sidebar change is still saving.');
      if (row.status !== 'idle') throw new Error('Delete requires confirmed idle status; no agent will be stopped automatically.');
      if (row._liveOnly) throw new Error('This unsaved session has no stored history to delete. Use the native session controls to close it.');
      const id = durableId(row), requestKey = JSON.stringify([...scopeKey(scope), id]);
      writing = true; generation++;
      try {
        const route = await routeFor(scope);
        await client.cancelQueries({ queryKey: scopeKey(scope) }); check(scope);
        let payload = deleteRequests.get(requestKey);
        if (!payload) {
          const before = await deleteSnapshot(scope, route, id);
          if (before.exists) {
            payload = { request_id: globalThis.crypto.randomUUID(), expected_revision: before.runtime_revision,
              expected_generation: before.runtime_generation };
            deleteRequests.set(requestKey, payload);
          }
        }
        let deletedIds = [id];
        if (payload) {
          // Retain the exact request/fences after an ambiguous failure; never repeat
          // an irreversible mutation under a fresh identity merely because it timed out.
          const result = await fenced(scope, () => ctx.rest(`/sessions/${encodeURIComponent(id)}/delete`, { method: 'POST', body: payload }));
          if (result?.ok !== true || result.profile !== (route?.targetProfile || scope.profile) || result.session_id !== id || result.request_id !== payload.request_id || result.operation !== 'delete' || result.verified_absent !== true ||
            typeof result.already_absent !== 'boolean' || (!result.already_absent && (result.revision !== payload.expected_revision + 1 || result.execution_generation !== payload.expected_generation)) ||
            !Array.isArray(result.deleted_ids) || !result.deleted_ids.includes(id) ||
            !result.deleted_ids.every(item => typeof item === 'string' && item.length > 0) || new Set(result.deleted_ids).size !== result.deleted_ids.length) {
            throw new Error('The server did not confirm this exact session deletion.');
          }
          for (const deletedId of result.deleted_ids) {
            if ((await deleteSnapshot(scope, route, deletedId)).exists) throw new Error('Deletion was acknowledged, but stored history still exists. Retry to verify.');
          }
          deletedIds = result.deleted_ids;
        }
        check(scope);
        updateRows(scope, new Set(deletedIds), null);
        const owner = env.host.state?.focusedSessionOwner?.get();
        if (owner?.connectionId === (scope.connectionId ?? 'local') && owner?.profile === scope.profile && aliases(row).includes(env.host.state?.focusedStoredSessionId?.get())) {
          await fenced(scope, () => env.host.newChat(route));
        }
        deleteRequests.delete(requestKey);
      } finally {
        writing = false;
        if (!disposed && sameScope(scope, env.capture())) {
          client.removeQueries({ queryKey: [...scopeKey(scope), 'page'] });
          refresh(scope, { queryKey: scopeKey(scope) });
        }
      }
    },
    async moveProject(scope, row, project) {
      check(scope);
      if (row.status !== 'idle' || row._liveOnly) throw new Error('Moving requires a stored session with confirmed idle status.');
      if (!project?.path || project.isNoProject) throw new Error('Choose a project folder.');
      if (writing) throw new Error('Another hermes-t3sidebar change is still saving.');
      writing = true; generation++;
      try {
        // Native workspace.move updates one stored segment, not the whole lineage.
        // Move the same surfaced tip that open() resumes, never an ended root.
        const route = await routeFor(scope), id = row.resolved_id || row.id;
        const choices = await projectsFor(scope, route);
        const target = choices.projects.find(item => item.id === project.id && item.path === project.path && !item.isNoProject);
        if (!target) throw new Error('This project changed or was removed. Refresh and retry.');
        const live = qualified(await fenced(scope, () => ctx.rest('/runtime')), scope, route);
        const ids = new Set(aliases(row));
        if (live.sessions.some(item => (ids.has(item.session_key) || ids.has(item.id)) && (item.status !== 'idle' || item.running_subagents > 0 || item.awaiting_processes === true))) {
          throw new Error('Moving requires confirmed idle status; this session is now busy.');
        }
        await client.cancelQueries({ queryKey: scopeKey(scope) }); check(scope);
        const result = await fenced(scope, () => env.host.requestProfile(route, 'session.workspace.move', { session_key: id, cwd: target.path }));
        const saved = await fenced(scope, () => ctx.rest(`/sessions/${encodeURIComponent(id)}/workspace`));
        if (result?.cwd !== target.path || saved?.profile !== (route?.targetProfile || scope.profile) || saved?.id !== id || saved.cwd !== target.path || !saved.project) {
          throw new Error('The server did not confirm this exact session workspace move. Refresh and retry.');
        }
        updateRows(scope, new Set(aliases(row)), { cwd: saved.cwd, git_branch: saved.git_branch, git_repo_root: saved.git_repo_root, project: saved.project });
      } finally {
        writing = false;
        if (!disposed && sameScope(scope, env.capture())) {
          client.removeQueries({ queryKey: [...scopeKey(scope), 'page'] });
          refresh(scope, { queryKey: scopeKey(scope) });
        }
      }
    },
    async copyId(scope, row) {
      check(scope);
      const ok = await fenced(scope, () => ctx.os.writeClipboard(durableId(row)));
      if (!ok) throw new Error('Clipboard access is unavailable. The session ID was not copied.');
    },
    async copyProjectPath(scope, project) {
      check(scope);
      if (!project?.cwd || project.is_home) throw new Error('Project path is unavailable.');
      const ok = await fenced(scope, () => ctx.os.writeClipboard(project.cwd));
      if (!ok) throw new Error('Clipboard access is unavailable. The project path was not copied.');
    },
    async updateProject(scope, project, patch) {
      check(scope);
      if (!project?.id || !project.cwd || project.is_home) throw new Error('A named project is required.');
      const fields = Object.keys(patch);
      if (!fields.length || fields.some(key => !['name', 'color', 'icon'].includes(key) || patch[key] !== null && typeof patch[key] !== 'string')) throw new Error('Invalid project change.');
      const expected = { ...patch };
      for (const field of ['color', 'icon']) if (field in expected) expected[field] ||= null;
      if ('name' in patch) {
        if (typeof patch.name !== 'string' || !patch.name.trim()) throw new Error('Enter a non-empty project name.');
        expected.name = patch.name.trim();
      }
      if (writing) throw new Error('Another hermes-t3sidebar change is still saving.');
      const interrupted = client.getQueryCache().findAll({ queryKey: scopeKey(scope), type: 'active', fetchStatus: 'fetching' }).map(query => query.queryKey);
      writing = true; generation++;
      let dispatched = false, confirmed = false, adopted = false;
      try {
        const route = await routeFor(scope);
        const rpc = (method, params) => fenced(scope, () => env.host.requestProfile(route, method, params));
        await client.cancelQueries({ queryKey: scopeKey(scope) }); check(scope);
        const catalog = await rpc('projects.list', {});
        if (!Array.isArray(catalog?.projects)) throw new Error('Invalid native project catalog.');
        let target = catalog.projects.find(item => item.id === project.id);
        // Re-resolve path-ID adoption on every edit so a retry cannot create a second project record.
        const automatic = project.id === project.cwd;
        if (!target && automatic) target = catalog.projects.find(item => item.folders?.some(folder => folder.path === project.cwd));
        if (target?.archived || target && !target.folders?.some(folder => folder.path === project.cwd) || !target && !automatic) throw new Error('This project changed or was removed. Refresh and retry.');
        const payload = Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, value === null ? '' : value]));
        let id;
        if (target) {
          id = target.id;
          adopted = id !== project.id;
          dispatched = true;
          await rpc('projects.update', { id, ...payload });
        } else {
          adopted = true;
          dispatched = true;
          const created = await rpc('projects.create', { name: project.name, folders: [project.cwd], primary_path: project.cwd,
            icon: project.icon || null, color: project.color || null, use: false, ...expected });
          id = created?.project?.id;
          if (typeof id !== 'string' || !id) throw new Error('Project creation did not return a native identity. Refresh and retry.');
        }
        const saved = (await rpc('projects.get', { id }))?.project;
        if (saved?.id !== id || saved.archived || !saved.folders?.some(folder => folder.path === project.cwd) ||
          fields.some(key => (saved[key] ?? null) !== (expected[key] || null))) throw new Error('The server did not confirm this project change. Refresh and retry.');
        check(scope);
        for (const [key, data] of client.getQueriesData({ queryKey: scopeKey(scope) })) {
          if (['sessions', 'expanded', 'archives', 'page', 'archive-page', 'runtime'].includes(key[4]) && Array.isArray(data?.sessions)) {
            const sessions = data.sessions.map(row => row.project?.id === project.id || row.project?.id === id
              ? { ...row, project: { ...row.project, id, name: saved.name, icon: saved.icon, color: saved.color } } : row);
            if (sessions.some((row, index) => row !== data.sessions[index])) client.setQueryData(key, { ...data, sessions });
          } else if (key[4] === 'projects' && Array.isArray(data?.projects)) {
            const projects = data.projects.map(choice => choice.projectId === project.id || choice.projectId === id
              ? { ...choice, id: `${id}:${choice.path}`, projectId: id, name: saved.name, icon: saved.icon, color: saved.color } : choice);
            if (projects.some((choice, index) => choice !== data.projects[index])) client.setQueryData(key, { ...data, projects });
          }
        }
        confirmed = true;
        return saved;
      } finally {
        writing = false;
        if (!disposed && sameScope(scope, env.capture())) {
          if (dispatched && (!confirmed || adopted)) {
            client.removeQueries({ queryKey: [...scopeKey(scope), 'page'] });
            refresh(scope, { queryKey: scopeKey(scope) });
          } else {
            if (confirmed) refresh(scope, { queryKey: [...scopeKey(scope), 'projects'] });
            // Cancellation must not strand a first expansion with no data or recovery poll; resume only reads already in progress, not settled history.
            for (const queryKey of interrupted) {
              try { void client.refetchQueries({ queryKey, exact: true, type: 'active' }, { cancelRefetch: false }).catch(() => {}); } catch (_) { /* background recovery */ }
            }
          }
        }
      }
    },
    async ackWake(scope, row) {
      const woke_at = row.meta?.woke_at;
      if (!(Number.isFinite(woke_at) && woke_at > 0)) return;
      const key = JSON.stringify([...scopeKey(scope), durableId(row), woke_at]);
      if (wakeAcks.has(key)) return wakeAcks.get(key);
      const work = this.mutate(scope, durableId(row), { action: 'ack_wake', woke_at });
      wakeAcks.set(key, work);
      try { return await work; } finally { wakeAcks.delete(key); }
    },
    async ackDone(scope, row) {
      const done_token = row.completion?.done_token;
      if (!done_token) return;
      const key = JSON.stringify([...scopeKey(scope), durableId(row), done_token]);
      if (doneAcks.has(key)) return doneAcks.get(key);
      const work = this.mutate(scope, durableId(row), { action: 'ack_done', done_token });
      doneAcks.set(key, work);
      try { return await work; } finally { doneAcks.delete(key); }
    },
    async open(scope, row) {
      const route = await routeFor(scope); check(scope);
      await fenced(scope, () => env.host.openSession(row.resolved_id || row.id, { route, profile: route?.profile || scope.profile, intent: 'in-place' }));
      await this.ackWake(scope, row);
      await this.ackDone(scope, row);
      check(scope); refresh(scope, { queryKey: [...scopeKey(scope), 'sessions'] });
    },
    async projects(scope) {
      return projectsFor(scope, await routeFor(scope));
    },

    async projectHome(scope) {
      const route = await routeFor(scope);
      const value = await fenced(scope, () => ctx.rest('/environment'));
      if (value?.profile !== (route?.targetProfile || scope.profile) || typeof value.home !== 'string' || !value.home) throw new Error('Current-profile backend home path unavailable.');
      return value.home;
    },

    async newChat(scope, project, idempotencyKey) {
      const route = await routeFor(scope); check(scope);
      if (project === undefined) return env.host.newChat(route); // Preserve archive-and-advance fallback.
      if (project.isNoProject || project.id === '__no_project__') throw new Error('Home creation is unavailable: the public Desktop SDK cannot select a detached workspace. No session was created. Use native Home new chat.');
      if (typeof project.path !== 'string' || !project.path || !idempotencyKey) throw new Error('Choose a project folder before creating a session.');
      const created = await fenced(scope, () => env.host.requestProfile(route, 'session.create', {
        source: 'desktop', cwd: project.path, cwd_explicit: true, close_on_disconnect: false, idempotency_key: idempotencyKey
      }));
      if (!created?.stored_session_id || !created?.session_id) throw new Error('Session creation did not return stored and runtime identities.');
      await fenced(scope, () => env.host.openSession(created.stored_session_id, {
        route, profile: route?.profile || scope.profile, intent: 'in-place', awaitHydration: true, expectHistory: false
      }));
      const owner = env.host.state.focusedSessionOwner.get();
      if (env.host.state.focusedStoredSessionId.get() !== created.stored_session_id ||
        owner?.connectionId !== (scope.connectionId ?? 'local') || owner?.profile !== scope.profile) {
        throw new Error('Workspace handoff cancelled: selection changed after session creation. No final workspace update was sent.');
      }
      const info = await fenced(scope, () => env.host.requestProfile(route, 'session.cwd.set', { session_id: created.session_id, cwd: project.path }));
      if (info?.cwd !== project.path) throw new Error('The session workspace was not confirmed. Do not send a message until the native workspace is checked.');
      return created;
    }
  };
}

const CSS = `
/* Desktop's --ui-purple (#9e94d5 in both modes) is 2.7:1 on light backgrounds. Mixing in the base text darkens it in light mode and lightens it in dark mode; doubling OKLCH chroma restores the saturation the mix removes. */
.sf,.sf-menu{--sf-purple:color-mix(in srgb,var(--ui-purple,#9e94d5) 70%,var(--ui-base,var(--ui-text-primary)));--sf-purple:oklch(from color-mix(in oklab,var(--ui-purple,#9e94d5) 65%,var(--ui-base,var(--ui-text-primary))) l calc(c * 2) h)}
/* Card geometry: --sf-card-content (two text lines), --sf-card-padding and --sf-card-margin (vertical, per side). Defaults are fallbacks rather than declarations, so :root, a theme or any ancestor can set them; the stride used by windowing and shelf minimums derives from them. */
.sf{--sf-card-stride:calc(var(--sf-card-content,42px) + 2 * var(--sf-card-padding,6px) + 2 * var(--sf-card-margin,1px))}
.sf{display:flex;flex-direction:column;height:100%;min-height:0;min-width:220px;font:12px/1.4 var(--font-sans,inherit);color:var(--ui-text-primary)}
.sf *{box-sizing:border-box}.sf button,.sf input,.sf select{font:inherit}.sf button{cursor:pointer}.sf button:disabled{cursor:default;opacity:.4}
.sf button:focus-visible,.sf input:focus-visible,.sf select:focus-visible{outline:2px solid var(--ui-accent);outline-offset:-2px}
.sf-header{padding:6px 12px;display:flex;align-items:center;gap:5px;height:40px;flex-shrink:0}.sf-icon{display:inline-flex;flex-shrink:0;align-items:center;justify-content:center;width:27px;height:27px;padding:4px;border:0;border-radius:4px;color:var(--ui-text-tertiary);background:transparent}
.sf-icon:hover,.sf-icon[aria-expanded=true],.sf-row:hover,.sf-row:focus-within,.sf-row[data-menu-open=true],.sf-section-toggle:hover{background:var(--chrome-action-hover,var(--ui-bg-quaternary));color:var(--ui-text-primary)}
.sf-search{display:flex;align-items:center;gap:8px;flex:1;min-width:0;height:27px;margin-left:-6px;padding:0 6px;border-radius:4px;color:var(--ui-text-tertiary)}.sf-search:focus-within{background:var(--chrome-action-hover,var(--ui-bg-quaternary));color:var(--ui-text-primary);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ui-accent) 70%,transparent)}.sf .sf-search input:focus-visible{outline:none}.sf-search svg{flex-shrink:0;width:18px;height:18px}
.sf-search input{width:100%;min-width:0;padding:0;border:0;background:transparent;color:var(--ui-text-primary);outline:none}
.sf-search input::-webkit-search-cancel-button{-webkit-appearance:none}.sf-search .sf-clear{width:20px;height:20px;padding:2px;visibility:visible;opacity:1}
.sf-header input{font-size:14px}.sf-menu select{max-width:260px;background:var(--ui-bg-quaternary);color:var(--ui-text-primary);border:1px solid var(--ui-stroke-secondary)}
.sf-scroll{overflow:hidden;flex:1;min-height:0;display:flex;flex-direction:column;padding:0 6px;gap:1px}
.sf-shelves{display:grid;flex:1;min-height:0;gap:1px;transition:grid-template-rows .22s ease}
/* Fixed header minima survive short panes; Archives gets most of the flexible space. */
.sf-section{display:flex;flex-direction:column;min-height:0;overflow:hidden}.sf-section[data-section=pinned]{flex:0 1 auto;max-height:18%}.sf-section[data-section=active]{grid-row:1}.sf-section[data-section=working]{grid-row:2}.sf-section[data-section=snoozed]{grid-row:3}.sf-section[data-section=archived]{grid-row:4}
/* Working and Snoozed contribute their intrinsic header + body size to a fit-content track; animating their own body track keeps the parent cap stable during reversals. Content sizing also lets the shelves follow cards animating in and out. */
.sf-section:is([data-section=working],[data-section=snoozed]){display:grid;grid-template-rows:30px minmax(0,1fr);min-height:31px;transition:grid-template-rows .22s ease}.sf-section:is([data-section=working],[data-section=snoozed])[data-closed=true]{grid-template-rows:30px minmax(0,0fr);min-height:30px}.sf-section:is([data-section=working],[data-section=snoozed])[data-populated=false]{min-height:30px}
/* An empty Pinned stays mounted (zero height, gap cancelled) so its last card can animate out. */
.sf-section[data-section=pinned][data-populated=false]{margin-bottom:-1px}
.sf-section-body{overflow:auto;overscroll-behavior:contain;min-height:0;flex:1 1 auto;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--ui-text-primary) 28%,transparent) transparent}
/* Fade the bottom edge only while more content lies below, so lists never run hard into the next heading. */
.sf-section-body[data-more-below=true]{mask-image:linear-gradient(to bottom,#000 calc(100% - 18px),transparent)}.sf-section-toggle{display:flex;flex-shrink:0;align-items:center;gap:5px;width:100%;height:30px;min-height:30px;padding:9px 6px 3px;border:0;background:transparent;color:var(--ui-text-secondary);font-size:11px;text-align:left}.sf-section-label{font-weight:500;color:var(--ui-accent)}.sf-count{color:var(--ui-text-tertiary);font-variant-numeric:tabular-nums}.sf-section-label,.sf-count,.sf-section-chevron{flex-shrink:0}.sf-section-line{flex:1;min-width:0;height:1px;background:var(--ui-stroke-secondary)}.sf-section-chevron{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px}
/* The margin is a transparent border clipping each card's background: adjacent hovered/selected/draft cards stay visually separate while the stride stays exact. */
.sf-row{position:relative;height:var(--sf-card-stride);flex-shrink:0;padding:0 10px;border-block:var(--sf-card-margin,1px) solid transparent;border-radius:6px}.sf .sf-row{background-clip:padding-box!important}/* the hover/selected/draft background shorthands would reset it */.sf-row[data-current=true]{background:var(--ui-bg-quaternary);box-shadow:inset 2px 0 var(--ui-accent)}
.sf-row[data-has-draft=true][data-current=false]{background:color-mix(in srgb,var(--ui-orange,#db704b) 10%,transparent)}
.sf-row[data-has-draft=true][data-current=false]:hover,.sf-row[data-has-draft=true][data-current=false]:focus-within{background:color-mix(in srgb,var(--ui-orange,#db704b) 14%,transparent)}
/* Recede only the neutral title so status labels, colored icons and metadata stay readable. */
.sf-row[data-dimmed=true]:not([data-unread=true]) .sf-row-title{color:var(--ui-text-secondary)}.sf-row[data-dimmed=true]:hover .sf-row-title,.sf-row[data-dimmed=true]:focus-within .sf-row-title,.sf-row[data-dimmed=true][data-menu-open=true] .sf-row-title{color:var(--ui-text-primary)}
/* Native semantic blue is independent of the user's configurable accent. */
.sf-row[data-working=true] .sf-time{color:var(--ui-blue,#0053fd)}
.sf-open{display:flex;flex-direction:column;justify-content:center;gap:3px;width:100%;height:100%;min-width:0;padding:var(--sf-card-padding,6px) 0;border:0;background:transparent;text-align:left;color:inherit}.sf-card-meta{display:flex;align-items:center;gap:8px;width:100%;min-width:0;font-size:12px;color:var(--ui-text-tertiary);height:19px}.sf-project{display:flex;align-items:center;gap:7px;flex:1;min-width:0}.sf-project-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sf-project-icon{display:inline-flex;align-items:center;justify-content:center;width:19px;height:19px;border-radius:4px;background:transparent;flex-shrink:0}.sf-project-icon svg{width:13px;height:13px}/* Quieter than the other metadata. The filled provider logo covers about 2.3x more of its box than digits do, so at equal colour it reads heavier; 0.7 opacity (about the square root of that ratio) evens them out. */
.sf-row .sf-token,.sf-row .sf-provider{color:color-mix(in srgb,var(--ui-base,var(--ui-text-primary)) 46%,transparent)}.sf-row .sf-provider{opacity:.7}
.sf-provider{display:flex;width:14px;height:14px;flex-shrink:0}.sf-provider svg{width:14px;height:14px}.sf-token,.sf-time{flex-shrink:0;white-space:nowrap;font-variant-numeric:tabular-nums}.sf-time{display:inline-flex;align-items:center}.sf-row-title{display:block;width:100%;font-size:14px;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sf-wait{color:var(--ui-accent);flex-shrink:0;display:inline-flex}.sf-pin{display:inline-flex;flex-shrink:0}/* Equal top and right insets; 4px also centres the 25px strip on the 19px metadata line. */
.sf-hover{position:absolute;right:4px;top:4px;height:25px;display:flex;visibility:hidden;align-items:center;gap:2px;background:var(--ui-bg-elevated,var(--ui-bg-quaternary));border-radius:4px}.sf-hover .sf-icon{width:22px;height:25px}.sf-hover .sf-archive{width:auto;gap:4px;white-space:nowrap}.sf-row:hover .sf-hover{visibility:visible}/* The SDK Button's transition-all would keep hidden actions visible for its 100ms: swap instantly. */.sf-hover .sf-icon{transition:none}.sf-row:hover .sf-provider,.sf-row:hover .sf-token,.sf-row:hover .sf-time{visibility:hidden}
.sf-context-trigger{position:absolute;right:8px;top:4px;width:1px;height:1px;clip-path:inset(50%);overflow:hidden;padding:0;border:0}
.sf-row[data-menu-open=true] .sf-hover{visibility:visible}.sf-row[data-menu-open=true] .sf-provider,.sf-row[data-menu-open=true] .sf-token,.sf-row[data-menu-open=true] .sf-time{visibility:hidden}
.sf-empty{padding:7px 20px;color:var(--ui-text-quaternary);font-size:11px}.sf-note{margin:5px 10px;padding:7px;border:1px solid var(--ui-stroke-secondary);border-radius:4px;font-size:11px;color:var(--ui-text-secondary)}
.sf-group{padding:6px 12px 2px;font-size:10px;color:var(--ui-text-quaternary)}
.sf-menu{display:flex;flex-direction:column;gap:4px;padding:8px;min-width:200px;max-width:290px;color:var(--ui-text-primary)}.sf-menu button{justify-content:flex-start}.sf-menu-title{font-size:11px;color:var(--ui-text-tertiary);margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sf-menu label{font-size:11px}.sf-menu input{width:100%;background:var(--ui-bg-quaternary);color:var(--ui-text-primary);border:1px solid var(--ui-stroke-secondary);padding:5px}.sf-menu p{font-size:10px;color:var(--ui-text-tertiary);margin:4px 0}.sf-error{color:var(--ui-accent)}
.sf-row .sf-project{gap:4px}/* Start the glyph at the title's left edge; Codicons also carry a 1/16em side bearing. */.sf-row .sf-project-icon{width:auto;min-width:13px;justify-content:flex-start}.sf-row .sf-project-icon>.codicon{margin-left:calc(-1em / 16)}/* Outranks the Working time color: a snoozed card can still be running. */
.sf-row .sf-time.sf-snooze-time{display:inline-flex;align-items:center;gap:4px;color:var(--sf-purple);font-weight:400}.sf-snooze-time svg{width:13px;height:13px;flex-shrink:0}.sf-menu button.sf-unsnooze{color:var(--ui-green,#1f8a65)}
.sf-menu button.sf-snooze-info:disabled{display:flex;gap:12px;width:100%;white-space:nowrap;color:var(--sf-purple);opacity:1;font-weight:400;cursor:default}.sf-snooze-remaining{margin-left:auto;text-align:right}.sf-menu .sf-custom-snooze{padding:0 8px}.sf-menu .sf-custom-snooze,.sf-menu .sf-snooze-info,.sf-menu .sf-snooze-action{padding-left:8px;padding-right:8px}
.sf-project-choice{display:flex;align-items:center;gap:7px;min-width:0}.sf-project-choice[aria-expanded=true]{background:var(--chrome-action-hover,var(--ui-bg-quaternary));color:var(--ui-text-primary)}.sf-project-picker .sf-project-choice[aria-pressed=true]{background:color-mix(in srgb,var(--ui-text-primary) 10%,transparent);color:var(--ui-text-primary)}
.sf-project-picker{box-sizing:border-box;width:min(440px,calc(100vw - 18px));min-width:0;max-width:none;max-height:min(720px,calc(100dvh - 24px),calc(var(--radix-popover-content-available-height,100dvh) - 2px));overflow:hidden}.sf-project-picker>strong,.sf-project-picker>input{flex-shrink:0}.sf-project-picker>input{box-sizing:border-box;min-width:0}.sf-menu.sf-project-picker>.sf-project-options{gap:0;overflow-y:auto;overscroll-behavior:contain;min-height:0}.sf-project-picker .sf-project-choice{box-sizing:border-box;flex-shrink:0;width:100%;height:24px;min-height:24px;padding:4px 8px;font-size:12px;line-height:16px;gap:8px;border:0}.sf-project-picker .sf-project-icon{width:14px;height:14px}.sf-project-details{display:flex;align-items:center;gap:12px;flex:1;min-width:0;text-align:left}.sf-project-details>.sf-project-name,.sf-project-path{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.sf-project-details>.sf-project-name{max-width:55%}.sf-project-path{flex:1;margin-left:auto;text-align:right;font-size:11px;font-weight:400;line-height:16px;color:var(--ui-text-tertiary)}
.sf-project-group{display:flex;flex-direction:column;gap:0;flex-shrink:0}.sf-project-picker .sf-project-folder{padding-left:30px}.sf-project-folder .sf-project-path{text-align:left;margin-left:0}.sf-project-heading .sf-project-name{max-width:100%}.sf-project-heading[aria-disabled=true]{opacity:1;cursor:default}
.sf-menu .sf-menu-action{display:flex;align-items:center;gap:8px}.sf-menu-icon{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex-shrink:0}.sf-menu-icon svg{width:14px;height:14px}.sf-menu button.sf-menu-action[data-destructive=true]{color:var(--ui-red)}
.sf-menu-label{display:flex;align-items:center;flex:1;min-width:0}
.sf-menu>div:not(.sf-menu-title),.sf-menu form{display:flex;flex-direction:column;gap:4px}
.sf-project-submenu{box-sizing:border-box;width:508px;max-width:calc(100vw - 18px);max-height:min(calc(100vh - 32px),var(--radix-popover-content-available-height,100vh));overflow:auto}.sf-project-submenu fieldset{border:0;padding:0;margin:4px 0;min-width:0}.sf-project-submenu legend{font-size:11px;color:var(--ui-text-tertiary);margin-bottom:7px}.sf-project-submenu fieldset:disabled{opacity:.5}
.sf-project-colors{display:grid;grid-template-columns:repeat(24,minmax(0,1fr));gap:4px;width:476px;max-width:100%;padding:3px;box-sizing:border-box}.sf-project-colors button{display:block;box-sizing:border-box;width:100%;aspect-ratio:1/1.618033989;padding:0;border:0;border-radius:4px;cursor:pointer}.sf-project-colors button:hover{box-shadow:0 0 0 1px var(--ui-text-primary)}.sf-project-colors button[aria-pressed=true],.sf-project-colors button:focus-visible{outline:2px solid var(--ui-text-primary);outline-offset:1px}
.sf-project-icon-categories{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 14px}.sf-project-submenu .sf-project-icon-category{margin:0}.sf-project-submenu .sf-project-icon-category legend{font-size:10px;margin-bottom:4px}.sf-project-icons{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:2px}.sf-project-icons button{display:flex;align-items:center;justify-content:center;height:25px;min-width:0;padding:3px;border:0;border-radius:4px;background:transparent;color:var(--sf-project-color)}.sf-project-icons button:hover,.sf-project-icons button[aria-pressed=true]{background:var(--ui-control-hover-background);color:var(--sf-project-color)}.sf-submenu-arrow{display:inline-flex;margin-left:auto}
@media(max-width:520px){.sf-project-icon-categories{grid-template-columns:minmax(0,1fr)}}
.sf-status{font-weight:600}
.sf-project,.sf-time{color:var(--ui-text-secondary)}.sf-status{display:inline-flex;align-items:center;gap:4px}.sf-status svg{width:13px;height:13px;flex-shrink:0}.sf-status[data-status=done]{color:var(--ui-green,#1f8a65)}.sf-status[data-status=woke]{color:var(--sf-purple)}.sf-status[data-status=input]{color:var(--ui-orange,#db704b)}.sf-status[data-status=working]{color:var(--ui-blue,#0053fd)}.sf-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.sf-working-duration{font-variant-numeric:tabular-nums}.sf-row[data-unread=true] .sf-row-title{font-weight:600}
/* Folding moves only the section edge: pinned lists keep their size and slide under a fade at that edge instead of resizing (and toggling scrollbars) every frame. */
.sf-section[data-pinned=true]>.sf-section-body{height:var(--sf-pin);flex:none}
.sf-section[data-pinned=true]{mask:linear-gradient(#000,#000) top/100% 30px no-repeat,linear-gradient(to bottom,#000 calc(100% - 18px),transparent)}
.sf-section[data-pinned=true][data-section=active]{mask:linear-gradient(to bottom,#000 calc(100% - 18px),transparent)}
.sf-section[data-closed=true] .sf-section-body{visibility:hidden;transition:visibility 0s .22s}.sf-section-chevron{transition:transform .22s ease}.sf-row{transition:background-color .16s ease,box-shadow .16s ease}.sf-custom-time{display:flex;align-items:center;gap:4px}.sf-custom-time input{min-width:0}.sf-custom-time .sf-icon{flex-shrink:0}
/* Empty-state text waits for leaving cards to collapse instead of appearing under them (visibility only, no fade). */
@keyframes sf-after-exit{from{visibility:hidden}}.sf-empty{animation:sf-after-exit .22s step-end}
@media(prefers-reduced-motion:reduce){.sf-empty{animation:none}.sf-shelves,.sf-section:is([data-section=working],[data-section=snoozed]),.sf-section-body,.sf-section-chevron,.sf-row{transition:none!important}}
`;
// Monochrome brand paths: Simple Icons 15.20.0 (CC0), fetched from its pinned GitHub tag.
const PROVIDER_PATHS = {
  anthropic: 'M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z',
  google: 'M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81',
  openai: 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z'
};
function providerMark(provider) {
  const slug = typeof provider === 'string' ? provider.toLowerCase() : '';
  const path = PROVIDER_PATHS[slug === 'openai-codex' ? 'openai' : slug === 'gemini' ? 'google' : slug];
  return typeof path === 'string' ? h('svg', { viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true, 'data-provider-mark': slug }, h('path', { d: path })) : null;
}
function projectMark(project) {
  const value = typeof project?.icon === 'string' ? project.icon.trim() : '';
  if (value && !/^[a-z][a-z0-9-]*$/.test(value)) return value;
  const name = value || (project?.is_home || project?.isNoProject ? 'home' : 'folder');
  return sdk.Codicon ? h(sdk.Codicon, { name, size: 13 }) : icon(name === 'home' ? 'House' : 'Folder', '◇');
}
// T3 Code's Lucide v1.59.0 status glyphs (ISC); the Desktop SDK icon set exports none of them. Circles are written as arcs.
const STATUS_ICONS = {
  working: ['M10.1 2.182a10 10 0 0 1 3.8 0', 'M13.9 21.818a10 10 0 0 1-3.8 0', 'M17.609 3.721a10 10 0 0 1 2.69 2.7', 'M2.182 13.9a10 10 0 0 1 0-3.8', 'M20.279 17.609a10 10 0 0 1-2.7 2.69', 'M21.818 10.1a10 10 0 0 1 0 3.8', 'M3.721 6.391a10 10 0 0 1 2.7-2.69', 'M6.391 20.279a10 10 0 0 1-2.69-2.7'],
  input: ['M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719', 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3', 'M12 17h.01'],
  done: ['M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0', 'm16 9-5.5 5.5L8 12'],
  woke: ['M4 13a8 8 0 1 0 16 0a8 8 0 1 0-16 0', 'M12 9v4l2 2', 'M5 3 2 6', 'm22 6-3-3', 'M6.38 18.7 4 21', 'M17.64 18.67 20 21'],
};
function statusIcon(status) {
  // Lucide's stroke 2 keeps Done's rim thicker than the native Codicon pass glyph.
  return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, 'data-status-icon': status },
    STATUS_ICONS[status].map(d => h('path', { key: d, d })));
}
// Tabler v3.44.0 (MIT), the Desktop SDK's own icon family; its export surface omits these alarm glyphs.
const BUNDLED_ICONS = {
  Alarm: ['M5 13a7 7 0 1 0 14 0a7 7 0 1 0 -14 0', 'M12 10l0 3l2 0', 'M7 4l-2.75 2', 'M17 4l2.75 2'],
  AlarmOff: ['M7.587 7.566a7 7 0 1 0 9.833 9.864m1.35 -2.645a7 7 0 0 0 -8.536 -8.56', 'M12 12v1h1', 'M5.261 5.265l-1.011 .735', 'M17 4l2.75 2', 'M3 3l18 18'],
  AlarmSnooze: ['M5 13a7 7 0 1 0 14 0a7 7 0 1 0 -14 0', 'M10 11h4l-4 4h4', 'M7 4l-2.75 2', 'M17 4l2.75 2'],
};
// T3 Code's elapsed format: 12s, then 4m, then 1h 5m.
export function formatWorkingDuration(elapsedMs) {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
// One shared interval, running only while a Working timer is mounted, re-renders just those labels.
const secondTicker = (() => {
  const listeners = new Set(); let timer = null;
  return listener => {
    listeners.add(listener);
    if (!timer) { timer = setInterval(() => listeners.forEach(notify => notify()), 1000); timer.unref?.(); }
    return () => { listeners.delete(listener); if (!listeners.size) { clearInterval(timer); timer = null; } };
  };
})();
function WorkingDuration({ startedAt }) {
  const [, tick] = useState(0);
  useEffect(() => secondTicker(() => tick(count => count + 1)), []);
  // Decorative: the label already announces Working, and a per-second change would be noisy.
  return h('span', { className: 'sf-working-duration', 'aria-hidden': true }, formatWorkingDuration(Date.now() - startedAt * 1000));
}
function icon(name, fallback) {
  if (BUNDLED_ICONS[name]) return h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, 'data-icon': name }, BUNDLED_ICONS[name].map(d => h('path', { key: d, d })));
  const local = { Archive: 'M3 3h18v4H3zM5 7v14h14V7M10 11h4', ArchiveRestore: 'M3 3h18v4H3zM5 7v14h14V7M12 17v-7M9 13l3-3 3 3', SquarePen: 'M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7M10 14l1-4 9-9 3 3-9 9-4 1', ListFilter: 'M4 6h16M7 12h10M10 18h4' }[name];
  if (local) return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: local }));
  const Component = sdk.icons?.[name]; return Component ? h(Component, { size: 14, 'aria-hidden': true }) : h('span', { 'aria-hidden': true }, fallback);
}
function IconButton({ label, name, glyph, children, title = label, ...props }) { return h(sdk.Button, { type: 'button', variant: 'ghost', size: 'icon-xs', ...props, className: `sf-icon ${props.className || ''}`, 'aria-label': label, title }, children ?? icon(name, glyph)); }
function MenuAction({ name, codicon, className = '', destructive = false, children, ...props }) {
  return h(sdk.Button, { type: 'button', variant: 'ghost', size: 'sm', ...props, className: `sf-menu-action ${className}`.trim(), 'data-destructive': destructive || undefined },
    h('span', { className: 'sf-menu-icon', 'aria-hidden': true }, codicon ? h(sdk.Codicon, { name: codicon, size: 14 }) : icon(name)), h('span', { className: 'sf-menu-label' }, children));
}
function Note({ children, error = false }) { return h('div', { className: 'sf-note', role: error ? 'alert' : 'status' }, children); }
function Settings({ ctx }) {
  const client = useQueryClient(), presetTime = useSnoozeTime(ctx);
  const [error, setError] = useState('');
  const save = value => {
    if (!validSnoozeTime(value)) { setError('Choose a valid time.'); return; }
    try {
      ctx.storage.set('snooze-time', value);
      if (ctx.storage.get('snooze-time') !== value) throw new Error('The snooze preset time was not saved.');
      client.setQueryData(SNOOZE_TIME_KEY, value); setError('');
    } catch (err) { setError(err.message); }
  };
  return h('section', { style: { padding: 20, maxWidth: 650, color: 'var(--ui-text-secondary)' } },
    h('h2', null, 'hermes-t3sidebar'), h('p', null, 'A compact T3-style session browser for the active source and profile.'),
    h('label', null, 'Snooze preset time ', h('input', { type: 'time', step: 60, value: presetTime, 'aria-label': 'Snooze preset time', onChange: event => save(event.target.value) })),
    h('p', null, 'Used for Tomorrow and Next Monday in this Desktop client’s local time. Defaults to 09:00; existing snoozes are unchanged.'),
    error ? h('div', { role: 'alert' }, error) : null,
    h('p', null, 'Archive and Unarchive change native Hermes archives and keep conversation history. Snoozes return when their chosen time passes; no agent is stopped or awakened, and no prompt is sent.'),
    h('p', null, 'Use normal layout controls to select hermes-t3sidebar in the left pane or hide the native Sessions pane. hermes-t3sidebar never modifies the core sidebar or conversation workspace.'),
    h('p', null, 'Project filtering changes this list only. New session asks for a named project before creating an empty session; Home creation is unavailable with the current public workspace contract.'),
    h('p', null, 'Keyboard: ↑/↓ or Home/End to focus rows; Enter to open; Shift+F10 for actions; Shift+Enter to archive and advance (only with confirmed idle status).'),
    h('p', null, 'Pins and snoozes belong to this plugin’s backend. Archived includes existing native archives, sorted by last activity, not archive time. Older plugin-only completed entries return to Ready; no history is automatically archived. Missing backend: browsing remains available, organization is read-only.'));
}
// Approved project metadata palette and Codicons; independent of chrome/theme colors.
export const PROJECT_ICON_GROUPS = [
  { label: 'Projects & workspaces', icons: ['folder-library', 'folder', 'folder-opened', 'repo', 'project', 'home', 'organization', 'briefcase'] },
  { label: 'Code & development', icons: ['code', 'terminal', 'file-code', 'git-branch', 'git-merge', 'extensions', 'bug', 'json'] },
  { label: 'Hardware & robotics', icons: ['circuit-board', 'chip', 'tools', 'wrench', 'settings-gear', 'device-desktop', 'device-mobile', 'robot'] },
  { label: 'Infrastructure & networks', icons: ['server', 'server-process', 'cloud', 'database', 'globe', 'broadcast', 'remote', 'plug'] },
  { label: 'Research & analysis', icons: ['beaker', 'telescope', 'lightbulb', 'search', 'inspect', 'graph', 'pulse', 'symbol-ruler'] },
  { label: 'Documents & legal', icons: ['book', 'library', 'file-text', 'file-pdf', 'notebook', 'note', 'law', 'shield'] },
  { label: 'Planning & business', icons: ['calendar', 'checklist', 'target', 'milestone', 'dashboard', 'credit-card', 'key', 'package'] },
  { label: 'Personal & creative', icons: ['rocket', 'flame', 'star-full', 'heart', 'zap', 'gift', 'coffee', 'music'] },
];
export const PROJECT_PALETTE = [
  { name: 'Red', value: '#fc2b3b' },
  { name: 'Vermilion', value: '#f95812' },
  { name: 'Orange', value: '#e08614' },
  { name: 'Amber', value: '#e5b81b' },
  { name: 'Gold', value: '#e1e020' },
  { name: 'Citron', value: '#bbe51f' },
  { name: 'Lime', value: '#78c318' },
  { name: 'Grass', value: '#50ca18' },
  { name: 'Green', value: '#1bce26' },
  { name: 'Emerald', value: '#1ccc58' },
  { name: 'Mint', value: '#1cca7f' },
  { name: 'Turquoise', value: '#1cc6a2' },
  { name: 'Cyan', value: '#1cc2c3' },
  { name: 'Sky', value: '#16a1c8' },
  { name: 'Blue', value: '#1083df' },
  { name: 'Royal blue', value: '#345bfb' },
  { name: 'Indigo', value: '#5451fb' },
  { name: 'Iris', value: '#7b4afb' },
  { name: 'Violet', value: '#ab5bfc' },
  { name: 'Purple', value: '#ce39fc' },
  { name: 'Magenta', value: '#e819ea' },
  { name: 'Fuchsia', value: '#ef18c4' },
  { name: 'Rose', value: '#f51799' },
  { name: 'Crimson', value: '#fc186c' },
  { name: 'Dark red', value: '#af0d21' },
  { name: 'Dark vermilion', value: '#9f3507' },
  { name: 'Brown', value: '#864e08' },
  { name: 'Dark amber', value: '#725b08' },
  { name: 'Dark gold', value: '#626208' },
  { name: 'Dark citron', value: '#536708' },
  { name: 'Dark lime', value: '#406c08' },
  { name: 'Dark grass', value: '#297008' },
  { name: 'Dark green', value: '#0a7210' },
  { name: 'Dark emerald', value: '#0a712d' },
  { name: 'Dark mint', value: '#0a7044' },
  { name: 'Dark turquoise', value: '#0a6e59' },
  { name: 'Dark cyan', value: '#0a6b6b' },
  { name: 'Dark sky', value: '#0a6882' },
  { name: 'Dark blue', value: '#095fa5' },
  { name: 'Dark royal blue', value: '#212efa' },
  { name: 'Dark indigo', value: '#4617fa' },
  { name: 'Dark iris', value: '#6511e5' },
  { name: 'Dark violet', value: '#7d0fca' },
  { name: 'Dark purple', value: '#8d0db0' },
  { name: 'Dark magenta', value: '#970c99' },
  { name: 'Dark fuchsia', value: '#9f0c82' },
  { name: 'Dark rose', value: '#a60c66' },
  { name: 'Dark crimson', value: '#ac0c47' },
];
const PROJECT_MENU_STYLE = { padding: 0, width: 'max-content', maxWidth: 'calc(100vw - 16px)' };
function projectMenuKeyDown(event, close) {
  const editing = ['INPUT', 'TEXTAREA'].includes(event.target.tagName) || event.target.isContentEditable;
  if (event.key === 'Escape' || event.key === 'ArrowLeft' && !editing) { event.preventDefault(); event.stopPropagation(); close(); }
}
export function ProjectActions({ row, scope, controller, filterProject, close }) {
  const [renaming, setRenaming] = useState(false), [name, setName] = useState(row.project?.name || ''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const project = row.project, editable = !!(project?.id && project.cwd && !project.is_home && !row._limited);
  const perform = async work => {
    if (busy) return;
    setBusy(true); setError('');
    try { controller.check(scope); await work(); controller.check(scope); if (alive.current) close(); }
    catch (err) { if (alive.current && sameScope(scope, captureScope())) setError(err.message); }
    finally { if (alive.current) setBusy(false); }
  };
  const update = patch => void perform(() => controller.updateProject(scope, project, patch));
  return h('div', { className: 'sf-menu sf-project-submenu', style: { '--sf-project-color': project?.color || 'var(--ui-text-tertiary)' } },
    h('div', { className: 'sf-menu-title' }, project?.name || 'Project unavailable'),
    h(MenuAction, { name: 'Pencil', disabled: busy || !editable, onClick: () => setRenaming(true) }, 'Rename'),
    renaming ? h('form', { onSubmit: event => { event.preventDefault(); update({ name }); } },
      h('span', { className: 'sf-custom-time' },
        h('input', { value: name, autoFocus: true, 'aria-label': 'Project name', disabled: busy, onChange: event => setName(event.target.value), onKeyDown: event => { if (event.key === 'Escape') { event.stopPropagation(); setRenaming(false); } } }),
        h(IconButton, { type: 'submit', label: 'Save project rename', name: 'Check', glyph: '✓', disabled: busy || !name.trim() }))) : null,
    h(MenuAction, { name: 'Copy', disabled: busy || !project?.cwd || project.is_home || row._limited || row._multiplePaths, onClick: () => void perform(() => controller.copyProjectPath(scope, project)) }, 'Copy path'),
    h(MenuAction, { name: 'ListFilter', disabled: busy || row._limited || row._multiplePaths || typeof row.cwd !== 'string' && !project?.is_home,
      onClick: () => void perform(() => filterProject(row.cwd || '')) }, 'Filter for'),
    !editable ? h('p', null, 'Project editing requires a named project with a known folder.') : null,
    h('fieldset', { disabled: busy || !editable, 'aria-label': 'Project color' }, h('legend', null, 'Color'),
      h('div', { className: 'sf-project-colors' }, ...PROJECT_PALETTE.map(color => h('button', { key: color.value, type: 'button', 'aria-label': `Project color: ${color.name}`, title: color.name,
        'aria-pressed': project?.color?.toLowerCase() === color.value, style: { backgroundColor: color.value }, onClick: () => update({ color: color.value }) }))),
      h(MenuAction, { codicon: 'circle-slash', onClick: () => update({ color: null }) }, 'No color')),
    h('fieldset', { disabled: busy || !editable, 'aria-label': 'Project icon' }, h('legend', null, 'Icon'),
      h('div', { className: 'sf-project-icon-categories' }, ...PROJECT_ICON_GROUPS.map(group => h('fieldset', { key: group.label, className: 'sf-project-icon-category' },
        h('legend', null, group.label), h('div', { className: 'sf-project-icons' }, ...group.icons.map(icon => h('button', { key: icon, type: 'button', 'aria-label': `Project icon: ${icon}`, title: icon,
          'aria-pressed': project?.icon === icon,
          onClick: () => update({ icon: project?.icon === icon ? null : icon }) }, projectMark({ icon }))))))),
      h(MenuAction, { name: 'FolderOpen', onClick: () => update({ icon: null }) }, 'Default icon')),
    error ? h('div', { role: 'alert', className: 'sf-error' }, error) : null);
}
function MoveProjectActions({ row, scope, controller, close }) {
  const projects = useQuery({ queryKey: [...scopeKey(scope), 'projects'], queryFn: () => controller.projects(scope), retry: false, staleTime: 0 });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const move = async project => {
    if (busy) return;
    setBusy(true); setError('');
    try { await controller.moveProject(scope, row, project); controller.check(scope); if (alive.current) close(); }
    catch (err) { if (alive.current && sameScope(scope, captureScope())) setError(err.message); }
    finally { if (alive.current) setBusy(false); }
  };
  const choices = (projects.data?.projects || EMPTY_ROWS).filter(project => !project.isNoProject);
  const folderCounts = new Map();
  for (const project of choices) folderCounts.set(project.projectId, (folderCounts.get(project.projectId) || 0) + 1);
  const folderLabel = project => `${project.name}${folderCounts.get(project.projectId) > 1 ? ` · ${project.path}` : ''}`;
  return h('div', { className: 'sf-menu' },
    h('div', { className: 'sf-menu-title' }, 'Move to project'),
    ...choices.map(project => h(sdk.Button, { key: project.id, variant: 'ghost', size: 'sm', disabled: busy || row.cwd === project.path,
      'aria-label': `Move to ${folderLabel(project)}`, onClick: () => void move(project) },
      h('span', { className: 'sf-menu-icon', 'aria-hidden': true, style: { color: project.color || undefined } }, projectMark(project)), folderLabel(project))),
    projects.isLoading ? h('p', null, 'Loading projects…') : !choices.length && !projects.isError ? h('p', null, 'No project folders available.') : null,
    projects.isError || error ? h('div', { role: 'alert', className: 'sf-error' }, error || projects.error.message) : null);
}
function RowActions({ row, scope, controller, filterProject, deleteSession, mutate, disabled, close, snoozeOnly = false, presetTime, snoozeDetail }) {
  const [value, setValue] = useState(''), [error, setError] = useState(''), [renaming, setRenaming] = useState(false), [title, setTitle] = useState(row.title || ''), [busy, setBusy] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false), [moveOpen, setMoveOpen] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const snoozeDisabled = row.archived === true;
  const run = payload => { void mutate(row, payload).then(ok => { if (ok && alive.current) close(); }); };
  const perform = async work => {
    setBusy(true); setError('');
    try { controller.check(scope); await work(); controller.check(scope); if (alive.current) close(); }
    catch (err) { if (alive.current && sameScope(scope, captureScope())) setError(err.message); }
    finally { if (alive.current) setBusy(false); }
  };
  const action = (text, name, payload) => h(MenuAction, { key: text, name, disabled: disabled || busy, onClick: () => run(payload) }, text);

  const custom = event => {
    event.preventDefault();
    try { const wake_at = parseLocalWake(value); setError(''); run({ action: 'snooze', wake_at }); } catch (err) { setError(err.message); }
  };
  return h('div', { className: 'sf-menu' }, h('div', { className: 'sf-menu-title' }, sessionTitle(row)),
    snoozeOnly ? h('form', { onSubmit: custom },
      row.meta.state === 'snoozed' ? h(sdk.Button, { type: 'button', variant: 'ghost', size: 'sm', className: 'sf-snooze-info', disabled: true },
        h('span', { className: 'sf-snooze-date' }, `${shortDate.format(new Date(row.meta.wake_at * 1000))} ${shortTime.format(new Date(row.meta.wake_at * 1000))}`),
        h('span', { className: 'sf-snooze-remaining' }, snoozeDetail)) : null,
      row.meta.state === 'snoozed' ? h(MenuAction, { name: 'AlarmOff', className: 'sf-unsnooze sf-snooze-action', disabled: disabled || snoozeDisabled, onClick: () => run({ action: 'restore' }) }, 'Unsnooze') : null,
      ...snoozePresets(Date.now(), presetTime).map(preset => h(MenuAction, { key: preset.label, name: preset.icon, codicon: preset.codicon, className: 'sf-snooze-action', disabled: disabled || snoozeDisabled, onClick: () => run({ action: 'snooze', wake_at: preset.wake_at }) }, preset.label)),
      h('label', { className: 'sf-custom-snooze' }, 'Custom · local time', h('span', { className: 'sf-custom-time' },
        h('input', { type: 'datetime-local', value, disabled: disabled || snoozeDisabled, 'aria-label': 'Custom snooze date and time', onChange: event => { setValue(event.target.value); setError(''); } }),
        h(IconButton, { type: 'submit', label: 'Apply custom snooze', name: 'Check', glyph: '✓', disabled: disabled || snoozeDisabled || !value }))))
      : h('div', null,
        row.archived !== true ? action(row.meta.pinned ? 'Unpin' : 'Pin', 'Pin', { action: row.meta.pinned ? 'unpin' : 'pin' }) : null,
        h(MenuAction, { name: 'Pencil', disabled: busy || !row.runtimeId, onClick: () => setRenaming(true) }, 'Rename'),
        !row.runtimeId ? h('p', null, 'Rename requires a live runtime. Open the thread and retry.') : null,
        renaming ? h('form', { onSubmit: event => { event.preventDefault(); void perform(() => controller.rename(scope, row, title)); } },
          h('span', { className: 'sf-custom-time' },
          h('input', { type: 'text', value: title, autoFocus: true, 'aria-label': 'Session title', disabled: busy, onChange: event => setTitle(event.target.value), onKeyDown: event => { if (event.key === 'Escape') { event.stopPropagation(); setRenaming(false); } } }),
          h(IconButton, { type: 'submit', label: 'Save rename', name: 'Check', glyph: '✓', disabled: busy || !title.trim() }))) : null,
        h(MenuAction, { name: 'Copy', disabled: busy, onClick: () => void perform(() => controller.copyId(scope, row)) }, 'Copy session ID'),
        h(MenuAction, { name: 'Trash2', destructive: true, disabled: disabled || busy || row.status !== 'idle' || row._liveOnly || typeof sdk.ConfirmDialog !== 'function', onClick: () => { controller.check(scope); deleteSession(row); close(); } }, 'Delete session'),
        row._liveOnly ? h('p', null, 'Unsaved sessions must be closed through the native session controls.') : null,
        h(sdk.Popover, { open: moveOpen, onOpenChange: setMoveOpen },
          h(sdk.PopoverTrigger, { asChild: true }, h(MenuAction, { name: 'FolderOpen', 'aria-label': 'Move to project', disabled: disabled || busy || row.status !== 'idle' || row._liveOnly,
            onKeyDown: event => { if (event.key === 'ArrowRight') { event.preventDefault(); setMoveOpen(true); } } }, 'Move to project', h('span', { className: 'sf-submenu-arrow', 'aria-hidden': true }, icon('ChevronRight', '›')))),
          h(sdk.PopoverContent, { side: 'right', align: 'start', style: PROJECT_MENU_STYLE, 'aria-label': 'Move to project',
            onKeyDown: event => projectMenuKeyDown(event, () => setMoveOpen(false)) }, h(MoveProjectActions, { row, scope, controller, close }))),
        h(sdk.Popover, { open: projectOpen, onOpenChange: setProjectOpen },
          h(sdk.PopoverTrigger, { asChild: true }, h(MenuAction, { name: 'FolderOpen', 'aria-label': 'Project', disabled: busy, onKeyDown: event => { if (event.key === 'ArrowRight') { event.preventDefault(); setProjectOpen(true); } } }, 'Project', h('span', { className: 'sf-submenu-arrow', 'aria-hidden': true }, icon('ChevronRight', '›')))),
          h(sdk.PopoverContent, { side: 'right', align: 'start', style: PROJECT_MENU_STYLE, 'aria-label': 'Project actions',
            onKeyDown: event => projectMenuKeyDown(event, () => setProjectOpen(false)) }, h(ProjectActions, { row, scope, controller, filterProject, close })))),
    error ? h('div', { role: 'alert', className: 'sf-error' }, error) : null);
}
export function cardStatus(row, active = false) {
  return row.status === 'waiting' ? 'input' : row.status === 'working' ? 'working' : row.archived === true ? null : row.woke ? 'woke' : ((!active && row.completion?.done_token) || row.unread === true) ? 'done' : null;
}
function useSessionDraft({ row, active, hidden, controller, scope }) {
  const draft = useQuery({
    queryKey: draftKey(scope, row),
    // Neutral boolean seed avoids a second card render for the common empty
    // draft result; mount still performs the same fresh, fenced composer read.
    queryFn: () => controller.hasDraft(scope, row), enabled: !hidden, retry: false, staleTime: 0, initialData: false,
    refetchOnMount: 'always', refetchOnWindowFocus: false, refetchOnReconnect: false, refetchInterval: active && !hidden ? 2000 : false
  });
  const previousDraftView = useRef({ active, hidden });
  useEffect(() => {
    const previous = previousDraftView.current;
    previousDraftView.current = { active, hidden };
    // Enabling a shelf refetches its stale query automatically; avoid a second read here.
    if (!hidden && !previous.hidden && previous.active !== active) void draft.refetch();
  }, [active, hidden, draft.refetch]);
  return draft;
}
function EmptySessionDraft({ row, active, controller, scope, onPresence, refreshAt }) {
  // Keep observing even while its card is absent: otherwise typing into a
  // hidden empty session could never make it appear in the sidebar.
  const draft = useSessionDraft({ row, active, hidden: false, controller, scope });
  const id = draftIdentity(row), present = draft.data === true && !draft.isError;
  useEffect(() => { onPresence(id, present); }, [id, present, onPresence]);
  const previousRefresh = useRef(refreshAt);
  useEffect(() => {
    if (previousRefresh.current !== refreshAt && !active) void draft.refetch();
    previousRefresh.current = refreshAt;
  }, [refreshAt, active, draft.refetch]);
  return null;
}
function statusBadge(badge, row) {
  return h('span', { className: 'sf-status', 'data-status': badge },
    statusIcon(badge),
    // The dashed circle and elapsed time replace the visible Working word; screen readers still hear it.
    badge === 'working' ? h('span', { className: 'sf-sr' }, 'Working') : { done: 'Done', woke: 'Woke', input: 'Input' }[badge],
    badge === 'working' && row.runStartedAt ? h(WorkingDuration, { startedAt: row.runStartedAt }) : null);
}
function SessionRow({ row, active, hidden, draftPresent, controller, scope, mutate, filterProject, deleteSession, disabled, onFocus, onNavigate, rowRef, age, retain, presetTime, snoozeDetail }) {
  const [menuOpen, setMenuOpen] = useState(false), [snoozeOpen, setSnoozeOpen] = useState(false), trigger = useRef(null);
  useEffect(() => { retain?.(row.key, menuOpen || snoozeOpen); return () => retain?.(row.key, false); }, [retain, row.key, menuOpen, snoozeOpen]);
  const ref = useCallback(element => rowRef(row.key, element), [rowRef, row.key]);
  const draft = useSessionDraft({ row, active, hidden: hidden || row.newSession, controller, scope });
  const hasDraft = row.newSession ? draftPresent : draft.data === true && !draft.isError;
  const attention = row.status === 'waiting', snoozed = row.section === 'snoozed', badge = snoozed ? null : cardStatus(row, active);
  const tokens = compactTokens(row), provider = providerMark(row.provider);
  const open = () => Promise.resolve().then(() => controller.open(scope, row)).catch(error => host.notify({ kind: 'error', message: error.message }));
  const keyDown = event => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); setMenuOpen(true); }
    else if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); if (!disabled && (row.archived === true || row.status === 'idle')) void mutate(row, { action: row.archived === true ? 'unarchive' : 'archive', advance: row.archived !== true }); }
    else onNavigate(event, row.key);
  };
  return h('div', { className: 'sf-row', 'data-menu-open': menuOpen || snoozeOpen, 'data-current': active, 'data-has-draft': hasDraft, 'data-working': row.status === 'working', 'data-unread': row.archived !== true && (!!(!active && row.completion?.done_token) || row.unread === true || row.woke) || attention, 'data-dimmed': ['working', 'snoozed', 'archived'].includes(row.section), 'data-session-id': row.key,
    onContextMenu: event => { event.preventDefault(); setMenuOpen(true); } },
    h('button', { type: 'button', className: 'sf-open', ref, 'aria-current': active ? 'page' : undefined,
      'aria-label': `${sessionTitle(row)}${attention ? ', waiting for approval or answer' : ''}${row.status === 'unknown' ? ', status unknown' : ''}`,
      onClick: open, onFocus: () => onFocus(row.key), onBlur: () => onFocus(null), onKeyDown: keyDown,
      title: [sessionTitle(row), row.cwd, row.git_branch, row.status === 'waiting' ? 'Waiting for approval or answer' : row.status].filter(Boolean).join('\n') },
      h('span', { className: 'sf-card-meta' },
        h('span', { className: 'sf-project' },
          h('span', { className: 'sf-project-icon', 'aria-hidden': true, style: { color: row.project?.color || undefined } }, projectMark(row.project)),
          row.archived !== true && row.meta.pinned ? h('span', { className: 'sf-pin', 'aria-label': 'Pinned' }, icon('Pin', '♧')) : null,
          row.project?.name || !row.newSession ? h('span', { className: 'sf-project-name' }, row.project?.name || 'Project unavailable') : null),
        row.status === 'unknown' ? h('span', { className: 'sf-wait', role: 'img', 'aria-label': 'Status unknown' }, '?') : null,
        provider ? h('span', { className: 'sf-provider', role: 'img', 'aria-label': `Provider: ${row.provider}`, title: row.provider }, provider) : null,
        h('span', { className: 'sf-token', title: 'Total input and output tokens', 'aria-label': `Total tokens: ${tokens}` }, tokens),
        // A running snoozed card stays in Snoozed but still shows its Working status, between tokens and the countdown.
        snoozed && row.status === 'working' ? h('span', { className: 'sf-time sf-snooze-working' }, statusBadge('working', row)) : null,
        h('span', { className: snoozed ? 'sf-time sf-snooze-time' : 'sf-time' }, snoozed ? icon('AlarmSnooze', '◷') : null, badge ? statusBadge(badge, row) : snoozed ? h('span', { className: 'sf-snooze-duration' }, age) : age)),
      h('span', { className: 'sf-row-title' }, sessionTitle(row))),
    h('div', { className: 'sf-hover' },
      row.archived !== true ? h(sdk.Popover, { open: snoozeOpen, onOpenChange: setSnoozeOpen },
        h(sdk.PopoverTrigger, { asChild: true }, h(IconButton, { label: 'Snooze session', name: 'Alarm', glyph: '◷', disabled, 'aria-haspopup': 'dialog' })),
        h(sdk.PopoverContent, { align: 'start', side: 'right', style: { padding: 0 }, 'aria-label': 'Snooze session' },
          h(RowActions, { row, scope, controller, mutate, disabled, presetTime, snoozeDetail, snoozeOnly: true, close: () => setSnoozeOpen(false) }))) : null,
      h(sdk.Button, { type: 'button', variant: 'ghost', size: 'xs', className: 'sf-icon sf-archive', 'aria-label': row.archived === true ? 'Unarchive session' : 'Archive session', disabled: disabled || (row.archived !== true && row.status !== 'idle'),
        onClick: () => void mutate(row, { action: row.archived === true ? 'unarchive' : 'archive' }) }, icon(row.archived === true ? 'ArchiveRestore' : 'Archive', '▤'), row.archived === true ? 'Unarchive' : 'Archive')),
    h(sdk.Popover, { open: menuOpen, onOpenChange: setMenuOpen },
      h(sdk.PopoverTrigger, { asChild: true }, h(IconButton, { ref: trigger, className: 'sf-context-trigger', label: `Actions for ${sessionTitle(row)}`, name: 'Ellipsis', glyph: '…', 'aria-haspopup': 'dialog' })),
      h(sdk.PopoverContent, { align: 'start', side: 'right', style: { padding: 0 }, 'aria-label': 'Session actions' }, h(RowActions, { row, scope, controller, filterProject, deleteSession, mutate, disabled, close: () => setMenuOpen(false) }))));
}
// Query structural sharing preserves nested native/project/metadata values. The
// derived row and its lineage array can be new without changing a card. Compare
// every field (including handler inputs), not just its visible title/status.
function sameCard(a, b) {
  if (a === b) return true;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => key === '_lineage_ids'
    ? a[key]?.length === b[key]?.length && (a[key] || EMPTY_ROWS).every((id, index) => id === b[key][index])
    : Object.is(a[key], b[key]));
}
const MemoSessionRow = memo(SessionRow, (previous, next) => Object.keys(next).every(key =>
  key === 'row' ? sameCard(previous.row, next.row) : Object.is(previous[key], next[key])));
// Fixed-height windows keep shelves proportional to their viewport, not history.
// Small lists retain their original DOM; open popovers keep their owner mounted.
// Pin each shelf body to the larger of its start and end height for the duration of the track transitions,
// so lists never resize mid-animation. Seeking the new transitions to their end measures the final layout.
function pinShelfBodies(shelves, run, current) {
  const sections = [...shelves.children].filter(element => element.classList.contains('sf-section'));
  const release = () => { for (const section of sections) { section.style.removeProperty('--sf-pin'); delete section.dataset.pinned; } };
  release();
  const transitions = [shelves, ...sections].flatMap(element => element.getAnimations())
    .filter(animation => animation.transitionProperty === 'grid-template-rows');
  if (!transitions.length) return;
  const bodies = sections.map(section => section.querySelector(':scope > .sf-section-body'));
  const heights = () => bodies.map(body => body ? body.getBoundingClientRect().height : 0);
  const start = heights(), times = transitions.map(animation => animation.currentTime);
  for (const animation of transitions) animation.currentTime = animation.effect.getComputedTiming().endTime;
  const end = heights();
  transitions.forEach((animation, index) => { animation.currentTime = times[index]; });
  // Content-sized shelves (Working, Snoozed) follow their cards' own enter/exit motion; pin them only while they fold themselves.
  const folding = new Set(transitions.map(animation => animation.effect.target));
  sections.forEach((section, index) => {
    if (['working', 'snoozed'].includes(section.dataset.section) && !folding.has(section)) return;
    const pin = Math.max(start[index], end[index]);
    if (pin > 0) { section.style.setProperty('--sf-pin', `${pin}px`); section.dataset.pinned = 'true'; }
  });
  // Cancelled transitions (a reversal) reject; the newer run owns the pins then.
  void Promise.all(transitions.map(animation => animation.finished.catch(() => {}))).then(() => { if (current() === run) release(); });
}
// Resolved card stride in pixels, from the CSS geometry variables; 56px when they are unavailable (non-CSS environments).
const DEFAULT_CARD_STRIDE = 56;
export function cardStride(element) {
  try {
    const style = getComputedStyle(element), value = (name, fallback) => { const parsed = parseFloat(style.getPropertyValue(name)); return Number.isFinite(parsed) ? parsed : fallback; };
    const stride = value('--sf-card-content', 42) + 2 * value('--sf-card-padding', 6) + 2 * value('--sf-card-margin', 1);
    return Number.isFinite(stride) && stride > 0 ? stride : DEFAULT_CARD_STRIDE;
  } catch (_) { return DEFAULT_CARD_STRIDE; }
}
// Cards animate in and out by clipping their slot's height while the card itself keeps its full size. Windowed lists, reduced
// motion and clients without Web Animations change instantly.
const CARD_MOTION = { duration: 220, easing: 'ease' };
const reducedMotion = () => { try { return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } };
function animateSlot(slot, from, to) {
  slot.style.overflow = 'clip';
  const animation = slot.animate([{ height: `${from}px` }, { height: `${to}px` }], CARD_MOTION);
  return animation;
}
// A leaving card is replaced by an inert, attribute-stripped clone of its last DOM, so it cannot be focused, found by
// session ID or receive events while it collapses; React never owns it.
function exitGhost(element) {
  const ghost = element.cloneNode(true);
  ghost.setAttribute('aria-hidden', 'true'); ghost.inert = true; ghost.dataset.exiting = 'true';
  for (const node of [ghost, ...ghost.querySelectorAll('[data-session-id],[id]')]) { node.removeAttribute('data-session-id'); node.removeAttribute('id'); }
  ghost.style.pointerEvents = 'none';
  return ghost;
}
function SessionWindow({ entries, section, renderRow, navigators, rowRefs, animate = false }) {
  const body = useRef(null), pending = useRef(null), viewportHeight = useRef(null), scrollHeight = useRef(0);
  const [stride, setStride] = useState(DEFAULT_CARD_STRIDE), strideRef = useRef(DEFAULT_CARD_STRIDE);
  useLayoutEffect(() => { const next = cardStride(body.current); strideRef.current = next; setStride(next); }, []);
  const [viewport, setViewport] = useState({ top: 0, height: 560 });
  const [retained, setRetained] = useState(() => new Set()), [focusedKey, setFocusedKey] = useState(null);
  const windowed = entries.length > 80;
  // Slots by key; the last element of a removed key is kept until its exit ghost is created.
  const slots = useRef(new Map()), previousKeys = useRef(null), slotRefs = useRef(new Map());
  const slotRef = key => {
    if (!slotRefs.current.has(key)) slotRefs.current.set(key, element => { if (element) slots.current.set(key, element); });
    return slotRefs.current.get(key);
  };
  useLayoutEffect(() => {
    const keys = windowed ? null : entries.map(row => row.key), before = previousKeys.current, container = body.current;
    previousKeys.current = keys;
    const motion = animate && keys && before && container && typeof container.animate === 'function' && !reducedMotion();
    if (motion) {
      const present = new Set(keys), previous = new Set(before), size = strideRef.current;
      before.forEach((key, index) => {
        const element = slots.current.get(key);
        if (present.has(key) || !element || element.isConnected) return;
        // Keep the ghost where the card was: before the next card that stayed, in the old order.
        const next = before.slice(index + 1).find(other => present.has(other)), anchor = next && slots.current.get(next);
        const ghost = exitGhost(element);
        container.insertBefore(ghost, anchor?.parentNode === container ? anchor : null);
        ghost.style.height = '0px';
        animateSlot(ghost, size, 0).finished.then(() => ghost.remove(), () => ghost.remove());
      });
      for (const key of keys) {
        const slot = slots.current.get(key);
        if (previous.has(key) || !slot) continue;
        animateSlot(slot, 0, size).finished.then(() => { slot.style.removeProperty('overflow'); }, () => {});
      }
    }
    const present = new Set(keys || entries.map(row => row.key));
    for (const key of [...slots.current.keys()]) if (!present.has(key)) { slots.current.delete(key); slotRefs.current.delete(key); }
  });
  const retain = useCallback((key, keep) => setRetained(previous => {
    if (previous.has(key) === keep) return previous;
    const next = new Set(previous); if (keep) next.add(key); else next.delete(key); return next;
  }), []);
  const update = useCallback(() => {
    const element = body.current?.parentElement;
    if (!element) return;
    // Observer-backed clients need no height measurement on the scroll path.
    const top = Math.floor(element.scrollTop / strideRef.current), height = viewportHeight.current ?? element.clientHeight;
    setViewport(previous => previous.top === top && (!height || previous.height === height) ? previous : { top, height: height || previous.height });
    // Cached scroll height: set directly on the scroller, so the fade never re-renders cards.
    const more = height > 0 && element.scrollTop + height < scrollHeight.current - 1;
    if (element.dataset.moreBelow !== String(more)) element.dataset.moreBelow = more;
  }, []);
  useEffect(() => {
    const element = body.current?.parentElement;
    if (typeof ResizeObserver === 'function') viewportHeight.current = element.clientHeight || 560;
    scrollHeight.current = element.scrollHeight;
    update();
    element.addEventListener('scroll', update, { passive: true });
    if (typeof ResizeObserver !== 'function') return () => element.removeEventListener('scroll', update);
    const observer = new ResizeObserver(entries => {
      const entry = entries.find(entry => entry.target === element);
      scrollHeight.current = element.scrollHeight;
      // Collapse must not erase the last usable height before reopening/navigation.
      if (entry?.contentRect.height > 0) viewportHeight.current = entry.contentRect.height;
      update();
    }); observer.observe(element); observer.observe(body.current);
    return () => { observer.disconnect(); element.removeEventListener('scroll', update); };
  }, [update]);
  useEffect(() => {
    const reveal = key => {
      const index = entries.findIndex(row => row.key === key), element = body.current?.parentElement;
      if (index < 0 || !element) return;
      pending.current = key;
      const top = element.scrollTop, height = viewportHeight.current ?? element.clientHeight;
      const size = strideRef.current;
      if (index * size < top) element.scrollTop = index * size;
      else if ((index + 1) * size > top + height) element.scrollTop = (index + 1) * size - height;
      setFocusedKey(key); update();
    };
    navigators.current.set(section, reveal);
    return () => navigators.current.delete(section);
  }, [entries, section, navigators, update]);
  useEffect(() => {
    if (!pending.current) return;
    const element = rowRefs.current.get(pending.current);
    if (element) { pending.current = null; element.focus({ preventScroll: true }); }
  });
  const start = Math.max(0, Math.min(viewport.top - 3, entries.length - 1));
  const end = Math.min(entries.length, viewport.top + Math.ceil(viewport.height / stride) + 3);
  const positions = useMemo(() => new Map(entries.map((row, index) => [row.key, index])), [entries]);
  const indexes = windowed ? [...new Set([
    ...Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset),
    ...[...retained, focusedKey].map(key => positions.get(key)).filter(index => index !== undefined)
  ])].sort((a, b) => a - b) : entries.map((_, index) => index);
  return h('div', { ref: body, className: 'sf-window', onScroll: update,
    onFocusCapture: event => { const row = event.target.closest('[data-session-id]'); if (row) setFocusedKey(row.dataset.sessionId); },
    onBlurCapture: event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusedKey(null); },
    style: { position: 'relative', height: windowed ? entries.length * stride : undefined } },
    ...indexes.map(index => h('div', { key: entries[index].key, ref: windowed ? undefined : slotRef(entries[index].key), className: 'sf-slot',
      style: windowed ? { position: 'absolute', top: index * stride, left: 0, right: 0 } : undefined }, renderRow(entries[index], retain))));
}
export function HermesT3Sidebar({ ctx, controller }) {
  const connectionId = useValue(host.state.connectionId), profile = useValue(host.state.profile);
  useValue(host.state.gateway);
  useValue(activationEpoch);
  const epoch = gatewayActivationEpoch();
  const scope = useMemo(() => ({ connectionId, profile: profile || 'default', epoch }), [connectionId, profile, epoch]);
  return h(ScopedSidebar, { key: JSON.stringify(scopeKey(scope)), scope, controller, ctx });
}
export function projectDisplayPath(path, home) {
  if (typeof path !== 'string') return '';
  if (typeof home !== 'string' || !home) return path;
  const root = home.replace(/[/\\]+$/, '');
  if (!root) return path;
  const windows = /^[A-Za-z]:[/\\]/.test(root) || root.startsWith('\\\\');
  const normalize = value => windows ? value.replaceAll('\\', '/').toLowerCase() : value;
  const value = normalize(path), prefix = normalize(root);
  return value === prefix ? '~' : value.startsWith(`${prefix}/`) ? `~${path.slice(root.length)}` : path;
}
function prepareProjectGroups(entries, home) {
  const groups = new Map(), paths = new Map(), text = new Map();
  for (const choice of entries) {
    if (choice.isNoProject || choice.id === '__no_project__' || typeof choice.path !== 'string' || !choice.path) continue;
    const id = choice.projectId || choice.id;
    if (!groups.has(id)) groups.set(id, { id, name: choice.name, choices: [] });
    const group = groups.get(id);
    if (!group.choices.some(item => item.path === choice.path)) group.choices.push(choice);
  }
  const ordered = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).map(group => ({
    ...group, multiple: group.choices.length > 1,
    choices: group.choices.sort((a, b) => a.path.localeCompare(b.path))
  }));
  for (const group of ordered) for (const choice of group.choices) {
    const path = projectDisplayPath(choice.path, home);
    paths.set(choice, path);
    text.set(choice, [group.name, choice.path, path].map(value => value.toLowerCase()));
  }
  return { groups: ordered, paths, text };
}
function filterProjectGroups(prepared, query) {
  const needle = query.trim().toLowerCase();
  return prepared.groups.map(group => ({ ...group,
    choices: group.choices.filter(choice => prepared.text.get(choice).some(value => value.includes(needle)))
  })).filter(group => group.choices.length);
}
export function projectChoiceGroups(entries, query = '', home) {
  return filterProjectGroups(prepareProjectGroups(entries, home), query);
}
export function ProjectPicker({ controller, scope, close, mode = 'new', selected = '*', filterProject }) {
  const [query, setQuery] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true), creationKeys = useRef(new Map());
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const projects = useQuery({ queryKey: [...scopeKey(scope), 'projects'], queryFn: () => controller.projects(scope), retry: false });
  const home = useQuery({ queryKey: [...scopeKey(scope), 'project-home'], queryFn: () => controller.projectHome(scope), retry: false, staleTime: Infinity });
  const filtering = mode === 'filter';
  const select = async project => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      controller.check(scope);
      if (filtering) filterProject(project.path);
      else await controller.newChat(scope, project, creationKeys.current.get(project.id) || (() => { const key = `hermes-t3sidebar:${globalThis.crypto.randomUUID()}`; creationKeys.current.set(project.id, key); return key; })());
      controller.check(scope); if (alive.current) close();
    }
    catch (err) { if (alive.current && sameScope(scope, captureScope())) setError(err.message); }
    finally { if (alive.current) setBusy(false); }
  };
  const entries = projects.data?.projects || EMPTY_ROWS;
  const prepared = useMemo(() => prepareProjectGroups(entries, home.data), [entries, home.data]);
  const groups = useMemo(() => filterProjectGroups(prepared, query), [prepared, query]);
  const choiceProps = { scope, controller, filterProject, close, busy };
  const renderChoice = (choice, pathOnly = false) => h(ProjectChoice, { ...choiceProps, key: choice.id, choice, pathOnly,
    selected: filtering && selected === choice.path, label: `${filtering ? 'Filter by' : 'New session in'} ${choice.name}${pathOnly ? `: ${prepared.paths.get(choice)}` : ''}`,
    displayPath: prepared.paths.get(choice), onSelect: () => void select(choice) });
  return h('div', { className: 'sf-menu sf-project-picker', 'aria-label': filtering ? 'Choose project filter' : 'Choose project for new session' },
    h('strong', null, filtering ? 'Filter by project' : 'New session in…'),
    h('input', { type: 'search', 'aria-label': 'Search projects', placeholder: 'Search projects', value: query, onChange: event => setQuery(event.target.value) }),
    h('div', { className: 'sf-project-options' },
      filtering ? h(sdk.Button, { type: 'button', variant: 'ghost', className: 'sf-project-choice', 'aria-label': 'All projects', 'aria-pressed': selected === '*', disabled: busy,
        onClick: () => { controller.check(scope); filterProject('*'); close(); } }, h('span', { className: 'sf-project-icon', 'aria-hidden': true }, icon('ListFilter', '≡')), h('span', { className: 'sf-project-details' }, h('span', { className: 'sf-project-name' }, 'All projects'))) : null,
      ...groups.map(group => group.multiple ? h('div', { key: group.id, className: 'sf-project-group', role: 'group', 'aria-label': group.name },
        h(ProjectChoice, { ...choiceProps, choice: group.choices[0], heading: true, label: `Project ${group.name}` }),
        ...group.choices.map(choice => renderChoice(choice, true))) : renderChoice(group.choices[0]))),
    projects.isLoading ? h('div', { role: 'status' }, 'Loading projects…') : null,
    projects.isError ? h('div', { role: 'alert' }, projects.error.message, h(sdk.Button, { onClick: () => projects.refetch() }, 'Retry projects')) : null,
    projects.data && !groups.length ? h('div', { role: 'status' }, prepared.groups.length ? 'No matching projects' : 'No projects available') : null,
    busy ? h('div', { role: 'status' }, 'Creating session…') : null,
    error ? h('div', { role: 'alert' }, error) : null);
}
function ProjectChoice({ choice, selected, scope, controller, filterProject, close, busy, label, displayPath, onSelect, heading = false, pathOnly = false }) {
  const [open, setOpen] = useState(false);
  const openMenu = event => { event.preventDefault(); event.stopPropagation(); if (busy) return; controller.check(scope); setOpen(true); };
  return h(sdk.Popover, { open, onOpenChange: setOpen },
    // Declare ownership before Hermes's window-capture fallback intercepts the gesture.
    h(sdk.ContextMenu, null, h(sdk.ContextMenuTrigger, { asChild: true },
      h(sdk.PopoverTrigger, { asChild: true }, h(sdk.Button, { type: 'button', variant: 'ghost', className: `sf-project-choice${heading ? ' sf-project-heading' : pathOnly ? ' sf-project-folder' : ''}`, disabled: busy, 'aria-disabled': heading || undefined, 'aria-label': label, 'aria-pressed': heading ? undefined : selected, title: heading ? undefined : choice.path,
      // Prevent the trigger's normal toggle: left click selects; right click edits.
      onClick: event => { event.preventDefault(); if (!heading) onSelect(); }, onContextMenu: openMenu,
      onKeyDown: event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') openMenu(event); } },
      !pathOnly ? h('span', { className: 'sf-project-icon', 'aria-hidden': true, style: { color: choice.color || undefined } }, projectMark(choice)) : null,
      h('span', { className: 'sf-project-details' }, !pathOnly ? h('span', { className: 'sf-project-name' }, choice.name) : null, !heading ? h('span', { className: 'sf-project-path' }, displayPath) : null))))),
    h(sdk.PopoverContent, { side: 'right', align: 'start', style: PROJECT_MENU_STYLE, 'aria-label': 'Project actions',
      onKeyDown: event => projectMenuKeyDown(event, () => setOpen(false)) }, open ? h(ProjectActions, { row: { project: { ...choice, id: choice.projectId, cwd: choice.path }, cwd: choice.path, _multiplePaths: heading }, scope, controller, filterProject, close }) : null));
}
function ScopedSidebar({ ctx, controller, scope }) {
  const presetTime = useSnoozeTime(ctx);
  const client = useQueryClient(), activeId = useValue(host.state.focusedStoredSessionId), activeOwner = useValue(host.state.focusedSessionOwner);
  const [query, setQuery] = useState(''), [project, setProject] = useState('*'), [filterOpen, setFilterOpen] = useState(false), [pickerOpen, setPickerOpen] = useState(false), [deleteTarget, setDeleteTarget] = useState(null);
  const [collapsed, setCollapsed] = useState(() => readFolds(ctx, scope)), [limit, setLimit] = useState(0), [archiveLimit, setArchiveLimit] = useState(0), [actionError, setActionError] = useState('');
  const [emptyDrafts, setEmptyDrafts] = useState(() => new Set());
  const onDraftPresence = useCallback((id, present) => setEmptyDrafts(previous => {
    if (previous.has(id) === present) return previous;
    const next = new Set(previous); if (present) next.add(id); else next.delete(id); return next;
  }), []);
  const preferenceKey = foldStorageKey(scope);
  useEffect(() => {
    try { ctx.storage.set(preferenceKey, collapsed); } catch (_) { /* Folding still works when persistence is unavailable. */ }
  }, [ctx, preferenceKey, collapsed]);
  const search = useRef(null), rowRefs = useRef(new Map()), navigators = useRef(new Map()), focused = useRef(null), latest = useRef(null), readMarkers = useRef(new Set());
  const key = scopeKey(scope);
  const mutation = useMutation({ mutationFn: async ({ id, payload }) => controller.mutate(scope, id, payload) });
  const opts = { refetchInterval: 5000, staleTime: 2000, retry: false };
  const sessions = useQuery({ ...opts, queryKey: [...key, 'sessions'], queryFn: () => controller.list(scope) });
  // Observe picker data lazily so projects without loaded sessions retain their native filter name/icon.
  const projectCatalog = useQuery({ queryKey: [...key, 'projects'], queryFn: () => controller.projects(scope), enabled: false, retry: false });
  const runtime = useQuery({ ...opts, queryKey: [...key, 'runtime'], queryFn: () => controller.runtime(scope) });
  const metadata = useQuery({ ...opts, queryKey: [...key, 'metadata'], queryFn: () => controller.metadata(scope), enabled: !mutation.isPending });
  const expanded = useQuery({ ...opts, staleTime: Infinity, refetchInterval: false, queryKey: [...key, 'expanded'], enabled: limit > 0, queryFn: () => controller.expanded(scope, limit) });
  const archives = useQuery({ ...opts, queryKey: [...key, 'archives'], queryFn: () => controller.archives(scope, archiveLimit) });
  // Cards animate in and out only once every feed has answered, so the first load and the first runtime/metadata pass
  // (which moves cards between categories) render instantly.
  const loaded = [sessions, runtime, metadata, archives].every(query => query.data !== undefined || query.isError);
  const [settled, setSettled] = useState(false);
  useEffect(() => { if (loaded) setSettled(true); }, [loaded]);
  const previousLimits = useRef({ limit, archiveLimit });
  useEffect(() => {
    // One aggregate per feed avoids retaining a separate overlapping prefix after every expansion. Only its requested page depth changes.
    if (limit > previousLimits.current.limit && previousLimits.current.limit > 0) void expanded.refetch();
    if (archiveLimit > previousLimits.current.archiveLimit) void archives.refetch();
    previousLimits.current = { limit, archiveLimit };
  }, [limit, archiveLimit, expanded.refetch, archives.refetch]);
  const live = runtime.isError ? EMPTY_ROWS : runtime.data?.sessions || EMPTY_ROWS;
  const rich = sessions.data?.sessions || EMPTY_ROWS, extra = sessions.data?.capped ? EMPTY_ROWS : expanded.data?.sessions || EMPTY_ROWS;
  const archivedRows = archives.isError ? EMPTY_ROWS : archives.data?.sessions || EMPTY_ROWS;
  const rows = useMemo(() => mergeRows(rich, extra, live, true, archivedRows), [rich, extra, live, archivedRows]);
  const runtimeKnown = !!runtime.data && !runtime.isError;
  // Successful polls still advance ages and due snoozes when Query structural
  // sharing keeps data references unchanged. Use existing polls, no extra timer.
  const now = useMemo(() => Date.now() / 1000, [sessions.dataUpdatedAt, runtime.dataUpdatedAt, metadata.dataUpdatedAt, archives.dataUpdatedAt]);
  const hasSnoozes = useMemo(() => Object.values(metadata.data?.sessions || EMPTY_STATE.sessions).some(meta => meta.state === 'snoozed'), [metadata.data]);
  // Only snooze eligibility depends on the clock; unchanged ordinary history keeps its classification while displayed ages still advance.
  const classificationNow = hasSnoozes ? now : 0;
  const classified = useMemo(() => buildSections(rows, metadata.data || EMPTY_STATE, live, { runtimeKnown, now: classificationNow }), [rows, metadata.data, live, runtimeKnown, classificationNow]);
  const emptyCandidates = useMemo(() => SECTIONS.flatMap(section => classified[section]).filter(row => row.newSession), [classified]);
  const tokens = useMemo(() => searchTokens(query), [query]);
  // Populate text only for rows actually searched; replacing the classified snapshot also replaces its search index.
  const searchIndex = useMemo(() => new WeakMap(), [classified]);
  const sections = useMemo(() => Object.fromEntries(SECTIONS.map(section => [section,
    classified[section].filter(row => (!row.newSession || emptyDrafts.has(draftIdentity(row)) || ['waiting', 'working'].includes(row.status)) && matchesFilters(row, tokens, project, searchIndex))])), [classified, emptyDrafts, tokens, project, searchIndex]);
  const searching = !!query.trim();
  const isClosed = section => !!collapsed[section] && !(searching && section === 'working');
  // Working and Snoozed fit their content up to two whole cards (at least 18%) before Archived takes the space, never
  // reserving room they cannot fill. Capping at 20% of the shelves keeps every heading visible and Archived dominant in short
  // panes. The track never depends on the card count: content sizing follows cards animating in and out.
  const contentTrack = 'fit-content(max(18%,min(calc(30px + 2 * var(--sf-card-stride)),20%)))';
  const sectionTrack = section => {
    const count = sections[section].length;
    // CSS owns Working's and Snoozed's content fit and body-track fold animation; the parent only bounds them.
    if (section === 'working' || section === 'snoozed') return contentTrack;
    if (isClosed(section)) return 'minmax(30px,0fr)';
    return `minmax(31px,${section === 'archived' && count ? 3 : count ? .65 : .25}fr)`;
  };
  const filtering = searching || project !== '*';
  const hasMatches = SECTIONS.some(section => sections[section].length > 0);
  const visible = useMemo(() => SECTIONS.flatMap(section => !!collapsed[section] && !(searching && section === 'working')
    && !(section === 'active' && sections.active.some(row => row.status === 'waiting' || row.status === 'unknown')) ? [] : sections[section]), [sections, collapsed, searching]);
  const projectChoices = useMemo(() => {
    const choices = new Map();
    for (const row of rows) {
      if (row._limited) continue;
      const cwd = typeof row.cwd === 'string' ? row.cwd : row.project?.is_home ? '' : null;
      if (cwd === null) continue;
      const previous = choices.get(cwd);
      if (!previous || (!previous.nativeName && row.project?.name)) choices.set(cwd, {
        ...row.project, cwd, nativeName: !!row.project?.name, name: row.project?.name || cwd || 'No project'
      });
    }
    return choices;
  }, [rows]);
  const selectedProject = projectCatalog.data?.projects.find(choice => choice.path === project) || projectChoices.get(project) || { name: project || 'No project' };
  const selectProject = useCallback(cwd => { controller.check(scope); setProject(cwd); setFilterOpen(false); }, [controller, scope]);
  latest.current = { rows, sections, visible, metadata: metadata.data, disabled: !metadata.data || metadata.isError || sessions.data?.capped || !archives.data || archives.isError || mutation.isPending };
  useEffect(() => {
    if (!metadata.data || metadata.isError || mutation.isPending || !activeId || activeOwner?.connectionId !== (scope.connectionId ?? 'local') || activeOwner?.profile !== scope.profile) return;
    const row = rows.find(item => aliases(item).includes(activeId));
    const meta = row && metadata.data.sessions[durableId(row)];
    const completion = row && metadata.data.completions?.[durableId(row)];
    if (!row) return;
    const markers = [
      meta?.woke_at > 0 && { label: 'Woke', token: meta.woke_at, ack: () => controller.ackWake(scope, { ...row, meta }) },
      completion?.done_token && { label: 'Done', token: completion.done_token, ack: () => controller.ackDone(scope, { ...row, completion }) }
    ].filter(Boolean);
    // Both acknowledgments use the same writer; serialize them and retry failures on the next poll.
    void (async () => {
      for (const marker of markers) {
        const key = JSON.stringify([durableId(row), marker.label, marker.token]);
        if (readMarkers.current.has(key)) continue;
        readMarkers.current.add(key);
        try { await marker.ack(); }
        catch (error) {
          readMarkers.current.delete(key);
          if (sameScope(scope, captureScope())) setActionError(`Thread opened, but its ${marker.label} marker could not be acknowledged: ${error.message}`);
        }
      }
    })();
  }, [activeId, activeOwner, metadata.data, metadata.dataUpdatedAt, metadata.isError, mutation.isPending, rows, controller, scope]);
  const refresh = () => { try { controller.check(scope); void client.invalidateQueries({ queryKey: key }); } catch (_) { /* old pane */ } };
  const mutate = useCallback(async (row, input) => {
    try {
      controller.check(scope);
      if (latest.current.disabled) throw new Error('hermes-t3sidebar backend unavailable or another change is saving.');
      const { advance, ...payload } = input;
      if (payload.action === 'archive' && row.status !== 'idle') throw new Error('Archive requires confirmed idle status.');
      if (row._liveOnly) throw new Error('This session has no confirmed stored history yet.');
      setActionError('');
      await mutation.mutateAsync({ id: row.key, payload }); controller.check(scope);
      if (advance) {
        const next = [...latest.current.sections.active, ...latest.current.sections.pinned].find(item => item.key !== row.key && latest.current.visible.some(visible => visible.key === item.key));
        if (next) await controller.open(scope, next); else await controller.newChat(scope);
      }
      return true;
    } catch (error) { if (sameScope(scope, captureScope())) setActionError(error.message); return false; }
  }, [controller, scope, mutation.mutateAsync]);
  const navigate = useCallback((event, id) => {
    const keys = latest.current.visible.map(row => row.key), index = keys.indexOf(id);
    let target;
    if (event.key === 'ArrowDown') target = keys[Math.min(keys.length - 1, index + 1)];
    if (event.key === 'ArrowUp') target = keys[Math.max(0, index - 1)];
    if (event.key === 'Home') target = keys[0];
    if (event.key === 'End') target = keys.at(-1);
    if (target) { event.preventDefault(); const row = latest.current.visible.find(row => row.key === target); navigators.current.get(row.section)?.(target); }
  }, []);
  useEffect(() => {
    // Only recover a card's own focus; blur relinquishes ownership to search, menus or the composer.
    if (focused.current && !visible.some(row => row.key === focused.current)) {
      const target = visible[0]; focused.current = target?.key;
      if (target) navigators.current.get(target.section)?.(target.key);
    }
  }, [visible]);
  const focusRow = useCallback(id => { focused.current = id; }, []);
  const rowRef = useCallback((id, element) => { if (element) rowRefs.current.set(id, element); else rowRefs.current.delete(id); }, []);
  const disabled = latest.current.disabled;
  const renderRow = (row, retain) => h(MemoSessionRow, { key: row.key, row, retain, scope, controller, mutate, hidden: isClosed(row.section), filterProject: selectProject, deleteSession: setDeleteTarget, disabled: disabled || row._liveOnly,
    draftPresent: row.newSession && emptyDrafts.has(draftIdentity(row)),
    presetTime, snoozeDetail: row.meta.state === 'snoozed' ? snoozePreciseRemaining(row.meta.wake_at, now) : null,
    active: activeOwner?.connectionId === (scope.connectionId ?? 'local') && activeOwner?.profile === scope.profile && aliases(row).includes(activeId), onFocus: focusRow, onNavigate: navigate, rowRef, age: row.section === 'snoozed' ? snoozeRemaining(row.meta.wake_at, now) : relative(row.activity, now) });
  const renderSection = section => {
    const entries = sections[section], closed = isClosed(section);
    const items = h(SessionWindow, { entries, section, renderRow, navigators, rowRefs, animate: settled });
    const headerless = section === 'active' || section === 'pinned';
    return h('section', { key: section, className: 'sf-section', 'aria-label': LABELS[section], 'data-section': section, 'data-populated': entries.length > 0, 'data-closed': closed },
      !headerless ? h('button', { type: 'button', className: 'sf-section-toggle', 'aria-expanded': !closed, 'aria-label': `${LABELS[section]} (${entries.length})`,
        onClick: () => setCollapsed(previous => ({ ...previous, [section]: !previous[section] })) },
        h('span', { className: 'sf-section-label' }, LABELS[section]), h('span', { className: 'sf-count' }, entries.length),
        h('span', { className: 'sf-section-line', 'aria-hidden': true }),
        h('span', { className: 'sf-section-chevron', 'aria-hidden': true }, icon(closed ? 'ChevronRight' : 'ChevronUp', closed ? '›' : '⌃'))) : null,
      h('div', { className: 'sf-section-body', 'aria-label': `${section === 'active' ? 'Ready' : LABELS[section]} sessions`, 'aria-hidden': closed || undefined, inert: closed || undefined, tabIndex: -1 },
        section === 'archived' && archives.isError ? h('div', { className: 'sf-empty', role: 'alert' }, `Archives unavailable: ${archives.error.message}`) : items, entries.length || section === 'archived' && archives.isError || section === 'pinned' || section === 'working' || section === 'active' && filtering ? null : h('div', { className: 'sf-empty' }, section === 'active' ? 'All caught up' : section === 'archived' && archives.isLoading ? 'Loading archives…' : 'No sessions'),
        section === 'archived' && !archives.isError && archives.data?.has_more ? h(sdk.Button, { variant: 'ghost', size: 'xs', disabled: archives.isFetching, onClick: () => setArchiveLimit(previous => previous + 1) }, 'Browse older archives') : null));

  };
  // Toolbar/popover/error state is not a list input: retain its element tree,
  // not only the cards, so these interactions never walk thousands of rows.
  const renderedSections = useMemo(() => SECTIONS.map(renderSection), [sections, collapsed, searching, filtering, settled, activeId, activeOwner,
    scope, controller, mutate, selectProject, disabled, focusRow, navigate, rowRef, now, presetTime, emptyDrafts,
    archives.isError, archives.error, archives.isLoading, archives.isFetching, archives.data?.has_more]);
  const shelfTracks = `minmax(0,1fr) ${['working', 'snoozed', 'archived'].map(sectionTrack).join(' ')}`;
  const shelvesRef = useRef(null), motionRun = useRef(0), motionKey = useRef(null), shelfMotion = `${shelfTracks}|${isClosed('working')}|${isClosed('snoozed')}`;
  useLayoutEffect(() => {
    const previous = motionKey.current; motionKey.current = shelfMotion;
    const shelves = shelvesRef.current;
    // Initial layout is not a fold; old clients without Web Animations keep plain resizing.
    if (previous === null || previous === shelfMotion || typeof shelves?.getAnimations !== 'function') return;
    const run = ++motionRun.current;
    pinShelfBodies(shelves, run, () => motionRun.current);
  }, [shelfMotion]);
  useEffect(() => () => { motionRun.current++; }, []);
  const total = sessions.data?.total;
  const knownTotal = typeof total === 'number' && Number.isFinite(total) && total >= 0;
  const fallbackCount = knownTotal && total > 500 ? ` is capped at 500 of ${total}`
    : `: ${sessions.data?.sessions.length || 0} loaded${knownTotal ? ` of ${total} available` : ''}`;
  const canExpand = !sessions.data?.capped && (limit === 0 ? sessions.data?.has_more : expanded.data?.has_more);
  return h('aside', { className: 'sf', 'aria-label': 'hermes-t3sidebar', onKeyDown: event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); search.current?.focus(); }
    if (event.key === 'Escape' && event.target === search.current) { setQuery(''); search.current?.blur(); }
  } }, ...emptyCandidates.map(row => h(EmptySessionDraft, { key: draftIdentity(row), row, scope, controller, onPresence: onDraftPresence, refreshAt: runtime.dataUpdatedAt,
    active: activeOwner?.connectionId === (scope.connectionId ?? 'local') && activeOwner?.profile === scope.profile && aliases(row).includes(activeId) })), h('style', null, CSS),
    h('header', { className: 'sf-header' },
      h('div', { className: 'sf-search' }, icon('Search', '⌕'), h('input', { ref: search, type: 'search', placeholder: 'Search', 'aria-label': 'Search sessions', value: query, onChange: event => setQuery(event.target.value) }),
        query ? h(IconButton, { label: 'Clear search', name: 'X', glyph: '×', className: 'sf-clear', onClick: () => { setQuery(''); search.current?.focus(); } }) : null),
      h(sdk.Popover, { open: filterOpen, onOpenChange: setFilterOpen },
        h(sdk.PopoverTrigger, { asChild: true }, h(IconButton, { label: 'Filter sessions', name: 'ListFilter', glyph: '≡', 'data-filtered': project !== '*', title: project === '*' ? 'Filter sessions' : `Filter sessions: ${selectedProject.name}` },
          project !== '*' ? h('span', { className: 'sf-project-icon', 'aria-hidden': true, style: { color: selectedProject.color || undefined } }, projectMark(selectedProject)) : null)),
        h(sdk.PopoverContent, { align: 'end', style: PROJECT_MENU_STYLE, 'aria-label': 'Session filters' }, filterOpen ? h(ProjectPicker, { mode: 'filter', selected: project, controller, scope, filterProject: selectProject, close: () => setFilterOpen(false) }) : null)),

      h(sdk.Popover, { open: pickerOpen, onOpenChange: setPickerOpen },
        h(sdk.PopoverTrigger, { asChild: true }, h(IconButton, { label: 'New session', name: 'SquarePen', glyph: '+' })),
        h(sdk.PopoverContent, { align: 'end', style: PROJECT_MENU_STYLE, 'aria-label': 'New session project' }, pickerOpen ? h(ProjectPicker, { controller, scope, filterProject: selectProject, close: () => setPickerOpen(false) }) : null))),
    sessions.isLoading ? h(Note, null, 'Loading sessions…') : null,
    sessions.isError ? h(Note, { error: true }, `Session list failed: ${sessions.error.message} `, h(sdk.Button, { variant: 'ghost', size: 'xs', onClick: refresh }, 'Retry')) : null,
    !runtimeKnown ? h(Note, { error: runtime.isError }, runtime.isError ? `Runtime status unavailable: ${runtime.error.message}. Native archives remain Archived; other sessions stay accessible in Ready.` : 'Checking runtime status…') : null,
    metadata.isError ? h(Note, { error: true }, `hermes-t3sidebar backend unavailable: ${metadata.error.message}. Read-only browsing; no local metadata fallback. `, h(sdk.Button, { variant: 'ghost', size: 'xs', onClick: refresh }, 'Retry')) : null,
    expanded.isError ? h(Note, { error: true }, `Older sessions could not load: ${expanded.error.message}`) : null,
    actionError ? h(Note, { error: true }, actionError) : null,
    h('div', { className: 'sf-scroll' }, renderedSections[0],
      h('div', { ref: shelvesRef, className: 'sf-shelves', style: { gridTemplateRows: shelfTracks } }, ...renderedSections.slice(1),
        !hasMatches && filtering ? h('div', { className: 'sf-empty' }, 'No matching sessions') : null)),
    sessions.data?.capped ? h(Note, null, `Companion session listing unavailable. Read-only SDK browsing${fallbackCount}; older organized sessions cannot be recovered until the companion returns.`) : null,
    canExpand ? h(Note, null, h(sdk.Button, { variant: 'ghost', size: 'xs', disabled: expanded.isFetching, onClick: () => setLimit(previous => previous + 1) }, 'Browse older sessions')) : null,
    typeof sdk.ConfirmDialog === 'function' ? h(sdk.ConfirmDialog, { open: !!deleteTarget, onClose: () => setDeleteTarget(null),
      title: 'Delete session?', description: `Delete “${deleteTarget ? sessionTitle(deleteTarget) : ''}”? Stored history will be permanently removed. This cannot be undone.`,
      confirmLabel: 'Delete', busyLabel: 'Deleting…', doneLabel: 'Session deleted', destructive: true,
      onConfirm: async () => { controller.check(scope); await controller.delete(scope, deleteTarget); controller.check(scope); } }) : null);
}
export default {
  id: 'hermes-t3sidebar', name: 'hermes-t3sidebar', defaultEnabled: false,
  register(ctx) {
    const controller = createController(ctx);
    ctx.register({ id: 'sidebar', area: 'panes', title: 't3sidebar', order: 0,
      data: { placement: 'left', width: '290px' }, render: () => h(HermesT3Sidebar, { ctx, controller }) });
    ctx.registerSettingsPage({ id: 'settings', title: 'hermes-t3sidebar', icon: 'list-tree', render: () => h(Settings, { ctx }) });
    let disposed = false, pending = null;
    const disposeEvent = ctx.onEvent('*', event => {
      if (disposed) return;
      activationEpoch.set(gatewayActivationEpoch());
      const scope = captureScope();
      if (event.connectionId != null && event.connectionId !== (scope.connectionId ?? 'local')
        || event.profile != null && event.profile !== scope.profile) return;
      const type = event.type || '';
      // Streaming and usage ticks never invalidate history, runtime or drafts.
      if (/\.(delta|text|thinking|usage)$/.test(type)) return;
      const history = /^(message\.complete|gateway\.(ready|connected|reconnected)|sessions\.changed|session\.(title|created|deleted|archived|unarchived|stored|saved|compressed|reset|imported))$/.test(type)
        || type === 'session.updated' && !!event.payload?.operation;
      const runtime = history || /^(session\.|approval\.|question\.|server_request\.)/.test(type)
        || /^(message\.start|subagent\.(start|complete))$/.test(type)
        // A manual compaction marks the session busy without a turn; the backend times it from its first observation.
        || type === 'status.update' && ['compressing', 'compacting'].includes(event.payload?.kind);
      if (!runtime) return;
      if (pending && sameScope(pending.scope, scope)) { pending.history ||= history; return; }
      const work = pending = { scope, history };
      // Coalesce a turn's lifecycle burst without a timer. Query dedupes a
      // still-running read instead of cancelling/restarting it on the next burst.
      void Promise.resolve().then(() => {
        if (disposed || pending !== work) return;
        pending = null;
        if (!sameScope(scope, captureScope())) return;
        const resources = work.history ? ['sessions', 'expanded', 'page', 'archives', 'archive-page', 'metadata', 'runtime'] : ['runtime'];
        return queryClient.invalidateQueries({ queryKey: scopeKey(scope), predicate: query => resources.includes(query.queryKey[4]), refetchType: 'active' }, { cancelRefetch: false });
      }).catch(() => { /* Query retains errors for the pane's normal recovery UI. */ });
    });
    ctx.onDispose(() => { disposed = true; pending = null; controller.dispose(); disposeEvent(); for (const root of ['hermes-t3sidebar', 'hermes-t3sidebar-drafts', 'hermes-t3sidebar-preferences']) { void queryClient.cancelQueries({ queryKey: [root] }); queryClient.removeQueries({ queryKey: [root] }); } });
  }
};
