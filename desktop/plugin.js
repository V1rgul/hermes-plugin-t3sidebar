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
    // Native "starting" means the agent is being built. Opening an old session rebuilds it with no turn, which is not work:
    // only a prompt submitted meanwhile (an in-flight turn with its start) makes it Working. A bare "starting" card stays
    // where it was, without a badge, and is not idle, so archive/delete/move stay refused until the build settles.
    const status = !runtimeKnown ? 'unknown' : matches.some(i => i.status === 'waiting') ? 'waiting'
      : matches.some(i => i.status === 'working' || i.status === 'starting' && i.turn_started_at > 0 || Number.isInteger(i.running_subagents) && i.running_subagents > 0 || i.awaiting_processes === true) ? 'working'
      : matches.some(i => !['idle', 'working', 'starting', 'waiting'].includes(i.status)) ? 'unknown' : matches.some(i => i.status === 'starting') ? 'starting' : 'idle';
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
    // Every shelf puts the most recent first: Working by its turn start (shortest elapsed time on top; activity moves on every
    // message, which made cards jump), falling back to activity when the start is unknown; Snoozed by the nearest wake time;
    // the others by last activity (native history has no archive timestamp).
    const delta = section === 'snoozed' ? a.meta.wake_at - b.meta.wake_at
      : section === 'working' ? (b.runStartedAt ?? b.activity) - (a.runStartedAt ?? a.activity) : b.activity - a.activity;
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
  // Leading zero units are dropped (12h 14min, not 0d 12h 14min); minutes always remain, and inner zeros keep their place.
  const units = [[Math.floor(minutes / 1440), 'd'], [Math.floor(minutes / 60) % 24, 'h'], [minutes % 60, 'min']];
  const first = units.findIndex(([value], index) => value > 0 || index === units.length - 1);
  return `${units.slice(first).map(([value, unit]) => `${value}${unit}`).join(' ')} left`;
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
.sf{interpolate-size:allow-keywords}.sf-shelves{display:flex;flex-direction:column;flex:1;min-height:0;gap:1px}.sf-shelves>.sf-section{flex:1 1 0;transition:flex-grow .22s ease,min-height .22s ease,max-height .22s ease}.sf-shelves>.sf-section[data-section=active]{min-height:min(40%,calc(var(--sf-count) * var(--sf-card-stride)));max-height:max-content;margin-bottom:auto}.sf-shelves>.sf-section:is([data-section=working],[data-section=snoozed],[data-section=archived]){min-height:max(30px,min(calc(30px + min(var(--sf-count),2) * var(--sf-card-stride)),calc(20% - 1px)));max-height:max-content}.sf-shelves>.sf-section[data-section=archived]{max-height:40%;max-height:calc-size(max-content,min(size,40%))}.sf-shelves>.sf-section[data-closed=true]{flex-grow:0;min-height:30px;max-height:30px}
/* Shelves are a flex column: every section starts from zero and takes an equal share (flex-grow), bounded by its min/max heights, so constrained sections end up the same height. The 20% minima give up 1px each for the gaps, so 40% + 3 × 20% fits exactly. Ready takes up to 40% first (its minimum) and absorbs unused space below its cards (auto margin) so headings stay at the bottom. Working and Snoozed keep up to two cards (20% in short panes) and can grow to all their cards; Archived stops at 40%. Folding transitions flex-grow plus min/max-height (interpolate-size makes max-content animatable), so the edge moves from the first frame whether the section is squeezed or fits its cards. */
.sf-section{display:flex;flex-direction:column;min-height:0;overflow:hidden}.sf-section[data-section=pinned]{flex:0 1 auto;max-height:18%}
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
.sf-row .sf-token,.sf-row .sf-provider{color:color-mix(in srgb,var(--ui-base,var(--ui-text-primary)) 30%,transparent)}.sf-row .sf-provider{opacity:.7}
.sf-provider{display:flex;width:14px;height:14px;flex-shrink:0}.sf-provider svg{width:14px;height:14px}.sf-token,.sf-time{flex-shrink:0;white-space:nowrap;font-variant-numeric:tabular-nums}.sf-time{display:inline-flex;align-items:center}.sf-row-title{display:block;width:100%;font-size:14px;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sf-wait{color:var(--ui-accent);flex-shrink:0;display:inline-flex}.sf-pin{display:inline-flex;flex-shrink:0}/* Equal top and right insets; 4px also centres the 25px strip on the 19px metadata line. */
.sf-hover{position:absolute;right:4px;top:4px;height:25px;display:flex;visibility:hidden;align-items:center;gap:2px;background:var(--ui-bg-elevated,var(--ui-bg-quaternary));border-radius:4px}.sf-hover .sf-icon{width:22px;height:25px}.sf-hover .sf-archive{width:auto;gap:4px;white-space:nowrap}.sf-row:hover .sf-hover{visibility:visible}/* The SDK Button's transition-all would keep hidden actions visible for its 100ms: swap instantly. */.sf-hover .sf-icon{transition:none}/* Desktop's buttons draw both hover icons in 12px boxes, where the round alarm (about 9px of ink) reads smaller than the square Archive mark (about 10px). A 15px box with a 1.6 stroke keeps its 1px line and gives about 10.7px of round ink, optically level with Archive. */.sf-hover .sf-icon svg[data-icon^=Alarm]{width:15px;height:15px;flex-shrink:0;stroke-width:1.6}.sf-row:hover .sf-provider,.sf-row:hover .sf-token,.sf-row:hover .sf-time{visibility:hidden}
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
.sf-section[data-pinned=true]>.sf-section-body{flex:none}
.sf-section[data-pinned=true]{mask:linear-gradient(#000,#000) top/100% 30px no-repeat,linear-gradient(to bottom,#000 calc(100% - 18px),transparent)}
.sf-section[data-pinned=true][data-section=active]{mask:linear-gradient(to bottom,#000 calc(100% - 18px),transparent)}
.sf-section[data-closed=true] .sf-section-body{visibility:hidden;transition:visibility 0s .22s}.sf-section-chevron{transition:transform .22s ease}.sf-row{transition:background-color .16s ease,box-shadow .16s ease}.sf-custom-time{display:flex;align-items:center;gap:4px}.sf-custom-time input{min-width:0}.sf-custom-time .sf-icon{flex-shrink:0}
/* Empty-state text waits for leaving cards to collapse instead of appearing under them (visibility only, no fade). */
@keyframes sf-after-exit{from{visibility:hidden}}.sf-empty{animation:sf-after-exit .22s step-end}
@media(prefers-reduced-motion:reduce){.sf-empty{animation:none}.sf-shelves,.sf-shelves>.sf-section,.sf-section-body,.sf-section-chevron,.sf-row{transition:none!important}}
`;
// Monochrome 24x24 provider marks: LobeHub Icons, @lobehub/icons-static-svg 1.95.1 (MIT, Copyright (c) 2023 LobeHub; notice in
// THIRD_PARTY_NOTICES.md), pinned to a release at least 7 days old. Only the marks of Hermes providers are bundled, not the whole
// set. Drawn with the even-odd rule; [d, opacity] keeps a path's own fill-opacity.
const LOBEHUB_PATHS = {
  alibabacloud: ["M14.752 4.64h5.274C22.242 4.64 24 6.475 24 8.691V15.8a3.947 3.947 0 01-3.974 3.975h-5.274l1.299-1.835 3.822-1.222c.688-.23 1.146-.918 1.146-1.605v-5.81c0-.687-.458-1.375-1.146-1.605L16.05 6.475l-1.3-1.835zM2.98 15.111c0 .688.46 1.376 1.147 1.606l3.822 1.146 1.3 1.835H3.974A3.947 3.947 0 010 15.723V8.69c0-2.216 1.758-4.05 3.975-4.05h5.273L7.95 6.474 4.127 7.697c-.688.23-1.146.918-1.146 1.606v5.808z","M16.051 11.213H8.025v1.835h8.026v-1.835z"],
  anthropic: ["M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z"],
  arcee: ["M13.236 2.377L2.751 20.493H0L11.863 0l1.373 2.377zm3.554 6.156l-9.606 11.96H4.13L15.511 6.32l1.279 2.212zm6.908 11.96H14.05l8.406-2.151 1.242 2.15zm-3.42-5.922l-7.843 5.92H8.482l10.597-7.997 1.2 2.077z"],
  azureai: [["M16.233 0c.713 0 1.345.551 1.572 1.329.227.778 1.555 5.59 1.555 5.59v9.562h-4.813L14.645 0h1.588z",0.5],"M23.298 7.47c0-.34-.275-.6-.6-.6h-2.835a3.617 3.617 0 00-3.614 3.615v5.996h3.436a3.617 3.617 0 003.613-3.614V7.47z","M16.233 0a.982.982 0 00-.989.989l-.097 18.198A4.814 4.814 0 0110.334 24H1.6a.597.597 0 01-.567-.794l7-19.981A4.819 4.819 0 0112.57 0h3.679-.016z"],
  bedrock: ["M13.05 15.513h3.08c.214 0 .389.177.389.394v1.82a1.704 1.704 0 011.296 1.661c0 .943-.755 1.708-1.685 1.708-.931 0-1.686-.765-1.686-1.708 0-.807.554-1.484 1.297-1.662v-1.425h-2.69v4.663a.395.395 0 01-.188.338l-2.69 1.641a.385.385 0 01-.405-.002l-4.926-3.086a.395.395 0 01-.185-.336V16.3L2.196 14.87A.395.395 0 012 14.555L2 14.528V9.406c0-.14.073-.27.192-.34l2.465-1.462V4.448c0-.129.062-.249.165-.322l.021-.014L9.77 1.058a.385.385 0 01.407 0l2.69 1.675a.395.395 0 01.185.336V7.6h3.856V5.683a1.704 1.704 0 01-1.296-1.662c0-.943.755-1.708 1.685-1.708.931 0 1.685.765 1.685 1.708 0 .807-.553 1.484-1.296 1.662v2.311a.391.391 0 01-.389.394h-4.245v1.806h6.624a1.69 1.69 0 011.64-1.313c.93 0 1.685.764 1.685 1.707 0 .943-.754 1.708-1.685 1.708a1.69 1.69 0 01-1.64-1.314H13.05v1.937h4.953l.915 1.18a1.66 1.66 0 01.84-.227c.931 0 1.685.764 1.685 1.707 0 .943-.754 1.708-1.685 1.708-.93 0-1.685-.765-1.685-1.708 0-.346.102-.668.276-.937l-.724-.935H13.05v1.806zM9.973 1.856L7.93 3.122V6.09h-.778V3.604L5.435 4.669v2.945l2.11 1.36L9.712 7.61V5.334h.778V7.83c0 .136-.07.263-.184.335L7.963 9.638v2.081l1.422 1.009-.446.646-1.406-.998-1.53 1.005-.423-.66 1.605-1.055v-1.99L5.038 8.29l-2.26 1.34v1.676l1.972-1.189.398.677-2.37 1.429V14.3l2.166 1.258 2.27-1.368.397.677-2.176 1.311V19.3l1.876 1.175 2.365-1.426.398.678-2.017 1.216 1.918 1.201 2.298-1.403v-5.78l-4.758 2.893-.4-.675 5.158-3.136V3.289L9.972 1.856zM16.13 18.47a.913.913 0 00-.908.92c0 .507.406.918.908.918a.913.913 0 00.907-.919.913.913 0 00-.907-.92zm3.63-3.81a.913.913 0 00-.908.92c0 .508.406.92.907.92a.913.913 0 00.908-.92.913.913 0 00-.908-.92zm1.555-4.99a.913.913 0 00-.908.92c0 .507.407.918.908.918a.913.913 0 00.907-.919.913.913 0 00-.907-.92zM17.296 3.1a.913.913 0 00-.907.92c0 .508.406.92.907.92a.913.913 0 00.908-.92.913.913 0 00-.908-.92z"],
  commandcode: ["M19.334 0a4.67 4.67 0 0 0-4.666 4.668v2H9.334v-2A4.67 4.67 0 0 0 4.668 0 4.67 4.67 0 0 0 0 4.668a4.67 4.67 0 0 0 4.668 4.665h2v5.334h-2A4.67 4.67 0 0 0 0 19.334 4.67 4.67 0 0 0 4.668 24a4.67 4.67 0 0 0 4.666-4.666v-2h5.334v2A4.67 4.67 0 0 0 19.334 24 4.67 4.67 0 0 0 24 19.334a4.67 4.67 0 0 0-4.666-4.667h-2V9.333h2A4.67 4.67 0 0 0 24 4.668 4.673 4.673 0 0 0 19.334 0m-2 6.666v-2c0-1.107.893-2 2-2s2 .893 2 2-.893 2-2 2zm-12.668 0c-1.107 0-2-.893-2-2s.893-2 2-2 2 .893 2 2v2zm4.666 8V9.334h5.334v5.334zm10.002 6.667c-1.107 0-2-.893-2-2v-2h2c1.107 0 2 .892 2 2 0 1.107-.893 2-2 2m-14.668 0c-1.107 0-2-.893-2-2 0-1.108.893-2 2-2h2v2c0 1.107-.893 2-2 2"],
  deepinfra: ["M3.294 7.821A2.297 2.297 0 011 5.527a2.297 2.297 0 012.294-2.295A2.297 2.297 0 015.59 5.527 2.297 2.297 0 013.294 7.82zm0-3.688a1.396 1.396 0 000 2.79 1.396 1.396 0 000-2.79zM3.294 14.293A2.297 2.297 0 011 11.998a2.297 2.297 0 012.294-2.294 2.297 2.297 0 012.295 2.294 2.297 2.297 0 01-2.295 2.295zm0-3.688a1.395 1.395 0 000 2.788 1.395 1.395 0 100-2.788zM3.294 20.761A2.297 2.297 0 011 18.467a2.297 2.297 0 012.294-2.295 2.297 2.297 0 012.295 2.295 2.297 2.297 0 01-2.295 2.294zm0-3.688a1.396 1.396 0 000 2.79 1.396 1.396 0 000-2.79zM20.738 7.821a2.297 2.297 0 01-2.295-2.294 2.297 2.297 0 012.294-2.295 2.297 2.297 0 012.295 2.295 2.297 2.297 0 01-2.294 2.294zm0-3.688a1.396 1.396 0 101.395 1.395c0-.77-.626-1.395-1.395-1.395zM20.738 14.293a2.297 2.297 0 01-2.295-2.295 2.297 2.297 0 012.294-2.294 2.297 2.297 0 012.295 2.294 2.297 2.297 0 01-2.294 2.295zm0-3.688c-.769 0-1.395.625-1.395 1.393a1.396 1.396 0 002.79 0c0-.77-.626-1.393-1.395-1.393zM20.738 20.761a2.297 2.297 0 01-2.295-2.294 2.297 2.297 0 012.294-2.295 2.297 2.297 0 012.295 2.295 2.297 2.297 0 01-2.294 2.294zm0-3.688a1.396 1.396 0 101.395 1.395c0-.77-.626-1.395-1.395-1.395zM12.016 11.057a2.297 2.297 0 01-2.294-2.294 2.297 2.297 0 012.294-2.295 2.297 2.297 0 012.295 2.295 2.297 2.297 0 01-2.295 2.294zm0-3.688a1.396 1.396 0 101.395 1.395c0-.77-.625-1.395-1.395-1.395zM12.017 4.589a2.297 2.297 0 01-2.295-2.295A2.297 2.297 0 0112.017 0a2.297 2.297 0 012.294 2.294 2.297 2.297 0 01-2.294 2.295zm0-3.688a1.396 1.396 0 101.395 1.395c0-.77-.626-1.395-1.395-1.395zM12.017 17.529a2.297 2.297 0 01-2.295-2.295 2.297 2.297 0 012.295-2.294 2.297 2.297 0 012.294 2.294 2.297 2.297 0 01-2.294 2.295zm0-3.688a1.396 1.396 0 101.395 1.395c0-.77-.626-1.395-1.395-1.395zM12.016 24a2.297 2.297 0 01-2.294-2.295 2.297 2.297 0 012.294-2.294 2.297 2.297 0 012.295 2.294A2.297 2.297 0 0112.016 24zm0-3.688a1.396 1.396 0 101.395 1.395c0-.77-.625-1.395-1.395-1.395z","M8.363 8.222a.742.742 0 01-.277-.053l-1.494-.596a.75.75 0 11.557-1.392l1.493.595a.75.75 0 01-.278 1.446h-.001zM8.363 14.566a.743.743 0 01-.277-.053l-1.494-.595a.75.75 0 11.557-1.393l1.493.596a.75.75 0 01-.278 1.445h-.001zM17.124 11.397a.741.741 0 01-.277-.054l-1.493-.595a.75.75 0 11.555-1.392l1.493.595a.75.75 0 01-.278 1.446zM17.124 5.05a.744.744 0 01-.277-.054L15.354 4.4a.75.75 0 01.555-1.392l1.493.596a.75.75 0 01-.278 1.445zM17.124 17.739a.743.743 0 01-.277-.053l-1.494-.596a.75.75 0 11.556-1.392l1.493.596a.75.75 0 01-.278 1.445zM6.91 17.966a.75.75 0 01-.279-1.445l1.494-.595a.749.749 0 11.556 1.392l-1.493.595a.743.743 0 01-.277.053H6.91zM6.91 11.66a.75.75 0 01-.279-1.446l1.494-.595a.75.75 0 01.556 1.392l-1.493.595a.743.743 0 01-.277.053H6.91zM6.91 5.033a.75.75 0 01-.279-1.446l1.494-.595a.75.75 0 01.556 1.392l-1.493.596a.744.744 0 01-.277.053H6.91zM8.363 21.364a.743.743 0 01-.277-.053l-1.494-.596a.75.75 0 01.555-1.392l1.494.595a.75.75 0 01-.278 1.446zM15.63 8.223a.75.75 0 01-.278-1.447l1.494-.595a.75.75 0 01.556 1.393l-1.494.595a.744.744 0 01-.276.054h-.002zM15.63 14.567a.75.75 0 01-.278-1.446l1.494-.596a.75.75 0 01.556 1.394l-1.494.595a.743.743 0 01-.276.053h-.002zM15.63 21.363a.749.749 0 01-.278-1.445l1.494-.595a.75.75 0 11.555 1.392l-1.494.595a.741.741 0 01-.277.053z"],
  deepseek: ["M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z"],
  fireworks: ["M14.8 5l-2.801 6.795L9.195 5H7.397l3.072 7.428a1.64 1.64 0 003.038.002L16.598 5H14.8zm1.196 10.352l5.124-5.244-.699-1.669-5.596 5.739a1.664 1.664 0 00-.343 1.807 1.642 1.642 0 001.516 1.012L16 17l8-.02-.699-1.669-7.303.041h-.002zM2.88 10.104l.699-1.669 5.596 5.739c.468.479.603 1.189.343 1.807a1.643 1.643 0 01-1.516 1.012l-8-.018-.002.002.699-1.669 7.303.042-5.122-5.246z"],
  gemini: ["M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"],
  githubcopilot: ["M19.245 5.364c1.322 1.36 1.877 3.216 2.11 5.817.622 0 1.2.135 1.592.654l.73.964c.21.278.323.61.323.955v2.62c0 .339-.173.669-.453.868C20.239 19.602 16.157 21.5 12 21.5c-4.6 0-9.205-2.583-11.547-4.258-.28-.2-.452-.53-.453-.868v-2.62c0-.345.113-.679.321-.956l.73-.963c.392-.517.974-.654 1.593-.654l.029-.297c.25-2.446.81-4.213 2.082-5.52 2.461-2.54 5.71-2.851 7.146-2.864h.198c1.436.013 4.685.323 7.146 2.864zm-7.244 4.328c-.284 0-.613.016-.962.05-.123.447-.305.85-.57 1.108-1.05 1.023-2.316 1.18-2.994 1.18-.638 0-1.306-.13-1.851-.464-.516.165-1.012.403-1.044.996a65.882 65.882 0 00-.063 2.884l-.002.48c-.002.563-.005 1.126-.013 1.69.002.326.204.63.51.765 2.482 1.102 4.83 1.657 6.99 1.657 2.156 0 4.504-.555 6.985-1.657a.854.854 0 00.51-.766c.03-1.682.006-3.372-.076-5.053-.031-.596-.528-.83-1.046-.996-.546.333-1.212.464-1.85.464-.677 0-1.942-.157-2.993-1.18-.266-.258-.447-.661-.57-1.108-.32-.032-.64-.049-.96-.05zm-2.525 4.013c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zm5 0c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zM7.635 5.087c-1.05.102-1.935.438-2.385.906-.975 1.037-.765 3.668-.21 4.224.405.394 1.17.657 1.995.657h.09c.649-.013 1.785-.176 2.73-1.11.435-.41.705-1.433.675-2.47-.03-.834-.27-1.52-.63-1.813-.39-.336-1.275-.482-2.265-.394zm6.465.394c-.36.292-.6.98-.63 1.813-.03 1.037.24 2.06.675 2.47.968.957 2.136 1.104 2.776 1.11h.044c.825 0 1.59-.263 1.995-.657.555-.556.765-3.187-.21-4.224-.45-.468-1.335-.804-2.385-.906-.99-.088-1.875.058-2.265.394zM12 7.615c-.24 0-.525.015-.84.044.03.16.045.336.06.526l-.001.159a2.94 2.94 0 01-.014.25c.225-.022.425-.027.612-.028h.366c.187 0 .387.006.612.028-.015-.146-.015-.277-.015-.409.015-.19.03-.365.06-.526a9.29 9.29 0 00-.84-.044z"],
  huggingface: ["M16.781 3.277c2.997 1.704 4.844 4.851 4.844 8.258 0 .995-.155 1.955-.443 2.857a1.332 1.332 0 011.125.4 1.41 1.41 0 01.2 1.723c.204.165.352.385.428.632l.017.062c.06.222.12.69-.2 1.166.244.37.279.836.093 1.236-.255.57-.893 1.018-2.128 1.5l-.202.078-.131.048c-.478.173-.89.295-1.061.345l-.086.024c-.89.243-1.808.375-2.732.394-1.32 0-2.3-.36-2.923-1.067a9.852 9.852 0 01-3.18.018C9.778 21.647 8.802 22 7.494 22a11.249 11.249 0 01-2.541-.343l-.221-.06-.273-.08a16.574 16.574 0 01-1.175-.405c-1.237-.483-1.875-.93-2.13-1.501-.186-.4-.151-.867.093-1.236a1.42 1.42 0 01-.2-1.166c.069-.273.226-.516.447-.694a1.41 1.41 0 01.2-1.722c.233-.248.557-.391.917-.407l.078-.001a9.385 9.385 0 01-.44-2.85c0-3.407 1.847-6.554 4.844-8.258a9.822 9.822 0 019.687 0zM4.188 14.758c.125.687 2.357 2.35 2.14 2.707-.19.315-.796-.239-.948-.386l-.041-.04-.168-.147c-.561-.479-2.304-1.9-2.74-1.432-.43.46.119.859 1.055 1.42l.784.467.136.083c1.045.643 1.12.84.95 1.113-.188.295-3.07-2.1-3.34-1.083-.27 1.011 2.942 1.304 2.744 2.006-.2.7-2.265-1.324-2.685-.537-.425.79 2.913 1.718 2.94 1.725l.16.04.175.042c1.227.284 3.565.65 4.435-.604.673-.973.64-1.709-.248-2.61l-.057-.057c-.945-.928-1.495-2.288-1.495-2.288l-.017-.058-.025-.072c-.082-.22-.284-.639-.63-.584-.46.073-.798 1.21.12 1.933l.05.038c.977.721-.195 1.21-.573.534l-.058-.104-.143-.25c-.463-.799-1.282-2.111-1.739-2.397-.532-.332-.907-.148-.782.541zm14.842-.541c-.533.335-1.563 2.074-1.94 2.751a.613.613 0 01-.687.302.436.436 0 01-.176-.098.303.303 0 01-.049-.06l-.014-.028-.008-.02-.007-.019-.003-.013-.003-.017a.289.289 0 01-.004-.048c0-.12.071-.266.25-.427.026-.024.054-.047.084-.07l.047-.036c.022-.016.043-.032.063-.049.883-.71.573-1.81.131-1.917l-.031-.006-.056-.004a.368.368 0 00-.062.006l-.028.005-.042.014-.039.017-.028.015-.028.019-.036.027-.023.02c-.173.158-.273.428-.31.542l-.016.054s-.53 1.309-1.439 2.234l-.054.054c-.365.358-.596.69-.702 1.018-.143.437-.066.868.21 1.353.055.097.117.195.187.296.882 1.275 3.282.876 4.494.59l.286-.07.25-.074c.276-.084.736-.233 1.2-.42l.188-.077.065-.028.064-.028.124-.056.081-.038c.529-.252.964-.543.994-.827l.001-.036a.299.299 0 00-.037-.139c-.094-.176-.271-.212-.491-.168l-.045.01c-.044.01-.09.024-.136.04l-.097.035-.054.022c-.559.23-1.238.705-1.607.745h.006a.452.452 0 01-.05.003h-.024l-.024-.003-.023-.005c-.068-.016-.116-.06-.14-.142a.22.22 0 01-.005-.1c.062-.345.958-.595 1.713-.91l.066-.028c.528-.224.97-.483.985-.832v-.04a.47.47 0 00-.016-.098c-.048-.18-.175-.251-.36-.251-.785 0-2.55 1.36-2.92 1.36-.025 0-.048-.007-.058-.024a.6.6 0 01-.046-.088c-.1-.238.068-.462 1.06-1.066l.209-.126c.538-.32 1.01-.588 1.341-.831.29-.212.475-.406.503-.6l.003-.028c.008-.113-.038-.227-.147-.344a.266.266 0 00-.07-.054l-.034-.015-.013-.005a.403.403 0 00-.13-.02c-.162 0-.369.07-.595.18-.637.313-1.431.952-1.826 1.285l-.249.215-.033.033c-.08.078-.288.27-.493.386l-.071.037-.041.019a.535.535 0 01-.122.036h.005a.346.346 0 01-.031.003l.01-.001-.013.001c-.079.005-.145-.021-.19-.095a.113.113 0 01-.014-.065c.027-.465 2.034-1.991 2.152-2.642l.009-.048c.1-.65-.271-.817-.791-.493zM11.938 2.984c-4.798 0-8.688 3.829-8.688 8.55 0 .692.083 1.364.24 2.008l.008-.009c.252-.298.612-.46 1.017-.46.355.008.699.117.993.312.22.14.465.384.715.694.261-.372.69-.598 1.15-.605.852 0 1.367.728 1.562 1.383l.047.105.06.127c.192.396.595 1.139 1.143 1.68 1.06 1.04 1.324 2.115.8 3.266a8.865 8.865 0 002.024-.014c-.505-1.12-.26-2.17.74-3.186l.066-.066c.695-.684 1.157-1.69 1.252-1.912.195-.655.708-1.383 1.56-1.383.46.007.889.233 1.15.605.25-.31.495-.553.718-.694a1.87 1.87 0 01.99-.312c.357 0 .682.126.925.36.14-.61.215-1.245.215-1.898 0-4.722-3.89-8.55-8.687-8.55zm1.857 8.926l.439-.212c.553-.264.89-.383.89.152 0 1.093-.771 3.208-3.155 3.262h-.184c-2.325-.052-3.116-2.06-3.156-3.175l-.001-.087c0-1.107 1.452.586 3.25.586.716 0 1.379-.272 1.917-.526zm4.017-3.143c.45 0 .813.358.813.8 0 .441-.364.8-.813.8a.806.806 0 01-.812-.8c0-.442.364-.8.812-.8zm-11.624 0c.448 0 .812.358.812.8 0 .441-.364.8-.812.8a.806.806 0 01-.813-.8c0-.442.364-.8.813-.8zm7.79-.841c.32-.384.846-.54 1.33-.394.483.146.83.564.878 1.06.048.495-.212.97-.659 1.203-.322.168-.447-.477-.767-.585l.002-.003c-.287-.098-.772.362-.925.079a1.215 1.215 0 01.14-1.36zm-4.323 0c.322.384.377.92.14 1.36-.152.283-.64-.177-.925-.079l.003.003c-.108.036-.194.134-.273.24l-.118.165c-.11.15-.22.262-.377.18a1.226 1.226 0 01-.658-1.204c.048-.495.395-.913.878-1.059a1.262 1.262 0 011.33.394z"],
  kilocode: ["M0 0v24h24V0H0zm22.222 22.222H1.778V1.778h20.444v20.444zm-7.555-4.964h2.222v1.778h-2.794L12.89 17.83v-2.794h1.778v2.222zm4 0h-1.778v-2.222h-2.222v-1.778h2.793l1.207 1.207v2.793zm-7.556-2.591H9.333v-1.778h1.778v1.778zm-5.778-1.778h1.778v4h4v1.778H6.54L5.333 17.46V12.89zm13.334-3.556v1.778h-5.778V9.333h1.987V7.111h-1.987V5.333h2.558l1.206 1.207v2.793h2.014zm-11.556-2h2.222l1.778 1.778v2H9.333v-2H7.111v2H5.333V5.333h1.778v2zm4 0H9.333v-2h1.778v2z"],
  kimi: ["M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z","M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z"],
  lmstudio: [["M2.84 2a1.273 1.273 0 100 2.547h14.107a1.273 1.273 0 100-2.547H2.84zM7.935 5.33a1.273 1.273 0 000 2.548H22.04a1.274 1.274 0 000-2.547H7.935zM3.624 9.935c0-.704.57-1.274 1.274-1.274h14.106a1.274 1.274 0 010 2.547H4.898c-.703 0-1.274-.57-1.274-1.273zM1.273 12.188a1.273 1.273 0 100 2.547H15.38a1.274 1.274 0 000-2.547H1.273zM3.624 16.792c0-.704.57-1.274 1.274-1.274h14.106a1.273 1.273 0 110 2.547H4.898c-.703 0-1.274-.57-1.274-1.273zM13.029 18.849a1.273 1.273 0 100 2.547h9.698a1.273 1.273 0 100-2.547h-9.698z",0.3],"M2.84 2a1.273 1.273 0 100 2.547h10.287a1.274 1.274 0 000-2.547H2.84zM7.935 5.33a1.273 1.273 0 000 2.548H18.22a1.274 1.274 0 000-2.547H7.935zM3.624 9.935c0-.704.57-1.274 1.274-1.274h10.286a1.273 1.273 0 010 2.547H4.898c-.703 0-1.274-.57-1.274-1.273zM1.273 12.188a1.273 1.273 0 100 2.547H11.56a1.274 1.274 0 000-2.547H1.273zM3.624 16.792c0-.704.57-1.274 1.274-1.274h10.286a1.273 1.273 0 110 2.547H4.898c-.703 0-1.274-.57-1.274-1.273zM13.029 18.849a1.273 1.273 0 100 2.547h5.78a1.273 1.273 0 100-2.547h-5.78z"],
  meta: ["M6.897 4c1.915 0 3.516.932 5.43 3.376l.282-.373c.19-.246.383-.484.58-.71l.313-.35C14.588 4.788 15.792 4 17.225 4c1.273 0 2.469.557 3.491 1.516l.218.213c1.73 1.765 2.917 4.71 3.053 8.026l.011.392.002.25c0 1.501-.28 2.759-.818 3.7l-.14.23-.108.153c-.301.42-.664.758-1.086 1.009l-.265.142-.087.04a3.493 3.493 0 01-.302.118 4.117 4.117 0 01-1.33.208c-.524 0-.996-.067-1.438-.215-.614-.204-1.163-.56-1.726-1.116l-.227-.235c-.753-.812-1.534-1.976-2.493-3.586l-1.43-2.41-.544-.895-1.766 3.13-.343.592C7.597 19.156 6.227 20 4.356 20c-1.21 0-2.205-.42-2.936-1.182l-.168-.184c-.484-.573-.837-1.311-1.043-2.189l-.067-.32a8.69 8.69 0 01-.136-1.288L0 14.468c.002-.745.06-1.49.174-2.23l.1-.573c.298-1.53.828-2.958 1.536-4.157l.209-.34c1.177-1.83 2.789-3.053 4.615-3.16L6.897 4zm-.033 2.615l-.201.01c-.83.083-1.606.673-2.252 1.577l-.138.199-.01.018c-.67 1.017-1.185 2.378-1.456 3.845l-.004.022a12.591 12.591 0 00-.207 2.254l.002.188c.004.18.017.36.04.54l.043.291c.092.503.257.908.486 1.208l.117.137c.303.323.698.492 1.17.492 1.1 0 1.796-.676 3.696-3.641l2.175-3.4.454-.701-.139-.198C9.11 7.3 8.084 6.616 6.864 6.616zm10.196-.552l-.176.007c-.635.048-1.223.359-1.82.933l-.196.198c-.439.462-.887 1.064-1.367 1.807l.266.398c.18.274.362.56.55.858l.293.475 1.396 2.335.695 1.114c.583.926 1.03 1.6 1.408 2.082l.213.262c.282.326.529.54.777.673l.102.05c.227.1.457.138.718.138.176.002.35-.023.518-.073.338-.104.61-.32.813-.637l.095-.163.077-.162c.194-.459.29-1.06.29-1.785l-.006-.449c-.08-2.871-.938-5.372-2.2-6.798l-.176-.189c-.67-.683-1.444-1.074-2.27-1.074z"],
  minimax: ["M16.278 2c1.156 0 2.093.927 2.093 2.07v12.501a.74.74 0 00.744.709.74.74 0 00.743-.709V9.099a2.06 2.06 0 012.071-2.049A2.06 2.06 0 0124 9.1v6.561a.649.649 0 01-.652.645.649.649 0 01-.653-.645V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v7.472a2.037 2.037 0 01-2.048 2.026 2.037 2.037 0 01-2.048-2.026v-12.5a.785.785 0 00-.788-.753.785.785 0 00-.789.752l-.001 15.904A2.037 2.037 0 0113.441 22a2.037 2.037 0 01-2.048-2.026V18.04c0-.356.292-.645.652-.645.36 0 .652.289.652.645v1.934c0 .263.142.506.372.638.23.131.514.131.744 0a.734.734 0 00.372-.638V4.07c0-1.143.937-2.07 2.093-2.07zm-5.674 0c1.156 0 2.093.927 2.093 2.07v11.523a.648.648 0 01-.652.645.648.648 0 01-.652-.645V4.07a.785.785 0 00-.789-.78.785.785 0 00-.789.78v14.013a2.06 2.06 0 01-2.07 2.048 2.06 2.06 0 01-2.071-2.048V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v3.8a2.06 2.06 0 01-2.071 2.049A2.06 2.06 0 010 12.9v-1.378c0-.357.292-.646.652-.646.36 0 .653.29.653.646V12.9c0 .418.343.757.766.757s.766-.339.766-.757V9.099a2.06 2.06 0 012.07-2.048 2.06 2.06 0 012.071 2.048v8.984c0 .419.343.758.767.758.423 0 .766-.339.766-.758V4.07c0-1.143.937-2.07 2.093-2.07z"],
  nebius: ["M20 2.306v16.797s4-.242 4-4.815V2.306h-4zM4 22.001V5.204s-4 .242-4 4.816V22h4z","M16.318 16.51L11.286 4.94c-.824-1.872-2.168-2.926-4.077-2.926-1.908 0-3.211 1.54-3.211 3.19 0 0 2.405-.333 3.68 2.593l5.036 11.57c.821 1.87 2.168 2.926 4.075 2.926 1.905 0 3.211-1.541 3.211-3.19 0 0-2.406.333-3.682-2.594z"],
  nousresearch: ["M5.938 12.835c.127-.039.285.02.373.143.028.038.036.092.046.14.003.014-.02.033-.04.05-.124-.098-.24-.194-.354-.291-.011-.01-.016-.027-.025-.042zM8.396 9.412c.195-.032.39-.06.588-.05a.54.54 0 01.148.026c.202.071.402.147.601.224.028.01.05.036.075.055l-.013.027a9.203 9.203 0 01-.26-.089c-.115-.038-.213-.077-.315-.098-.25-.05-.25-.046-.292-.014l.574.144c.275.139.55.276.823.417.042.022.09.057.107.098.026.06.063.076.117.072.066-.006.132-.017.213-.027l-.04.086c.051.08.142.02.216.064-.074.13-.247.09-.334.199l.061.074-.12.087c0 .106-.038.168-.306.243l.026.085-.196.042.07.124h-.25l-.007.137c-.081-.01-.161-.018-.244-.027l-.053.123c-.027-.008-.052-.011-.073-.023-.067-.038-.128-.056-.195.006-.019.017-.063.014-.093.008-.026-.006-.05-.029-.07-.042-.11.095-.11.095-.208.003-.057.046-.12.074-.186.011-.063.027-.123-.02-.178-.014-.07.007-.097-.035-.133-.07l-.13.033c-.013-.236-.194-.19-.34-.203.005-.072.05-.092.095-.094a.474.474 0 01.159.022c.164.05.32.12.496.138.203.021.405.029.601-.015.265-.059.52-.149.707-.365.049-.056.083-.127.117-.195.019-.038.02-.084-.02-.116a1.397 1.397 0 00-.382-.217c.024.12-.031.182-.115.221 0 .014-.004.025 0 .03.08.115.084.16-.007.267a1.39 1.39 0 01-.218.211.477.477 0 01-.641-.05 1.36 1.36 0 01-.133-.152c-.078-.107-.076-.108-.033-.236-.165-.08-.128-.226-.104-.364.008-.05.028-.096.049-.163-.04.014-.067.017-.087.032a.897.897 0 00-.316.357c-.007.016-.01.034-.02.047-.012.015-.034.038-.045.035-.02-.006-.037-.027-.05-.045-.008-.012-.007-.032-.012-.057h-.126l.053-.172a14.82 14.82 0 00-.039-.049l.11-.284c-.06.026-.091.044-.124.051-.03.007-.064 0-.095 0 0-.031-.01-.07.004-.092.149-.22.305-.428.593-.476z","M8.06 10.788c-.003-.038-.004-.075.037-.062.016.006.034.048.028.067-.01.04-.038.032-.064-.005z","M11.981.009c.226-.012.453-.011.679 0 .247.01.495.024.74.062.401.064.798.157 1.19.273.463.138.92.299 1.356.511a7.31 7.31 0 012.948 2.642c.292.469.536.963.739 1.479.219.556.446 1.11.623 1.683.204.654.329 1.326.458 1.997.097.504.182 1.01.29 1.511.156.722.329 1.44.494 2.16.186.812.4 1.615.63 2.415.102.355.193.713.282 1.072.11.436.202.876.254 1.323.031.278.066.557.073.837a7.56 7.56 0 01-.017.88c-.037.413-.1.818-.226 1.212a5.017 5.017 0 01-.915 1.649l-.13.156.018.023c.043-.023.088-.041.127-.068.2-.138.373-.307.531-.49.4-.46.721-.973.975-1.529a3.59 3.59 0 00.325-1.72c-.024-.424-.097-.834-.3-1.213-.013-.027-.015-.06-.03-.121.05.035.082.048.101.072.107.13.22.258.315.398.33.494.46 1.052.486 1.64a3.75 3.75 0 01-.47 1.97c-.36.655-.887 1.14-1.526 1.506-.193.111-.394.21-.595.308-.157.078-.248.211-.318.365a.522.522 0 00-.033.406.359.359 0 01.013.139c-.005.077-.077.155-.14.162-.054.006-.125-.043-.15-.116a1.206 1.206 0 01-.06-.233c-.04-.314-.155-.6-.308-.87a3.906 3.906 0 00-.73-.91 2.129 2.129 0 00-.897-.524 4.093 4.093 0 00-.692-.131c-.075-.008-.15-.04-.22.01.18.06.363.11.538.18.434.173.82.43 1.18.728.308.255.58.543.794.884.098.155.186.315.227.496.027.123.042.25.067.375.013.062-.002.109-.053.144-.047.033-.122.034-.163-.01a.455.455 0 01-.08-.14c-.03-.073-.038-.159-.078-.225a7.314 7.314 0 00-1.423-1.664c-.16-.137-.329-.26-.537-.323-.376-.114-.753-.203-1.15-.154-.213.025-.427.032-.64.053a1.6 1.6 0 00-.736.278 5.14 5.14 0 00-.834.72c-.329.342-.642.699-.955 1.055-.136.155-.264.319-.314.531a5.227 5.227 0 00-.012.051.096.096 0 01-.09.076h-.31c-.046 0-.082-.048-.072-.094.023-.108.045-.216.07-.324.075-.325.19-.635.368-.917.024-.039.04-.088.104-.08l.01.049.027.077c.28-.435.571-.834.996-1.135.283-.204.584-.378.89-.55a.196.196 0 00-.098-.002c-.162.043-.325.084-.485.134-.402.124-.764.33-1.11.566-.147.1-.298.193-.414.333a7.314 7.314 0 00-1.07 1.767.845.845 0 00-.04.12.075.075 0 01-.072.056h-.494c-.04 0-.062-.051-.036-.082.123-.14.246-.282.377-.415.275-.281.58-.532.777-.884.027-.048.063-.09.095-.135.238-.333.54-.607.818-.902.082-.086.175-.16.26-.24.029-.027.053-.057.079-.085l-.018-.025-.135.041c-.034.017-.07.031-.102.05-.248.144-.494.292-.743.433-.408.23-.825.439-1.209.711-.281.2-.591.358-.889.533-.02.012-.044.015-.08.028-.015-.135.143-.201.108-.336-.033.014-.064.02-.085.038-.111.096-.227.19-.328.296-.148.157-.284.325-.425.488-.125.143-.25.286-.373.431A.153.153 0 019.89 24H8.762a.316.316 0 00.016-.042c.028-.09.085-.172.083-.28-.091-.018-.162.001-.212.077a4.45 4.45 0 00-.136.215c-.01.016-.024.03-.042.03h-.093c-.019 0-.029-.022-.017-.037.071-.088.14-.178.209-.268.001-.002-.006-.012-.012-.024-.014.004-.03.006-.045.013-.176.09-.352.181-.527.274a.363.363 0 01-.168.042H5.202c-.026 0-.039-.036-.019-.053.21-.178.402-.374.558-.605.335-.496.538-1.047.667-1.629.004-.02-.003-.043-.006-.091-.037.048-.059.072-.076.1a1.943 1.943 0 01-.334.415c-.28.258-.59.448-.983.464-.297.012-.588 0-.865-.127-.46-.21-.722-.57-.794-1.072-.025-.17-.017-.171-.182-.219A3.513 3.513 0 011.97 20.6a2.286 2.286 0 01-.808-1.13 3.569 3.569 0 01-.16-1.245c.002-.034.016-.067.024-.1.032.023.046.043.05.066.033.153.059.308.096.46.086.355.257.664.516.92.258.256.571.419.91.532.358.118.717.138 1.07-.016a1.89 1.89 0 00.621-.452c.328-.348.533-.76.648-1.223.009-.034.005-.071.007-.11-.015.006-.026.006-.03.011-.031.05-.064.1-.093.152-.284.502-.679.887-1.196 1.135-.351.17-.718.255-1.11.159a1.607 1.607 0 01-.971-.64 2.006 2.006 0 01-.368-.924 2.903 2.903 0 01.02-.886c.05-.439.466-1.17.742-1.271-.02.063-.035.112-.053.16-.043.116-.097.227-.13.345a1.901 1.901 0 00-.05.82c.033.212.09.416.204.6.147.236.346.407.62.465.11.023.225.014.338.018a.576.576 0 00.386-.131c.164-.128.282-.292.366-.481.168-.375.24-.777.309-1.179.05-.296.093-.594.133-.893.039-.281.071-.563.104-.845.026-.232.048-.464.074-.696.024-.228.052-.455.076-.683.024-.227.047-.455.069-.683.013-.14.022-.28.034-.42l.037-.417c.022-.25.041-.5.065-.748.008-.082-.02-.132-.09-.177a2.46 2.46 0 01-.492-.418c-.1-.109-.188-.228-.282-.342-.035-.042-.056-.097-.116-.118a2.084 2.084 0 00.275.597c.06.092.131.176.196.265.063.086.182.115.234.226-.028.003-.046.01-.06.006a4.74 4.74 0 01-.22-.057 2.71 2.71 0 01-1.287-.819c-.435-.487-.656-1.076-.71-1.723a5.206 5.206 0 01.014-1.06c.072-.602.22-1.186.45-1.745.155-.376.338-.741.526-1.102.205-.393.466-.75.765-1.076.512-.559 1.104-1.024 1.726-1.448.717-.49 1.478-.898 2.277-1.233C8.244.828 8.767.632 9.31.494c.655-.166 1.31-.33 1.982-.415.229-.03.458-.058.688-.07zm-1.847 22.82c-.07.06-.147.111-.207.18-.238.27-.464.549-.668.869l-.044.108a.177.177 0 00.093-.057c.174-.19.351-.378.519-.574.104-.122.195-.255.288-.386.024-.034.03-.08.046-.12l-.027-.02zm1.65-3.695a5.51 5.51 0 00-.653.593l-.37.386a.963.963 0 01-.377.25 1.372 1.372 0 01-.467.09c-.044 0-.087.006-.151.012.028.058.043.097.064.131.15.242.301.482.45.724.136.22.276.438.399.666.068.125.105.267.156.404.077.027.14-.018.202-.048.29-.135.579-.274.867-.412.213-.101.437-.186.636-.31.347-.215.68-.455 1.018-.685.015-.01.026-.028.042-.046-.023-.019-.038-.037-.056-.044-.287-.111-.527-.3-.77-.482a5.319 5.319 0 01-.506-.42 1.757 1.757 0 01-.41-.653c-.019-.049-.045-.095-.075-.156zm-5.847.264c-.06.096-.097.194-.132.293a3.38 3.38 0 01-.555 1.01c-.2.25-.455.412-.762.493-.23.06-.464.076-.7.07-.048-.002-.097.002-.158.005.016.04.021.066.035.085.1.145.23.246.4.295.157.046.316.034.498.023.181-.037.343-.115.485-.234.238-.199.402-.454.536-.732.175-.363.264-.751.342-1.144.01-.053.008-.11.011-.164zm14.945-4.586c.008.029.016.057.027.107.024.155.051.31.072.464.03.219.067.437.078.657.017.344.027.689-.014 1.033-.037.315-.063.633-.116.946a6.153 6.153 0 01-.46 1.518c-.008.018-.01.039-.02.082.047-.03.077-.042.098-.064.085-.083.17-.167.248-.255.271-.305.458-.66.596-1.043.18-.498.228-1.011.145-1.531-.103-.65-.33-1.263-.597-1.881a9.055 9.055 0 00-.024-.055l-.033.022zM5.797 8.29a.26.26 0 00.018.153c.124.251.25.501.379.75.025.049.066.09.03.163-.284.06-.578.119-.88.255.059.038.097.06.132.087.042.032.112.058.09.12-.01.033-.075.048-.117.072.017.01.043.021.067.036.166.102.33.207.447.368.138.192.229.404.188.644-.079.469-.306.85-.69 1.132-.054.04-.106.083-.161.122a.243.243 0 00-.103.245.77.77 0 00.055.195c.083.196.22.35.375.492.083.076.159.164.222.257a.37.37 0 01.025.377c-.023.05-.05.099-.076.148-.03.06-.028.111.022.162.041.042.08.089.112.138.038.058.078.079.147.05a.486.486 0 01.333-.006c.16.046.302.126.444.21.13.077.264.149.4.219.067.035.14.05.219.026.071-.022.124.01.145.076.02.064-.003.108-.074.139-.07.03-.137.063-.209.088-.1.035-.201.073-.314.077-.013-.107.11-.088.127-.159-.206-.126-.643-.145-.801-.034.063.112.035.21-.096.313-.13-.1-.025-.202.002-.3a.209.209 0 00-.249.17c-.015.101.067.216.178.224.108.007.218-.005.326-.012.06-.005.12-.027.199 0-.103.123-.248.127-.357.19.002.05.07.086.019.131-.053.048-.095-.001-.132-.03-.08-.063-.16-.126-.231-.197a.474.474 0 01-.157-.311.52.52 0 00-.043-.172c-.032-.074-.032-.137.033-.19-.018-.03-.028-.053-.045-.072a1.222 1.222 0 01-.196-.369c-.053-.137-.046-.264.048-.381.024-.03.05-.06.064-.095a.664.664 0 00.047-.168c.017-.165-.064-.287-.182-.387-.186-.156-.36-.322-.46-.551-.005-.011-.024-.017-.037-.026-.011.017-.024.027-.025.038-.019.185-.045.37-.052.557-.014.377.058.743.162 1.104.118.41.289.798.488 1.173.267.502.537 1.002.812 1.5.055.098.13.189.208.27.198.202.452.272.724.273.202 0 .404-.006.605-.026.295-.03.59-.073.884-.113.183-.025.365-.057.548-.08.21-.026.38.073.522.21.16.156.305.327.447.5.22.265.397.56.554.867.05.098.07.1.147.03.13-.121.26-.242.394-.36.067-.059.088-.12.067-.213a3.535 3.535 0 01-.085-.796c.002-.157.006-.314.018-.471.015-.224.03-.45.06-.672a59.114 59.114 0 01.362-2.298c.087-.493.182-.984.268-1.477.06-.347.118-.694.162-1.043.034-.273.055-.55.063-.825.011-.332.003-.665.002-.998 0-.077.004-.155-.01-.23-.028-.142-.01-.155-.162-.19a5.826 5.826 0 00-.607-.107c-.146-.018-.207-.053-.221-.19-.006-.049-.025-.098-.041-.146-.009-.025-.024-.048-.046-.09l-.025.264c-.009.096-.029.116-.127.115-.055 0-.11-.008-.164-.008-.476 0-.952-.008-1.426.032-.095.008-.173-.015-.226-.103-.04-.066-.088-.126-.134-.186-.063-.084-.086-.093-.182-.06-.195.068-.388.138-.582.21a2.71 2.71 0 00-.675.394.986.986 0 01-.323.168c-.033.01-.07.008-.127.013.02-.066.024-.114.047-.15.064-.105.135-.205.205-.306.023-.033.049-.063.073-.095l-.015-.023-.201.037c-.146.04-.296.07-.437.122-.148.053-.266.023-.386-.072a3.623 3.623 0 01-.733-.786l-.093-.132zm8.592 8.963l-.147.09c-.22.134-.44.266-.659.402-.093.058-.184.12-.27.188-.085.07-.124.161-.072.272.047.1.093.2.147.294.047.08.124.138.213.147.11.01.228.012.336-.012.217-.05.372-.205.528-.357a.291.291 0 00.087-.308c-.046-.18-.079-.365-.118-.547-.011-.052-.027-.103-.045-.169zm-.257-2.409c-.12.291-.205.597-.325.91-.151.433-.294.87-.435 1.323.036-.01.054-.01.067-.018.261-.16.522-.324.785-.484.054-.033.071-.078.065-.138-.012-.13-.024-.262-.034-.393l-.068-.886c-.008-.103-.02-.206-.029-.31-.009 0-.017-.002-.026-.004zm3.081-8.13l.099.285c.08.231.159.463.24.714l.58 1.952c.187.63.372 1.262.558 1.893.114.382.235.762.343 1.146.072.257.126.519.186.799.044.206.087.413.127.64.034.106.023.226.077.325l.025-.006-.068-.362c-.038-.206-.077-.412-.113-.638-.015-.07-.029-.141-.046-.211-.095-.396-.177-.796-.29-1.187-.196-.685-.413-1.364-.618-2.046-.165-.549-.322-1.1-.488-1.648-.069-.227-.15-.45-.226-.695l-.117-.336c-.037-.107-.075-.216-.115-.322-.04-.106-.084-.21-.127-.314a7.558 7.558 0 01-.027.01zM6.225 14.304c-.063-.001-.115.014-.134.083a.35.35 0 00.41.012 4.533 4.533 0 00-.276-.095zM5.23 11.98c-.026-.027-.057-.048-.075.002-.012.032-.007.07-.01.113.082-.037.082-.037.085-.115zm.062-1.189a.135.135 0 00-.088.056.197.197 0 00-.025.11c.005.152.01.306.026.457a.751.751 0 00.066.218c.061.136.157.167.288.101.055-.027.06-.054.025-.11a4.52 4.52 0 01-.129-.211c-.015-.068-.066-.131-.033-.207.04-.09-.076-.116-.074-.19V10.874c-.003-.038-.006-.087-.056-.083zm-.017-.968a.867.867 0 00-.467.127c-.076.045-.084.07-.05.158.034.087.07.173.115.254.064.117.09.125.21.077a.657.657 0 01.336-.053c.202.022.357.136.504.264l.092.077c.007-.006.014-.013.022-.018-.019-.105-.035-.226-.149-.264-.157-.053-.324-.075-.508-.117l-.24-.005c.24-.169.452-.044.687.009-.063-.115-.153-.147-.23-.193-.082-.05-.17-.092-.25-.144-.06-.037-.12-.08-.072-.172zm10.233.325c-.23-.01-.427.08-.608.211-.034.026-.06.065-.105.117.087.026.15.046.232.065.044-.015.088-.03.13-.046.306-.114.61-.115.904.031.126.063.237.04.366-.005-.02-.031-.03-.054-.045-.071a.986.986 0 00-.448-.273c-.14-.044-.284-.024-.426-.03zM7.99 6.483a.308.308 0 00.002.133c.08.321.156.643.242.962.104.387.27.75.456 1.103.02.037.061.08.098.087a.404.404 0 00.253-.051l-.472-.84c-.23-.448-.405-.92-.579-1.394zM10.397.497c-.2-.008-.405.004-.603.034-.236.035-.47.087-.7.152-.287.08-.569.18-.852.273-.04.013-.074.038-.11.058.028.014.05.018.07.014.287-.068.58-.085.873-.09.134-.002.269.009.402.025.19.024.382.048.57.09.456.104.874.3 1.265.556.464.306.888.66 1.257 1.078.205.232.395.475.56.739.17.274.315.561.449.856.273.601.456 1.232.6 1.876.04.173.07.348.1.524.017.104.065.167.17.19.122.028.2.105.22.251-.003.102-.06.174-.129.24a1.065 1.065 0 00-.268.358.164.164 0 00.083-.039c.08-.086.162-.172.235-.265a.56.56 0 00.13-.333c.009-.05.022-.1.024-.15.007-.124-.017-.15-.143-.168-.025-.004-.049-.014-.073-.015-.082-.007-.125-.063-.137-.131-.033-.198-.004-.355.247-.408.086-.018.174-.03.26-.042.158-.023.315-.053.473-.067.14-.012.19.033.226.167.008.029.018.057.021.087.019.179-.008.225-.141.288-.027.013-.055.024-.078.042a.148.148 0 00-.051.067c-.039.144.073.382.206.445l.673.32c.023.011.05.015.075.023l.018-.026c-.015-.008-.032-.013-.044-.024a2.27 2.27 0 00-.544-.32 4.898 4.898 0 00-.173-.075.203.203 0 01-.126-.191c-.003-.085.045-.154.128-.187l.059-.025c.099-.044.118-.076.112-.187a.384.384 0 00-.008-.063c-.067-.294-.123-.59-.205-.88a9.478 9.478 0 00-.826-2.036 7.465 7.465 0 00-1.39-1.805 4.536 4.536 0 00-1.177-.824 3.656 3.656 0 00-1.016-.328 6.155 6.155 0 00-.712-.074zm6.719 5.955c.01.014.018.028.038.034l-.022-.044-.016.01zM4.103 3.917a.062.062 0 01-.03.012.455.455 0 01-.04.039c-.01.01-.02.02-.045.04l-.363.354c-.088.085-.17.178-.266.253-.284.22-.425.53-.544.855a.132.132 0 00-.007.071c.013.055.033.108.052.168l.074.026c-.017.056-.03.105-.047.152-.058.164-.118.327-.175.491-.005.015.008.036.019.077.08-.175.158-.33.225-.489.228-.544.484-1.074.819-1.561.09-.133.182-.266.283-.401.004-.006.007-.013.022-.03.001-.016.003-.032.015-.04l.008-.017zm12.976 2.408a.023.023 0 01.009.019.073.073 0 00-.006.01.188.188 0 00.007.02l.018.022c.002-.007.007-.016.005-.021-.003-.01-.012-.018-.02-.038a1.331 1.331 0 01-.013-.012zM4.199 4.48c-.003.004-.008.008-.027.014-.005.013-.011.025-.031.047a2.085 2.085 0 01-.124.167c-.048.07-.116.055-.181.041-.134-.028-.228.016-.287.143-.089.187-.187.37-.273.56-.049.108-.11.216-.118.36.081.003.154.007.228.008h.228a2.563 2.563 0 01-.079.264c-.01.052-.022.103-.033.155l.02.004c.018-.046.037-.092.067-.153.066-.142.13-.285.2-.426.02-.04.034-.1.116-.092 0 .043.004.084 0 .124-.005.045-.017.09-.028.143.141.043.086.174.115.269.102-.022.104-.195.248-.144v.205l.017.002.439-1.059c-.13 0-.246-.02-.358.033-.024.011-.058-.001-.108-.004.075-.15.139-.278.211-.417a.128.128 0 01.025-.036c0-.015-.001-.03.008-.038l.006-.02c-.005.006-.01.011-.028.017-.004.012-.009.024-.026.045a.085.085 0 01-.032.033c-.123.157-.09.164-.258.106-.079-.027-.078-.028-.047-.144.028-.046.056-.093.098-.15 0-.016-.001-.032.007-.042L4.2 4.48zm2.073-.67c-.003.006-.007.011-.027.016-.094.125-.194.246-.28.377-.155.238-.301.481-.451.723-.14.224-.345.368-.575.481-.017.008-.04.006-.079.011.012-.059.016-.109.033-.153a6.076 6.076 0 01.229-.518l-.007-.02a.138.138 0 01-.035.025c-.028.05-.055.1-.093.164-.26.424-.443.817-.442.95.024.004.048.011.073.013.177.013.188.007.26-.165.03-.07.077-.12.147-.15l.175-.07c.044-.018.085-.057.146-.032.003.05-.01.11.014.145.042.062.044.125.047.193.002.049.017.098.026.147.029-.034.039-.065.05-.097.142-.39.277-.782.428-1.17.1-.256.22-.504.33-.756.013-.03.013-.067.03-.092V3.81zm3.987-.34c0 .045.01.084.021.123.042.16.094.318.124.48.024.133.023.27.028.406 0 .033-.019.067-.032.11-.094-.058-.047-.158-.106-.215h-.125c-.015.072-.01.152-.046.2-.066.085-.155.154-.236.227-.043.038-.078.018-.103-.025l-.046-.087c-.065.035-.117.069-.172.093-.116.051-.235.095-.35.147-.085.038-.09.053-.07.147.014.075.034.148.047.223.013.072.05.109.123.124.233.05.462.115.657.265.058-.102.058-.102.168-.151.03-.014.06-.03.092-.042.08-.03.115-.017.15.06.023.048.041.098.066.158.06-.14-.042-.267.017-.416.157.18.24.39.375.567a.235.235 0 00.022-.098c.002-.124 0-.247.002-.371 0-.034.013-.067.02-.1l.032-.003c.11.155.13.354.226.52a3.036 3.036 0 00-.01-.392c-.004-.045 0-.074.05-.088.08.036.116.14.215.158-.03-.275-.423-1.137-.798-1.635-.114-.127-.2-.28-.34-.386zm-2.667.696c-.019.034-.03.05-.037.067-.061.185-.125.37-.18.556-.031.105-.087.169-.195.19-.09.019-.178.052-.268.073-.038.009-.089.015-.118-.003-.024-.016-.025-.069-.036-.106-.064.076-.082.087-.17.047-.133-.062-.262-.135-.393-.201-.048-.025-.093-.063-.17-.03-.043.12-.091.25-.137.382-.099.28-.087.242.095.453.046.048.102.03.154.023.054-.009.106-.03.16-.036.13-.013.26-.08.367-.015.204-.064.387-.122.571-.178.05-.015.089.005.114.054.022.042.034.093.082.121.038-.056-.013-.128.063-.178l.14.241-.042-1.46zm.278.358c-.096-.01-.107.01-.11.108-.002.038-.003.078.002.115.03.2.099.386.174.57.002.006.012.01.022.015l.078-.05c.052.036.081.088.153.088.205-.002.41.014.616.012.099-.001.158.042.205.12.018.03.024.077.088.066l-.08-.394c-.05-.195-.085-.395-.172-.589-.057.057-.114.068-.18.046a.72.72 0 00-.135-.028c-.22-.028-.44-.059-.66-.08zm10.254-1.727c.089.163.155.316.139.491-.016.168.026.342-.044.516-.047-.033-.088-.082-.112-.075-.117.035-.164-.057-.227-.115a4.772 4.772 0 01-.286-.29l-.104-.113a4.856 4.856 0 01-.023.019c.035.046.07.093.11.156.04.064.084.127.122.193.034.058.065.118.031.205-.082-.01-.164-.019-.246-.032-.06-.01-.101 0-.124.07-.031.098-.037.096-.15.09.02.042.036.08.057.116.041.074.03.138-.03.196-.06.06-.118.122-.178.181a.175.175 0 01-.185.046c-.222-.061-.447-.113-.67-.174-.032-.009-.063-.04-.086-.068-.03-.04-.052-.087-.08-.13-.044-.07-.09-.138-.136-.207a.18.18 0 00-.014.105c.012.127.03.253.035.38.005.1-.024.12-.121.104-.104-.017-.206-.04-.31-.058-.064-.012-.131-.028-.202.03l.081.208c.09 0 .166-.01.237.002a.819.819 0 01.458.251c.078.083.154.168.241.26l.018-.005c-.004-.006-.008-.013-.01-.04.014-.056-.062-.118.018-.178.031.03.064.057.088.09.058.078.111.159.169.257l.089.141.024-.013a2093.819 2093.819 0 01-.427-.934c.055.007.083.007.108.016.193.07.385.142.577.216.074.028.147.06.219.094.062.028.112.018.157-.033.05-.056.102-.112.154-.167.05-.051.095-.046.132.014.016.025.026.053.04.08.071.138.143.277.217.433l.159.308.025-.011c-.044-.106-.07-.218-.138-.334-.057-.182-.168-.346-.206-.545.136.034.362.326.567.732l.057.074.018-.011a1.563 1.563 0 01-.052-.127c-.046-.145-.097-.29-.136-.436-.022-.083-.036-.173.022-.26l.109.058-.026-.207.027-.016c.022.02.05.036.065.06.073.108.143.22.215.33.01.016.029.029.043.043-.036-.217-.2-.38-.229-.626l.155.112c.014-.166.012-.319.042-.465.032-.158-.023-.297-.063-.445.024.004.036.006.055.025.092.124.183.249.277.371.02.027.05.047.069.087l.04.063.019-.015a.293.293 0 01-.053-.082 27.922 27.922 0 01-.332-.49c-.221-.311-.363-.467-.485-.521zm-6.57.327c-.003.161.092.275.069.415l-.368.087c.09.139.032.237-.052.331-.05.057-.092.122-.143.178-.037.04-.046.078-.018.126l.16.275c.029.048.072.066.128.064.076-.003.152 0 .228-.001.116-.003.216.022.275.137.006.014.02.024.044.052.004-.059-.003-.098.01-.13.016-.04.04-.099.072-.108.084-.023.173-.024.26-.03.013-.001.027.018.04.029l.071.065c.019-.11-.082-.198-.024-.31l.126.04c-.026-.123-.07-.245-.071-.366 0-.123.051-.243.115-.36.107.062.16.156.234.253.183.265.36.533.494.834.165-.078.27.068.407.088-.003-.106-.133-.441-.197-.492a.142.142 0 00-.102-.028c-.06.011-.119.039-.191.063-.025-.039-.056-.078-.077-.122a3.936 3.936 0 00-.473-.783c-.076-.094-.16-.182-.228-.26l-.391.285c-.049.035-.094.03-.132-.017l-.169-.207c-.025-.03-.053-.059-.097-.108z"],
  novita: ["M9.167 4.17v5.665L0 19.003h9.167v-5.666l5.666 5.666H24L9.167 4.17z"],
  nvidia: ["M10.212 8.976V7.62c.127-.01.256-.017.388-.021 3.596-.117 5.957 3.184 5.957 3.184s-2.548 3.647-5.282 3.647a3.227 3.227 0 01-1.063-.175v-4.109c1.4.174 1.681.812 2.523 2.258l1.873-1.627a4.905 4.905 0 00-3.67-1.846 6.594 6.594 0 00-.729.044m0-4.476v2.025c.13-.01.259-.019.388-.024 5.002-.174 8.261 4.226 8.261 4.226s-3.743 4.69-7.643 4.69c-.338 0-.675-.031-1.007-.092v1.25c.278.038.558.057.838.057 3.629 0 6.253-1.91 8.794-4.169.421.347 2.146 1.193 2.501 1.564-2.416 2.083-8.048 3.763-11.24 3.763-.308 0-.603-.02-.894-.048V19.5H24v-15H10.21zm0 9.756v1.068c-3.356-.616-4.287-4.21-4.287-4.21a7.173 7.173 0 014.287-2.138v1.172h-.005a3.182 3.182 0 00-2.502 1.178s.615 2.276 2.507 2.931m-5.961-3.3c1.436-1.935 3.604-3.148 5.961-3.336V6.523C5.81 6.887 2 10.723 2 10.723s2.158 6.427 8.21 7.015v-1.166C5.77 16 4.25 10.958 4.25 10.958h-.002z"],
  ollama: ["M7.905 1.09c.216.085.411.225.588.41.295.306.544.744.734 1.263.191.522.315 1.1.362 1.68a5.054 5.054 0 012.049-.636l.051-.004c.87-.07 1.73.087 2.48.474.101.053.2.11.297.17.05-.569.172-1.134.36-1.644.19-.52.439-.957.733-1.264a1.67 1.67 0 01.589-.41c.257-.1.53-.118.796-.042.401.114.745.368 1.016.737.248.337.434.769.561 1.287.23.934.27 2.163.115 3.645l.053.04.026.019c.757.576 1.284 1.397 1.563 2.35.435 1.487.216 3.155-.534 4.088l-.018.021.002.003c.417.762.67 1.567.724 2.4l.002.03c.064 1.065-.2 2.137-.814 3.19l-.007.01.01.024c.472 1.157.62 2.322.438 3.486l-.006.039a.651.651 0 01-.747.536.648.648 0 01-.54-.742c.167-1.033.01-2.069-.48-3.123a.643.643 0 01.04-.617l.004-.006c.604-.924.854-1.83.8-2.72-.046-.779-.325-1.544-.8-2.273a.644.644 0 01.18-.886l.009-.006c.243-.159.467-.565.58-1.12a4.229 4.229 0 00-.095-1.974c-.205-.7-.58-1.284-1.105-1.683-.595-.454-1.383-.673-2.38-.61a.653.653 0 01-.632-.371c-.314-.665-.772-1.141-1.343-1.436a3.288 3.288 0 00-1.772-.332c-1.245.099-2.343.801-2.67 1.686a.652.652 0 01-.61.425c-1.067.002-1.893.252-2.497.703-.522.39-.878.935-1.066 1.588a4.07 4.07 0 00-.068 1.886c.112.558.331 1.02.582 1.269l.008.007c.212.207.257.53.109.785-.36.622-.629 1.549-.673 2.44-.05 1.018.186 1.902.719 2.536l.016.019a.643.643 0 01.095.69c-.576 1.236-.753 2.252-.562 3.052a.652.652 0 01-1.269.298c-.243-1.018-.078-2.184.473-3.498l.014-.035-.008-.012a4.339 4.339 0 01-.598-1.309l-.005-.019a5.764 5.764 0 01-.177-1.785c.044-.91.278-1.842.622-2.59l.012-.026-.002-.002c-.293-.418-.51-.953-.63-1.545l-.005-.024a5.352 5.352 0 01.093-2.49c.262-.915.777-1.701 1.536-2.269.06-.045.123-.09.186-.132-.159-1.493-.119-2.73.112-3.67.127-.518.314-.95.562-1.287.27-.368.614-.622 1.015-.737.266-.076.54-.059.797.042zm4.116 9.09c.936 0 1.8.313 2.446.855.63.527 1.005 1.235 1.005 1.94 0 .888-.406 1.58-1.133 2.022-.62.375-1.451.557-2.403.557-1.009 0-1.871-.259-2.493-.734-.617-.47-.963-1.13-.963-1.845 0-.707.398-1.417 1.056-1.946.668-.537 1.55-.849 2.485-.849zm0 .896a3.07 3.07 0 00-1.916.65c-.461.37-.722.835-.722 1.25 0 .428.21.829.61 1.134.455.347 1.124.548 1.943.548.799 0 1.473-.147 1.932-.426.463-.28.7-.686.7-1.257 0-.423-.246-.89-.683-1.256-.484-.405-1.14-.643-1.864-.643zm.662 1.21l.004.004c.12.151.095.37-.056.49l-.292.23v.446a.375.375 0 01-.376.373.375.375 0 01-.376-.373v-.46l-.271-.218a.347.347 0 01-.052-.49.353.353 0 01.494-.051l.215.172.22-.174a.353.353 0 01.49.051zm-5.04-1.919c.478 0 .867.39.867.871a.87.87 0 01-.868.871.87.87 0 01-.867-.87.87.87 0 01.867-.872zm8.706 0c.48 0 .868.39.868.871a.87.87 0 01-.868.871.87.87 0 01-.867-.87.87.87 0 01.867-.872zM7.44 2.3l-.003.002a.659.659 0 00-.285.238l-.005.006c-.138.189-.258.467-.348.832-.17.692-.216 1.631-.124 2.782.43-.128.899-.208 1.404-.237l.01-.001.019-.034c.046-.082.095-.161.148-.239.123-.771.022-1.692-.253-2.444-.134-.364-.297-.65-.453-.813a.628.628 0 00-.107-.09L7.44 2.3zm9.174.04l-.002.001a.628.628 0 00-.107.09c-.156.163-.32.45-.453.814-.29.794-.387 1.776-.23 2.572l.058.097.008.014h.03a5.184 5.184 0 011.466.212c.086-1.124.038-2.043-.128-2.722-.09-.365-.21-.643-.349-.832l-.004-.006a.659.659 0 00-.285-.239h-.004z"],
  openai: ["M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"],
  opencode: ["M16 6H8v12h8V6zm4 16H4V2h16v20z"],
  openrouter: ["M18.654 3.87a5.087 5.087 0 110 10.174L23.7 19.09c.64.641.187 1.737-.72 1.737H8.48a8.479 8.479 0 010-16.958h10.175zM8.479 7.26a5.087 5.087 0 100 10.176 5.087 5.087 0 000-10.175z"],
  qwen: ["M12.604 1.34c.393.69.784 1.382 1.174 2.075a.18.18 0 00.157.091h5.552c.174 0 .322.11.446.327l1.454 2.57c.19.337.24.478.024.837-.26.43-.513.864-.76 1.3l-.367.658c-.106.196-.223.28-.04.512l2.652 4.637c.172.301.111.494-.043.77-.437.785-.882 1.564-1.335 2.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099 0 00-.081.05 575.097 575.097 0 01-2.705 4.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537 0 01-.465-.271l-1.335-2.323a.09.09 0 00-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543 0 01-.002-.54l1.207-2.12a.198.198 0 000-.197 550.951 550.951 0 01-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625 1.387-2.436.132-.234.304-.334.584-.335a338.3 338.3 0 012.589-.001.124.124 0 00.107-.063l2.806-4.895a.488.488 0 01.422-.246c.524-.001 1.053 0 1.583-.006L11.704 1c.341-.003.724.032.9.34zm-3.432.403a.06.06 0 00-.052.03L6.254 6.788a.157.157 0 01-.135.078H3.253c-.056 0-.07.025-.041.074l5.81 10.156c.025.042.013.062-.034.063l-2.795.015a.218.218 0 00-.2.116l-1.32 2.31c-.044.078-.021.118.068.118l5.716.008c.046 0 .08.02.104.061l1.403 2.454c.046.081.092.082.139 0l5.006-8.76.783-1.382a.055.055 0 01.096 0l1.424 2.53a.122.122 0 00.107.062l2.763-.02a.04.04 0 00.035-.02.041.041 0 000-.04l-2.9-5.086a.108.108 0 010-.113l.293-.507 1.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059 0-.073-.026-.043-.077l1.434-2.505a.107.107 0 000-.114L9.225 1.774a.06.06 0 00-.053-.031zm6.29 8.02c.046 0 .058.02.034.06l-.832 1.465-2.613 4.585a.056.056 0 01-.05.029.058.058 0 01-.05-.029L8.498 9.841c-.02-.034-.01-.052.028-.054l.216-.012 6.722-.012z"],
  stepfun: ["M12 0C5.372 0 0 5.372 0 12s5.372 12 12 12 12-5.372 12-12S18.628 0 12 0zM8.762 19.614H4.376v-4.386h4.386v4.386zm5.423 0H9.798v-4.386h4.387v4.386zm0-5.42H9.798V9.81h4.387v4.386zm0-5.418H9.798V4.39h4.387v4.386zm5.422-.004h-4.386V4.386h4.386v4.386z"],
  tencentcloud: ["M20.0483 17.1416C19.6945 17.4914 18.987 18.0161 17.7488 18.0161C17.2182 18.0161 16.5991 18.0161 16.3338 18.0161C15.98 18.0161 13.3268 18.0161 10.143 18.0161C12.4424 15.8298 14.3881 13.9932 14.565 13.8183C14.7419 13.6434 15.1841 13.2061 15.6263 12.8563C16.5107 12.0692 17.2182 11.9817 17.8373 11.9817C18.7217 11.9817 19.4292 12.3316 20.0483 12.8563C21.2864 13.9932 21.2864 16.0047 20.0483 17.1416ZM21.5518 11.457C20.6674 10.495 19.3408 9.88281 17.9257 9.88281C16.6875 9.88281 15.6263 10.3201 14.6534 11.0197C14.2997 11.3695 13.769 11.7194 13.3268 12.2441C12.9731 12.5939 5.36719 19.9401 5.36719 19.9401C5.80939 20.0276 6.34003 20.0276 6.78223 20.0276C7.22443 20.0276 16.0685 20.0276 16.4222 20.0276C17.1298 20.0276 17.6604 20.0276 18.191 19.9401C19.3408 19.8527 20.4905 19.4154 21.4633 18.5409C23.4975 16.6168 23.4975 13.381 21.5518 11.457Z","M9.1701 10.9323C8.19726 10.2326 7.22442 9.88281 6.07469 9.88281C4.65965 9.88281 3.33304 10.495 2.44864 11.457C0.502952 13.4685 0.502952 16.6168 2.53708 18.6283C3.42148 19.4154 4.30589 19.8527 5.36717 19.9401L7.4013 18.0161C7.04754 18.0161 6.60533 18.0161 6.25157 18.0161C5.10185 17.9287 4.39433 17.5789 3.95212 17.1416C2.71396 15.9172 2.71396 13.9932 3.86368 12.7688C4.48277 12.1566 5.19029 11.8943 6.07469 11.8943C6.60533 11.8943 7.4013 11.9817 8.19726 12.7688C8.55102 13.1186 9.52386 13.8183 9.87763 14.1681H9.96607L11.2927 12.8563V12.7688C10.6736 12.1566 9.70075 11.3695 9.1701 10.9323Z","M18.4564 8.74536C17.4836 6.12171 14.9188 4.28516 12.0003 4.28516C8.5511 4.28516 5.80945 6.82135 5.27881 9.96973C5.54413 9.96973 5.80945 9.88228 6.16321 9.88228C6.51697 9.88228 6.95917 9.96973 7.31294 9.96973C7.75514 7.78336 9.70082 6.20917 12.0003 6.20917C13.946 6.20917 15.6263 7.34608 16.4223 9.00773C16.4223 9.00773 16.5107 9.09518 16.5107 9.00773C17.1298 8.92027 17.8373 8.74536 18.4564 8.74536C18.4564 8.83282 18.4564 8.83282 18.4564 8.74536Z"],
  upstage: ["M19.763 0l-.373 1.297h2.594L22.354 0h-2.591z","M16.192 2.27l-.376 1.298h5.52l.37-1.298h-5.514z","M12.897 4.54l-.377 1.298h8.167l.37-1.297h-8.16z","M2.85 6.81l-.377 1.298h17.565l.37-1.297H2.85z","M3.884 9.081l-.376 1.297H19.39l.37-1.297H3.883z","M4.088 24l.376-1.297H1.866L1.5 24h2.588z","M7.662 21.73l.376-1.298H2.515L2.15 21.73h5.513z","M10.957 19.46l.377-1.298h-8.17l-.367 1.297h8.16z","M21.005 17.19l.376-1.298H3.812l-.366 1.297h17.559z","M19.967 14.919l.376-1.297H4.461l-.366 1.297h15.872z","M18.787 12.649l.376-1.298H4.26l-.366 1.298h14.893z"],
  vercel: ["M12 0l12 20.785H0L12 0z"],
  vertexai: ["M11.995 20.216a1.892 1.892 0 100 3.785 1.892 1.892 0 000-3.785zm0 2.806a.927.927 0 11.927-.914.914.914 0 01-.927.914z","M21.687 14.144c.237.038.452.16.605.344a.978.978 0 01-.18 1.3l-8.24 6.082a1.892 1.892 0 00-1.147-1.508l8.28-6.08a.991.991 0 01.682-.138z","M10.122 21.842l-8.217-6.066a.952.952 0 01-.206-1.287.978.978 0 011.287-.206l8.28 6.08a1.893 1.893 0 00-1.144 1.479z","M4.273 4.475a.978.978 0 01-.965-.965V1.09a.978.978 0 111.943 0v2.42a.978.978 0 01-.978.965zM4.247 13.034a.978.978 0 100-1.956.978.978 0 000 1.956zM4.247 10.19a.978.978 0 100-1.956.978.978 0 000 1.956zM4.247 7.332a.978.978 0 100-1.956.978.978 0 000 1.956z","M19.718 7.307a.978.978 0 01-.965-.979v-2.42a.965.965 0 011.93 0v2.42a.964.964 0 01-.965.979zM19.743 13.047a.978.978 0 100-1.956.978.978 0 000 1.956zM19.743 10.151a.978.978 0 100-1.956.978.978 0 000 1.956zM19.743 2.068a.978.978 0 100-1.956.978.978 0 000 1.956z","M11.995 15.917a.978.978 0 01-.965-.965v-2.459a.978.978 0 011.943 0v2.433a.976.976 0 01-.978.991zM11.995 18.762a.978.978 0 100-1.956.978.978 0 000 1.956zM11.995 10.64a.978.978 0 100-1.956.978.978 0 000 1.956zM11.995 7.783a.978.978 0 100-1.956.978.978 0 000 1.956z","M15.856 10.177a.978.978 0 01-.965-.965v-2.42a.977.977 0 011.702-.763.979.979 0 01.241.763v2.42a.978.978 0 01-.978.965zM15.869 4.913a.978.978 0 100-1.956.978.978 0 000 1.956zM15.869 15.853a.978.978 0 100-1.956.978.978 0 000 1.956zM15.869 12.996a.978.978 0 100-1.956.978.978 0 000 1.956z","M8.121 15.853a.978.978 0 100-1.956.978.978 0 000 1.956zM8.121 7.783a.978.978 0 100-1.956.978.978 0 000 1.956zM8.121 4.913a.978.978 0 100-1.957.978.978 0 000 1.957zM8.134 12.996a.978.978 0 01-.978-.94V9.611a.965.965 0 011.93 0v2.445a.966.966 0 01-.952.94z"],
  xai: ["M6.469 8.776L16.512 23h-4.464L2.005 8.776H6.47zm-.004 7.9l2.233 3.164L6.467 23H2l4.465-6.324zM22 2.582V23h-3.659V7.764L22 2.582zM22 1l-9.952 14.095-2.233-3.163L17.533 1H22z"],
  xiaomimimo: ["M.958 15.936a.459.459 0 01.459.44v2.729a.46.46 0 01-.918 0v-2.729a.459.459 0 01.459-.44zm4.814-2.035a.46.46 0 01.553.45v4.754a.458.458 0 11-.918 0V15.48L3.74 17.202a.462.462 0 01-.655.016.462.462 0 01-.065-.082L.628 14.67a.459.459 0 01.658-.637l2.124 2.187 2.127-2.188a.46.46 0 01.235-.13zm2.068.004a.46.46 0 01.458.445v4.755a.46.46 0 01-.458.458.459.459 0 01-.458-.458V14.35a.459.459 0 01.458-.445zm1.973 2.014a.46.46 0 01.46.457v2.729a.46.46 0 01-.784.324.46.46 0 01-.134-.324v-2.729a.46.46 0 01.458-.458zm.002-2.045a.458.458 0 01.328.157l2.127 2.19 2.125-2.19a.459.459 0 01.784.318v4.756a.46.46 0 01-.455.458.46.46 0 01-.458-.458V15.48l-1.667 1.723a.46.46 0 01-.65.008l-.005-.005c0-.002-.002-.002-.004-.003l-2.455-2.534a.46.46 0 01-.008-.667.461.461 0 01.338-.128zm6.797 1.206a.46.46 0 01.53.651A1.966 1.966 0 0019.81 18.4a.462.462 0 01.623.18.46.46 0 01-.181.624 2.863 2.863 0 01-1.38.353l-.142-.004a2.88 2.88 0 01-2.393-4.263.461.461 0 01.274-.21zm.864-.931a2.884 2.884 0 013.915 3.914.46.46 0 01-.402.24l-.057-.004a.458.458 0 01-.164-.055.46.46 0 01-.182-.622 1.967 1.967 0 00-2.669-2.67.459.459 0 11-.441-.803zM9.59 6.368c1.481 0 1.696 1.202 1.696 1.654v2.648h-.917v-.432c-.26.346-.792.535-1.36.535-.133 0-1.289-.03-1.384-1.136-.082-.932.675-1.61 2.053-1.61h.691c0-.563-.367-.886-.983-.886-.44.013-.864.174-1.2.458l-.36-.664c.484-.379 1.012-.567 1.764-.567zm4.427.1c1.263 0 2.082.97 2.083 2.15 0 1.181-.824 2.154-2.083 2.154-1.26 0-2.084-.972-2.084-2.152 0-1.18.82-2.153 2.084-2.153zm6.801.015c.68 0 1.202.465 1.197 1.548v2.642H21.1V8.29c0-.312-.002-.98-.63-.98s-.628.667-.628.838v2.524h-.89V8.148c0-.17-.001-.838-.63-.838-.628 0-.628.668-.628.98v2.383h-.917v-4.03h.917V7a1.22 1.22 0 01.947-.516c.398 0 .76.193.982.686a1.321 1.321 0 011.195-.686zm-18.093.872l1.457-1.772H5.32L3.311 8.07l2.14 2.602H4.24L2.725 8.796 1.21 10.672H0L2.138 8.07.13 5.583h1.138l1.458 1.772zm4.149 3.317h-.916V6.644h.916v4.028zm16.99 0h-.916V6.644h.916v4.028zM9.925 8.71c-1.055 0-1.359.412-1.326.742.032.329.324.537.757.537a1.013 1.013 0 001.014-.968l.002-.31h-.447zM14.018 7.3c-.663 0-1.184.487-1.184 1.32 0 .832.52 1.32 1.184 1.32.662 0 1.182-.49 1.182-1.32 0-.832-.52-1.32-1.182-1.32zM6.417 5.001a.568.568 0 01.587.582.588.588 0 01-1.175 0A.57.57 0 016.417 5zm16.991 0a.57.57 0 01.592.582.588.588 0 01-1.174 0 .57.57 0 01.357-.542.572.572 0 01.225-.04z"],
  zai: ["M12.105 2L9.927 4.953H.653L2.83 2h9.276zM23.254 19.048L21.078 22h-9.242l2.174-2.952h9.244zM24 2L9.264 22H0L14.736 2H24z"],
};
// Hermes provider ids and their registry aliases (hermes_cli.auth.PROVIDER_REGISTRY) mapped to a mark. Actual Computer, GMI Cloud,
// Ramp Router and Solstice have no published mark and show none.
const PROVIDER_MARKS = {"ai-gateway": 'vercel', alibaba: 'qwen', "alibaba-cloud-cn": 'alibabacloud', "alibaba-cn": 'alibabacloud', "alibaba-coding-cn": 'alibabacloud', "alibaba-coding-plan": 'alibabacloud', "alibaba-coding-plan-cn": 'alibabacloud', "alibaba-token-plan": 'alibabacloud', "alibaba-token-plan-cn": 'alibabacloud', "azure-foundry": 'azureai', "claude-subscription-directsdk-experimental": 'anthropic', "commandcode-anthropic": 'commandcode', "commandcode-chat": 'commandcode', "commandcode-claude": 'commandcode', copilot: 'githubcopilot', "copilot-acp": 'githubcopilot', "dashscope-cn": 'alibabacloud', "dashscope-coding-cn": 'alibabacloud', "dashscope-token-plan": 'alibabacloud', "dashscope-token-plan-cn": 'alibabacloud', "deep-infra": 'deepinfra', "deepinfra-ai": 'deepinfra', "fireworks-ai": 'fireworks', fw: 'fireworks', google: 'gemini', "kimi-coding": 'kimi', "kimi-coding-cn": 'kimi', "meta-ai": 'meta', "minimax-cn": 'minimax', "minimax-oauth": 'minimax', "model-api": 'meta', msl: 'meta', muse: 'meta', "muse-spark": 'meta', "nebius-tf": 'nebius', "nebius-token-factory": 'nebius', "nebius-tokenfactory": 'nebius', nous: 'nousresearch', "novita-ai": 'novita', novitaai: 'novita', "ollama-cloud": 'ollama', "openai-api": 'openai', "openai-codex": 'openai', "opencode-go": 'opencode', "opencode-zen": 'opencode', "qwen-oauth": 'qwen', solar: 'upstage', "tencent-tokenhub": 'tencentcloud', "tencent-tokenplan": 'tencentcloud', "token-factory": 'nebius', tokenfactory: 'nebius', vertex: 'vertexai', "xai-oauth": 'xai', xiaomi: 'xiaomimimo'};
function providerMark(provider) {
  const slug = typeof provider === 'string' ? provider.toLowerCase() : '';
  const own = (table, key) => Object.hasOwn(table, key) ? table[key] : undefined;
  const paths = own(LOBEHUB_PATHS, own(PROVIDER_MARKS, slug) || slug);
  if (!Array.isArray(paths)) return null;
  return h('svg', { viewBox: '0 0 24 24', fill: 'currentColor', fillRule: 'evenodd', 'aria-hidden': true, 'data-provider-mark': slug },
    ...paths.map((path, index) => Array.isArray(path) ? h('path', { key: index, d: path[0], fillOpacity: path[1] }) : h('path', { key: index, d: path })));
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
// Tabler v3.44.0 (MIT), the Desktop SDK's own icon family; its export surface omits these alarm and folder glyphs.
const BUNDLED_ICONS = {
  FolderCog: ['M12.5 19h-7.5a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v3', 'M17.001 19a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M19.001 15.5v1.5', 'M19.001 21v1.5', 'M22.032 17.25l-1.299 .75', 'M17.27 20l-1.3 .75', 'M15.97 17.25l1.3 .75', 'M20.733 20l1.3 .75'],
  FolderSymlink: ['M3 21v-4a3 3 0 0 1 3 -3h5', 'M8 17l3 -3l-3 -3', 'M3 11v-5a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8'],
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
        renaming ? h('form', { onSubmit: event => { event.preventDefault(); void perform(() => controller.rename(scope, row, title)); } },
          h('span', { className: 'sf-custom-time' },
          h('input', { type: 'text', value: title, autoFocus: true, 'aria-label': 'Session title', disabled: busy, onChange: event => setTitle(event.target.value), onKeyDown: event => { if (event.key === 'Escape') { event.stopPropagation(); setRenaming(false); } } }),
          h(IconButton, { type: 'submit', label: 'Save rename', name: 'Check', glyph: '✓', disabled: busy || !title.trim() }))) : null,
        h(MenuAction, { name: 'Copy', disabled: busy, onClick: () => void perform(() => controller.copyId(scope, row)) }, 'Copy session ID'),
        h(MenuAction, { name: 'Trash2', destructive: true, disabled: disabled || busy || row.status !== 'idle' || row._liveOnly || typeof sdk.ConfirmDialog !== 'function', onClick: () => { controller.check(scope); deleteSession(row); close(); } }, 'Delete session'),
        row._liveOnly ? h('p', null, 'Unsaved sessions must be closed through the native session controls.') : null,
        h(sdk.Popover, { open: moveOpen, onOpenChange: setMoveOpen },
          h(sdk.PopoverTrigger, { asChild: true }, h(MenuAction, { name: 'FolderSymlink', 'aria-label': 'Move to project', disabled: disabled || busy || row.status !== 'idle' || row._liveOnly,
            onKeyDown: event => { if (event.key === 'ArrowRight') { event.preventDefault(); setMoveOpen(true); } } }, 'Move to project', h('span', { className: 'sf-submenu-arrow', 'aria-hidden': true }, icon('ChevronRight', '›')))),
          h(sdk.PopoverContent, { side: 'right', align: 'start', style: PROJECT_MENU_STYLE, 'aria-label': 'Move to project',
            onKeyDown: event => projectMenuKeyDown(event, () => setMoveOpen(false)) }, h(MoveProjectActions, { row, scope, controller, close }))),
        h(sdk.Popover, { open: projectOpen, onOpenChange: setProjectOpen },
          h(sdk.PopoverTrigger, { asChild: true }, h(MenuAction, { name: 'FolderCog', 'aria-label': 'Project', disabled: busy, onKeyDown: event => { if (event.key === 'ArrowRight') { event.preventDefault(); setProjectOpen(true); } } }, 'Project', h('span', { className: 'sf-submenu-arrow', 'aria-hidden': true }, icon('ChevronRight', '›')))),
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
  // The pinned height is set on the body itself: an inherited custom property on the section would restyle every card.
  const release = () => { for (const section of sections) { section.querySelector(':scope > .sf-section-body')?.style.removeProperty('height'); delete section.dataset.pinned; } };
  release();
  const transitions = [shelves, ...sections].flatMap(element => element.getAnimations())
    .filter(animation => ['flex-grow', 'min-height', 'max-height'].includes(animation.transitionProperty));
  if (!transitions.length) return;
  const bodies = sections.map(section => section.querySelector(':scope > .sf-section-body'));
  const heights = () => bodies.map(body => body ? body.getBoundingClientRect().height : 0);
  const start = heights(), times = transitions.map(animation => animation.currentTime);
  for (const animation of transitions) animation.currentTime = animation.effect.getComputedTiming().endTime;
  const end = heights();
  transitions.forEach((animation, index) => { animation.currentTime = times[index]; });
  sections.forEach((section, index) => {
    const pin = Math.max(start[index], end[index]);
    if (pin > 0 && bodies[index]) { bodies[index].style.height = `${pin}px`; section.dataset.pinned = 'true'; }
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
    return h('section', { key: section, className: 'sf-section', 'aria-label': LABELS[section], 'data-section': section, 'data-populated': entries.length > 0, 'data-closed': closed, style: { '--sf-count': entries.length } },
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
  // CSS flex owns every shelf height (see the stylesheet). A pure JavaScript allocator was also built and profiled: pixel heights
  // computed from card counts, exact Ready-first priority even in short panes, and Working/Snoozed capped at 40%. Once fold
  // pinning stopped restyling every card, both cost about the same per frame; flex is far less code and follows real content,
  // so it ships first and the allocator stays the fallback if flex's approximations (short panes) prove insufficient.
  // Only folds pin the scrolling bodies: card enter/exit motion may resize them.
  const shelvesRef = useRef(null), motionRun = useRef(0), foldKey = useRef(null), folds = SECTIONS.map(isClosed).join();
  useLayoutEffect(() => {
    const previous = foldKey.current; foldKey.current = folds;
    const shelves = shelvesRef.current;
    // Initial layout is not a fold; old clients without Web Animations keep plain resizing.
    if (previous === null || previous === folds || typeof shelves?.getAnimations !== 'function') return;
    const run = ++motionRun.current;
    pinShelfBodies(shelves, run, () => motionRun.current);
  }, [folds]);
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
      h('div', { ref: shelvesRef, className: 'sf-shelves' }, ...renderedSections.slice(1),
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
