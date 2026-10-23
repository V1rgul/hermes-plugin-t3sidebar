// hermes-t3sidebar — independent T3-inspired session browser; plain disk-plugin ESM.
import * as sdk from '@hermes/plugin-sdk';
import { createElement as h, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

const { host, useValue, useQuery, useMutation, useQueryClient, queryClient, gatewayActivationEpoch } = sdk;
export const SECTIONS = ['pinned', 'active', 'working', 'snoozed', 'archived'];
const LABELS = { active: 'Ready', pinned: 'Pinned', working: 'Working', snoozed: 'Snoozed', archived: 'Archived' };
const EMPTY_STATE = { version: 1, sessions: {} };
const EMPTY_ROWS = [];
const DEFAULT_META = { state: 'active', pinned: false };
const tokenFormatter = Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const shortDateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });
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
  return value;
}
export const visibleSource = row => !['cron', 'tool', 'oneshot', 'kanban'].includes(String(row.source || '').toLowerCase());
export function compactTokens(row) {
  const valid = value => Number.isFinite(value) && value >= 0;
  const total = valid(row.total_tokens) ? row.total_tokens : valid(row.input_tokens) && valid(row.output_tokens) ? row.input_tokens + row.output_tokens : null;
  return total === null ? '—' : tokenFormatter.format(total);
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
function matchesFilters(row, query, project) {
  if (project !== '*' && (row._limited || (row.cwd || '') !== project)) return false;
  if (!query) return true;
  const text = [sessionTitle(row), row.preview, row.cwd, row.git_branch, ...aliases(row)].filter(Boolean).join(' ').toLowerCase();
  return query.trim().toLowerCase().split(/\s+/).every(token => text.includes(token));
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
  const known = new Set([...rows.values()].flatMap(aliases));
  for (const item of live) {
    if (!visibleSource(item) || !item.session_key || known.has(item.session_key)) continue;
    const row = { ...item, id: item.session_key, _limited: true, _liveOnly: true };
    rows.set(row.id, row); known.add(row.id);
  }
  return [...rows.values()];
}
export function buildSections(rows, metadata, live, { now = Date.now() / 1000, runtimeKnown = true, query = '', project = '*' } = {}) {
  const result = Object.fromEntries(SECTIONS.map(section => [section, []]));
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
      : matches.some(i => i.status === 'working' || i.status === 'starting' || Number.isInteger(i.running_subagents) && i.running_subagents > 0) ? 'working'
      : matches.some(i => !['idle', 'working', 'starting', 'waiting'].includes(i.status)) ? 'unknown' : 'idle';
    const woke = Number.isFinite(meta.woke_at) && meta.woke_at > 0 || meta.state === 'snoozed' && meta.wake_at <= now;
    const section = status === 'waiting' ? 'active'
      : row.archived === true ? 'archived'
      : status === 'unknown' ? 'active'
      : meta.state === 'snoozed' && !woke ? 'snoozed'
      : meta.pinned ? 'pinned'
      : status === 'working' ? 'working' : 'active';
    const newSession = isEmptySession(row, runtimeKnown ? matches : []);
    if (!matchesFilters({ ...row, newSession }, query, project)) continue;
    // Runtime last_active is also a resume/reattach clock, not conversation progress.
    const activity = seconds(row.last_active || row.updated_at || row.started_at || row.created_at);
    const runtimes = matches.filter(item => typeof item.id === 'string' && item.id && item.id !== item.session_key);
    result[section].push({ ...row, key: durableId(row), meta, completion: metadata.completions?.[durableId(row)] || null, section, status, woke, newSession,
      runtimeId: runtimes.length === 1 ? runtimes[0].id : null, activity });
  }
  for (const section of SECTIONS) result[section].sort((a, b) => {
    if (section === 'active' && (a.status === 'waiting') !== (b.status === 'waiting')) return a.status === 'waiting' ? -1 : 1;
    // Native history has no archive timestamp; archives are ordered by last activity.
    const delta = section === 'snoozed' ? a.meta.wake_at - b.meta.wake_at : b.activity - a.activity;
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
  let pendingRoutes = null;
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
  function updateRows(scope, ids, patch, archived) {
    check(scope);
    if (typeof client.getQueriesData !== 'function') return; // Minimal cache adapters may have no loaded lists.
    const matches = row => aliases(row).some(id => ids.has(id)) || ids.has(row.session_key);
    const queries = client.getQueriesData({ queryKey: scopeKey(scope) })
      .filter(([key, data]) => ['sessions', 'expanded', 'archives', 'page', 'runtime'].includes(key[4]) && Array.isArray(data?.sessions));
    // Transfer only an already-loaded native row, never manufacture a rich row
    // from a runtime or metadata record. Preserve project/history richness.
    const known = queries.filter(([key]) => key[4] !== 'runtime').flatMap(([, data]) => data.sessions).find(matches);
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
    dispose() { disposed = true; generation++; pendingRoutes = null; deleteRequests.clear(); doneAcks.clear(); }, check,
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
        const value = qualified(await fenced(scope, () => ctx.rest(`/archives?offset=${page * 500}&limit=500`)), scope, route);
        readTicket(scope, ticket);
        if (typeof value.has_more !== 'boolean' || value.sessions.some(row => row.archived !== true)) throw new Error('Invalid native archive listing response.');
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
        const value = await fenced(scope, () => client.fetchQuery({ queryKey: [...scopeKey(scope), 'page', offset], staleTime: Infinity,
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
        await fenced(scope, () => ctx.rest(`/sessions/${encodeURIComponent(id)}`, { method: 'POST', body: payload }));
        const value = verifyAction(validState(await fenced(scope, () => ctx.rest('/state'))), id, payload);
        await client.cancelQueries({ queryKey: key, exact: true }); check(scope);
        client.setQueryData(key, value);
        return value;
      } finally {
        writing = false;
        if (!disposed && sameScope(scope, env.capture())) {
          if (native) client.removeQueries({ predicate: query => sameScope({ connectionId: query.queryKey[1], profile: query.queryKey[2], epoch: query.queryKey[3] }, scope) && query.queryKey[0] === 'hermes-t3sidebar' && query.queryKey[4] === 'page' });
          refresh(scope, { queryKey: native ? scopeKey(scope) : key, exact: !native });
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
            payload = { session_id: id, request_id: globalThis.crypto.randomUUID(), expected_revision: before.runtime_revision,
              expected_generation: before.runtime_generation, operation: 'delete', payload: {} };
            deleteRequests.set(requestKey, payload);
          }
        }
        let deletedIds = [id];
        if (payload) {
          // Retain the exact request/fences after an ambiguous failure; never repeat
          // an irreversible mutation under a fresh identity merely because it timed out.
          const result = await fenced(scope, () => env.host.requestProfile(route, 'session.mutate', payload));
          if (result?.session_id !== id || result.operation !== 'delete' || result.revision !== payload.expected_revision + 1 ||
            result.execution_generation !== payload.expected_generation || !Array.isArray(result.deleted_ids) || !result.deleted_ids.includes(id) ||
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
      writing = true; generation++;
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
          await rpc('projects.update', { id, ...payload });
        } else {
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
          if (!['sessions', 'expanded', 'archives', 'page'].includes(key[4]) || !Array.isArray(data?.sessions)) continue;
          client.setQueryData(key, { ...data, sessions: data.sessions.map(row => row.project?.id === project.id || row.project?.id === id
            ? { ...row, project: { ...row.project, id, name: saved.name, icon: saved.icon, color: saved.color } } : row) });
        }
        return saved;
      } finally {
        writing = false;
        if (!disposed && sameScope(scope, env.capture())) {
          client.removeQueries({ queryKey: [...scopeKey(scope), 'page'] });
          refresh(scope, { queryKey: scopeKey(scope) });
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
      const route = await routeFor(scope);
      const value = await fenced(scope, () => env.host.requestProfile(route, 'projects.tree', { preview_limit: 0 }));
      if (!Array.isArray(value?.projects)) throw new Error('Invalid native project tree.');
      const home = { id: '__no_project__', name: 'Home', path: null, isNoProject: true };
      const projects = value.projects.filter(p => p.id !== home.id && !p.isNoProject).flatMap(p => {
        const paths = [...new Set([p.path, ...(p.repos || []).map(repo => repo.path)].filter(path => typeof path === 'string' && path))];
        return paths.map(path => ({ id: `${p.id}:${path}`, name: `${p.label || p.name || p.id}${paths.length > 1 ? ` · ${path}` : ''}`, path, icon: p.icon || null, color: p.color || null, isNoProject: false }));
      });
      return { projects: [home, ...projects] };
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
.sf{display:flex;flex-direction:column;height:100%;min-height:0;min-width:220px;font:12px/1.4 var(--font-sans,inherit);color:var(--ui-text-primary)}
.sf *{box-sizing:border-box}.sf button,.sf input,.sf select{font:inherit}.sf button{cursor:pointer}.sf button:disabled{cursor:default;opacity:.4}
.sf button:focus-visible,.sf input:focus-visible,.sf select:focus-visible{outline:2px solid var(--ui-accent);outline-offset:-2px}
.sf-header{padding:6px 12px;display:flex;align-items:center;gap:5px;height:40px;flex-shrink:0}.sf-icon{display:inline-flex;flex-shrink:0;align-items:center;justify-content:center;width:27px;height:27px;padding:4px;border:0;border-radius:4px;color:var(--ui-text-tertiary);background:transparent}
.sf-icon:hover,.sf-icon[aria-expanded=true],.sf-row:hover,.sf-row:focus-within,.sf-row[data-menu-open=true],.sf-section-toggle:hover{background:var(--chrome-action-hover,var(--ui-bg-quaternary));color:var(--ui-text-primary)}
.sf-search{display:flex;align-items:center;gap:8px;flex:1;min-width:0;color:var(--ui-text-tertiary)}.sf-search svg{flex-shrink:0;width:18px;height:18px}
.sf-search input{width:100%;min-width:0;padding:0;border:0;background:transparent;color:var(--ui-text-primary);outline:none}
.sf-search input::-webkit-search-cancel-button{-webkit-appearance:none}.sf-search .sf-clear{width:20px;height:20px;padding:2px;visibility:visible;opacity:1}
.sf-header input{font-size:14px}.sf-menu select{max-width:260px;background:var(--ui-bg-quaternary);color:var(--ui-text-primary);border:1px solid var(--ui-stroke-secondary)}
.sf-scroll{overflow:hidden;flex:1;min-height:0;display:flex;flex-direction:column;padding:0 6px;gap:1px}
.sf-shelves{display:grid;flex:1;min-height:0;gap:1px;transition:grid-template-rows .22s ease}
/* Fixed header minima survive short panes; Archives gets most of the flexible space. */
.sf-section{display:flex;flex-direction:column;min-height:0;overflow:hidden}.sf-section[data-section=pinned]{flex:0 1 auto;max-height:18%}.sf-section[data-section=active]{grid-row:1}.sf-section[data-section=working]{grid-row:2}.sf-section[data-section=snoozed]{grid-row:3}.sf-section[data-section=archived]{grid-row:4}
/* Working contributes its intrinsic header + body size to fit-content(18%); animating its own body track keeps the parent cap stable during reversals. */
.sf-section[data-section=working]{display:grid;grid-template-rows:24px minmax(0,1fr);min-height:25px;transition:grid-template-rows .22s ease}.sf-section[data-section=working][data-closed=true]{grid-template-rows:24px minmax(0,0fr);min-height:24px}.sf-section[data-section=working][data-populated=false]{min-height:24px}.sf-section[data-section=working][data-populated=false] .sf-section-body{display:none}
.sf-section-body{overflow:auto;overscroll-behavior:contain;min-height:0;flex:1 1 auto;scrollbar-width:thin}.sf-section-toggle{display:flex;flex-shrink:0;align-items:center;gap:5px;width:100%;height:24px;min-height:24px;padding:3px 6px;border:0;background:transparent;color:var(--ui-text-tertiary);font-size:11px;text-align:left}.sf-count{color:var(--ui-text-quaternary);font-variant-numeric:tabular-nums}.sf-section-label,.sf-count,.sf-section-chevron{flex-shrink:0}.sf-section-line{flex:1;min-width:0;height:1px;background:var(--ui-stroke-secondary)}.sf-section-chevron{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px}
.sf-row{position:relative;height:56px;flex-shrink:0;padding:0 10px;border-radius:5px}.sf-row[data-current=true]{background:var(--ui-bg-quaternary);box-shadow:inset 2px 0 var(--ui-accent)}
.sf-row[data-has-draft=true][data-current=false]{background:color-mix(in srgb,var(--ui-orange,#db704b) 10%,transparent)}
.sf-row[data-has-draft=true][data-current=false]:hover,.sf-row[data-has-draft=true][data-current=false]:focus-within{background:color-mix(in srgb,var(--ui-orange,#db704b) 14%,transparent)}
.sf-row[data-dimmed=true]{opacity:.55}.sf-row[data-dimmed=true]:hover,.sf-row[data-dimmed=true]:focus-within{opacity:1}
/* Native semantic blue is independent of the user's configurable accent. */
.sf-row[data-working=true] .sf-time{color:var(--ui-blue,#0053fd)}
.sf-open{display:flex;flex-direction:column;justify-content:center;gap:3px;width:100%;height:100%;min-width:0;padding:5px 0;border:0;background:transparent;text-align:left;color:inherit}.sf-card-meta{display:flex;align-items:center;gap:8px;width:100%;min-width:0;font-size:12px;color:var(--ui-text-tertiary);height:19px}.sf-project{display:flex;align-items:center;gap:7px;flex:1;min-width:0}.sf-project-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sf-project-icon{display:inline-flex;align-items:center;justify-content:center;width:19px;height:19px;border-radius:4px;background:transparent;flex-shrink:0}.sf-project-icon svg{width:13px;height:13px}.sf-provider{display:flex;width:14px;height:14px;flex-shrink:0}.sf-provider svg{width:14px;height:14px}.sf-token,.sf-time{flex-shrink:0;white-space:nowrap;font-variant-numeric:tabular-nums}.sf-row-title{display:block;width:100%;font-size:14px;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sf-wait{color:var(--ui-accent);flex-shrink:0;display:inline-flex}.sf-pin{display:inline-flex;flex-shrink:0}.sf-hover{position:absolute;right:8px;top:3px;height:25px;display:flex;visibility:hidden;align-items:center;gap:2px;background:var(--ui-bg-elevated,var(--ui-bg-quaternary));border-radius:4px}.sf-hover .sf-icon{width:22px;height:25px}.sf-hover .sf-archive{width:auto;gap:4px;white-space:nowrap}.sf-row:hover .sf-hover{visibility:visible}.sf-row:hover .sf-provider,.sf-row:hover .sf-token,.sf-row:hover .sf-time{visibility:hidden}
.sf-context-trigger{position:absolute;right:8px;top:4px;width:1px;height:1px;clip-path:inset(50%);overflow:hidden;padding:0;border:0}
.sf-row[data-menu-open=true] .sf-hover{visibility:visible;opacity:1}.sf-row[data-menu-open=true] .sf-provider,.sf-row[data-menu-open=true] .sf-token,.sf-row[data-menu-open=true] .sf-time{visibility:hidden}.sf-row[data-dimmed=true][data-menu-open=true]{opacity:1}
.sf-empty{padding:7px 20px;color:var(--ui-text-quaternary);font-size:11px}.sf-note{margin:5px 10px;padding:7px;border:1px solid var(--ui-stroke-secondary);border-radius:4px;font-size:11px;color:var(--ui-text-secondary)}
.sf-group{padding:6px 12px 2px;font-size:10px;color:var(--ui-text-quaternary)}
.sf-menu{display:flex;flex-direction:column;gap:4px;padding:8px;min-width:200px;max-width:290px;color:var(--ui-text-primary)}.sf-menu button{justify-content:flex-start}.sf-menu-title{font-size:11px;color:var(--ui-text-tertiary);margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sf-menu label{font-size:11px}.sf-menu input{width:100%;background:var(--ui-bg-quaternary);color:var(--ui-text-primary);border:1px solid var(--ui-stroke-secondary);padding:5px}.sf-menu p{font-size:10px;color:var(--ui-text-tertiary);margin:4px 0}.sf-error{color:var(--ui-accent)}
.sf-row .sf-project{gap:4px}.sf-row .sf-snooze-time{display:inline-flex;align-items:center;gap:4px;color:var(--ui-blue,#0053fd);font-weight:400}.sf-snooze-time svg{width:13px;height:13px;flex-shrink:0}.sf-menu button.sf-unsnooze{color:var(--ui-green,#1f8a65)}
.sf-menu button.sf-snooze-info:disabled{color:var(--ui-blue,#0053fd);opacity:1;font-weight:400;cursor:default}
.sf-project-choice{display:flex;align-items:center;gap:7px;min-width:0}
.sf-menu .sf-menu-action{display:flex;align-items:center;gap:8px}.sf-menu-icon{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex-shrink:0}.sf-menu-icon svg{width:14px;height:14px}.sf-menu button.sf-menu-action[data-destructive=true]{color:var(--ui-red)}
.sf-menu-label{display:flex;align-items:center;flex:1;min-width:0}
.sf-menu>div:not(.sf-menu-title),.sf-menu form{display:flex;flex-direction:column;gap:4px}
.sf-project-submenu{width:240px;max-height:calc(100vh - 32px);overflow:auto}.sf-project-submenu fieldset{border:0;padding:0;margin:4px 0;min-width:0}.sf-project-submenu legend{font-size:11px;color:var(--ui-text-tertiary);margin-bottom:7px}.sf-project-submenu fieldset:disabled{opacity:.5}.sf-project-icons{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px}.sf-project-icons button{display:flex;align-items:center;justify-content:center;aspect-ratio:1;border:0;border-radius:4px;background:transparent;color:var(--ui-text-tertiary)}.sf-project-icons button:hover,.sf-project-icons button[aria-pressed=true]{background:var(--ui-control-hover-background);color:var(--ui-text-primary)}.sf-submenu-arrow{display:inline-flex;margin-left:auto}
.sf-status{font-weight:600}
.sf-project,.sf-time{color:var(--ui-text-secondary)}.sf-status{display:inline-flex;align-items:center;gap:4px}.sf-status svg{width:13px;height:13px;flex-shrink:0}.sf-status[data-status=done]{color:var(--ui-green,#1f8a65)}.sf-status[data-status=woke]{color:var(--ui-orange,#db704b)}.sf-status[data-status=input]{color:var(--ui-purple,#9e94d5)}.sf-status[data-status=working]{color:var(--ui-blue,#0053fd)}.sf-row[data-unread=true] .sf-row-title{font-weight:600}
.sf-section-body{transition:opacity .18s ease,visibility 0s}.sf-section[data-closed=true] .sf-section-body{opacity:0;visibility:hidden;transition:opacity .18s ease,visibility 0s .22s}.sf-section-chevron{transition:transform .22s ease}.sf-row{transition:opacity .16s ease,background-color .16s ease,box-shadow .16s ease}.sf-hover{transition:opacity .12s ease;opacity:0}.sf-row:hover .sf-hover{opacity:1}.sf-custom-time{display:flex;align-items:center;gap:4px}.sf-custom-time input{min-width:0}.sf-custom-time .sf-icon{flex-shrink:0}
@media(prefers-reduced-motion:reduce){.sf-shelves,.sf-section[data-section=working],.sf-section-body,.sf-section-chevron,.sf-row,.sf-hover{transition:none!important}}
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
function icon(name, fallback) {
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
// Native ProjectAppearancePicker is private; compose its public swatches and Codicons without importing app internals.
const PROJECT_ICONS = ['folder-library', 'repo', 'rocket', 'beaker', 'flame', 'star-full', 'heart', 'zap', 'target', 'lightbulb', 'tools', 'device-desktop', 'device-mobile', 'terminal', 'dashboard', 'globe', 'broadcast', 'cloud', 'database', 'package', 'book', 'organization', 'bug', 'shield', 'key', 'gift', 'telescope', 'home'];
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
  return h('div', { className: 'sf-menu sf-project-submenu' },
    h('div', { className: 'sf-menu-title' }, project?.name || 'Project unavailable'),
    h(MenuAction, { name: 'Pencil', disabled: busy || !editable, onClick: () => setRenaming(true) }, 'Rename'),
    renaming ? h('form', { onSubmit: event => { event.preventDefault(); update({ name }); } },
      h('span', { className: 'sf-custom-time' },
        h('input', { value: name, autoFocus: true, 'aria-label': 'Project name', disabled: busy, onChange: event => setName(event.target.value), onKeyDown: event => { if (event.key === 'Escape') { event.stopPropagation(); setRenaming(false); } } }),
        h(IconButton, { type: 'submit', label: 'Save project rename', name: 'Check', glyph: '✓', disabled: busy || !name.trim() }))) : null,
    h(MenuAction, { name: 'Copy', disabled: busy || !project?.cwd || project.is_home || row._limited, onClick: () => void perform(() => controller.copyProjectPath(scope, project)) }, 'Copy path'),
    h(MenuAction, { name: 'ListFilter', disabled: busy || row._limited || typeof row.cwd !== 'string' && !project?.is_home,
      onClick: () => void perform(() => filterProject(row.cwd || '')) }, 'Filter for'),
    !editable ? h('p', null, 'Project editing requires a named project with a known folder.') : null,
    h('fieldset', { disabled: busy || !editable, 'aria-label': 'Project color' }, h('legend', null, 'Color'),
      sdk.ColorSwatches && sdk.PROFILE_SWATCHES ? h(sdk.ColorSwatches, { swatches: sdk.PROFILE_SWATCHES, value: project?.color || null, clearLabel: 'No color', clearIcon: 'circle-slash', onChange: color => update({ color }) })
        : h('p', null, 'Color selection requires a newer Desktop SDK.')),
    h('fieldset', { disabled: busy || !editable, 'aria-label': 'Project icon' }, h('legend', null, 'Icon'),
      h('div', { className: 'sf-project-icons' }, ...PROJECT_ICONS.map(icon => h('button', { key: icon, type: 'button', 'aria-label': `Project icon: ${icon}`, title: icon,
        'aria-pressed': project?.icon === icon, style: project?.icon === icon && project?.color ? { color: project.color } : undefined,
        onClick: () => update({ icon: project?.icon === icon ? null : icon }) }, projectMark({ icon })))),
      h(MenuAction, { name: 'FolderOpen', onClick: () => update({ icon: null }) }, 'Default icon')),
    error ? h('div', { role: 'alert', className: 'sf-error' }, error) : null);
}
function RowActions({ row, scope, controller, filterProject, deleteSession, mutate, disabled, close, snoozeOnly = false, presetTime, snoozeDetail }) {
  const [value, setValue] = useState(''), [error, setError] = useState(''), [renaming, setRenaming] = useState(false), [title, setTitle] = useState(row.title || ''), [busy, setBusy] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
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
      row.meta.state === 'snoozed' ? h(sdk.Button, { type: 'button', variant: 'ghost', size: 'sm', className: 'sf-snooze-info', disabled: true }, snoozeDetail) : null,
      row.meta.state === 'snoozed' ? h(sdk.Button, { type: 'button', variant: 'ghost', size: 'sm', className: 'sf-snooze-info', disabled: true }, shortDateTime.format(new Date(row.meta.wake_at * 1000))) : null,
      row.meta.state === 'snoozed' ? h(MenuAction, { codicon: 'discard', className: 'sf-unsnooze', disabled: disabled || snoozeDisabled, onClick: () => run({ action: 'restore' }) }, 'Unsnooze') : null,
      ...snoozePresets(Date.now(), presetTime).map(preset => h(MenuAction, { key: preset.label, name: preset.icon, codicon: preset.codicon, disabled: disabled || snoozeDisabled, onClick: () => run({ action: 'snooze', wake_at: preset.wake_at }) }, preset.label)),
      h('label', null, 'Custom · local time', h('span', { className: 'sf-custom-time' },
        h('input', { type: 'datetime-local', value, disabled: disabled || snoozeDisabled, 'aria-label': 'Custom snooze date and time', onChange: event => { setValue(event.target.value); setError(''); } }),
        h(IconButton, { type: 'submit', label: 'Apply custom snooze', name: 'Check', glyph: '✓', disabled: disabled || snoozeDisabled || !value }))))
      : h('div', null,
        action(row.meta.pinned ? 'Unpin' : 'Pin', 'Pin', { action: row.meta.pinned ? 'unpin' : 'pin' }),
        row.archived !== true && row.meta.state === 'snoozed' ? action('Restore to Ready', 'CornerDownLeft', { action: 'restore' }) : null,
        h(MenuAction, { name: 'Pencil', disabled: busy || !row.runtimeId, onClick: () => setRenaming(true) }, 'Rename'),
        !row.runtimeId ? h('p', null, 'Rename requires a live runtime. Open the thread and retry.') : null,
        renaming ? h('form', { onSubmit: event => { event.preventDefault(); void perform(() => controller.rename(scope, row, title)); } },
          h('span', { className: 'sf-custom-time' },
          h('input', { type: 'text', value: title, autoFocus: true, 'aria-label': 'Session title', disabled: busy, onChange: event => setTitle(event.target.value), onKeyDown: event => { if (event.key === 'Escape') { event.stopPropagation(); setRenaming(false); } } }),
          h(IconButton, { type: 'submit', label: 'Save rename', name: 'Check', glyph: '✓', disabled: busy || !title.trim() }))) : null,
        h(MenuAction, { name: 'Copy', disabled: busy, onClick: () => void perform(() => controller.copyId(scope, row)) }, 'Copy session ID'),
        h(MenuAction, { name: 'Trash2', destructive: true, disabled: disabled || busy || row.status !== 'idle' || row._liveOnly || typeof sdk.ConfirmDialog !== 'function', onClick: () => { controller.check(scope); deleteSession(row); close(); } }, 'Delete session'),
        row._liveOnly ? h('p', null, 'Unsaved sessions must be closed through the native session controls.') : null,
        h(sdk.Popover, { open: projectOpen, onOpenChange: setProjectOpen },
          h(sdk.PopoverTrigger, { asChild: true }, h(MenuAction, { name: 'FolderOpen', 'aria-label': 'Project', disabled: busy, onKeyDown: event => { if (event.key === 'ArrowRight') { event.preventDefault(); setProjectOpen(true); } } }, 'Project', h('span', { className: 'sf-submenu-arrow', 'aria-hidden': true }, icon('ChevronRight', '›')))),
          h(sdk.PopoverContent, { side: 'right', align: 'start', style: { padding: 0 }, 'aria-label': 'Project actions', onKeyDown: event => {
            if (event.key === 'ArrowLeft' && event.target.tagName !== 'INPUT' && event.target.tagName !== 'TEXTAREA' && !event.target.isContentEditable || event.key === 'Escape') { event.stopPropagation(); setProjectOpen(false); }
          } }, h(ProjectActions, { row, scope, controller, filterProject, close })))),
    error ? h('div', { role: 'alert', className: 'sf-error' }, error) : null);
}
export function cardStatus(row, active = false) {
  return row.status === 'waiting' ? 'input' : row.status === 'working' ? 'working' : row.woke ? 'woke' : ((!active && row.completion?.done_token) || row.unread === true) ? 'done' : null;
}
function SessionRow({ row, active, hidden, controller, scope, mutate, filterProject, deleteSession, disabled, onFocus, onNavigate, rowRef, age, retain, presetTime, snoozeDetail }) {
  const [menuOpen, setMenuOpen] = useState(false), [snoozeOpen, setSnoozeOpen] = useState(false), trigger = useRef(null);
  useEffect(() => { retain?.(row.key, menuOpen || snoozeOpen); return () => retain?.(row.key, false); }, [retain, row.key, menuOpen, snoozeOpen]);
  const ref = useCallback(element => rowRef(row.key, element), [rowRef, row.key]);
  const draft = useQuery({
    queryKey: ['hermes-t3sidebar-drafts', scope.connectionId, scope.profile, scope.epoch, durableId(row), row.resolved_id || row.id],
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
  const attention = row.status === 'waiting', snoozed = row.section === 'snoozed', badge = snoozed ? null : cardStatus(row, active);
  const tokens = compactTokens(row), provider = providerMark(row.provider);
  const open = () => Promise.resolve().then(() => controller.open(scope, row)).catch(error => host.notify({ kind: 'error', message: error.message }));
  const keyDown = event => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); setMenuOpen(true); }
    else if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); if (!disabled && (row.archived === true || row.status === 'idle')) void mutate(row, { action: row.archived === true ? 'unarchive' : 'archive', advance: row.archived !== true }); }
    else onNavigate(event, row.key);
  };
  return h('div', { className: 'sf-row', 'data-menu-open': menuOpen || snoozeOpen, 'data-current': active, 'data-has-draft': draft.data === true && !draft.isError, 'data-working': row.status === 'working', 'data-unread': !!(!active && row.completion?.done_token) || row.unread === true || row.woke || attention, 'data-dimmed': ['working', 'snoozed', 'archived'].includes(row.section), 'data-session-id': row.key,
    onContextMenu: event => { event.preventDefault(); setMenuOpen(true); } },
    h('button', { type: 'button', className: 'sf-open', ref, 'aria-current': active ? 'page' : undefined,
      'aria-label': `${sessionTitle(row)}${attention ? ', waiting for approval or answer' : ''}${row.status === 'unknown' ? ', status unknown' : ''}`,
      onClick: open, onFocus: () => onFocus(row.key), onBlur: () => onFocus(null), onKeyDown: keyDown,
      title: [sessionTitle(row), row.cwd, row.git_branch, row.status === 'waiting' ? 'Waiting for approval or answer' : row.status].filter(Boolean).join('\n') },
      h('span', { className: 'sf-card-meta' },
        h('span', { className: 'sf-project' },
          h('span', { className: 'sf-project-icon', 'aria-hidden': true, style: { color: row.project?.color || undefined } }, projectMark(row.project)),
          row.meta.pinned ? h('span', { className: 'sf-pin', 'aria-label': 'Pinned' }, icon('Pin', '♧')) : null,
          row.project?.name || !row.newSession ? h('span', { className: 'sf-project-name' }, row.project?.name || 'Project unavailable') : null),
        row.status === 'unknown' ? h('span', { className: 'sf-wait', role: 'img', 'aria-label': 'Status unknown' }, '?') : null,
        provider ? h('span', { className: 'sf-provider', role: 'img', 'aria-label': `Provider: ${row.provider}`, title: row.provider }, provider) : null,
        h('span', { className: 'sf-token', title: 'Total input and output tokens', 'aria-label': `Total tokens: ${tokens}` }, tokens),
        h('span', { className: snoozed ? 'sf-time sf-snooze-time' : 'sf-time' }, snoozed ? icon('Clock', '◷') : null, badge ? h('span', { className: 'sf-status', 'data-status': badge },
          badge === 'input' ? h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true }, h('path', { d: 'M4 4h16v12H9l-5 4V4M10 8a2 2 0 0 1 4 0c0 2-2 1-2 3M12 13v1' })) : badge !== 'working' ? icon(badge === 'done' ? 'CircleCheck' : 'AlarmClock', badge === 'done' ? '✓' : '◷') : null,
          { done: 'Done', woke: 'Woke', input: 'Input', working: 'Working' }[badge]) : snoozed ? h('span', { className: 'sf-snooze-duration' }, age) : age)),
      h('span', { className: 'sf-row-title' }, sessionTitle(row))),
    h('div', { className: 'sf-hover' },
      row.archived !== true ? h(sdk.Popover, { open: snoozeOpen, onOpenChange: setSnoozeOpen },
        h(sdk.PopoverTrigger, { asChild: true }, h(IconButton, { label: 'Snooze session', name: 'Clock', glyph: '◷', disabled, 'aria-haspopup': 'dialog' })),
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
function SessionWindow({ entries, section, renderRow, navigators, rowRefs }) {
  const body = useRef(null), pending = useRef(null), viewportHeight = useRef(null);
  const [viewport, setViewport] = useState({ top: 0, height: 560 });
  const [retained, setRetained] = useState(() => new Set()), [focusedKey, setFocusedKey] = useState(null);
  const windowed = entries.length > 80;
  const retain = useCallback((key, keep) => setRetained(previous => {
    if (previous.has(key) === keep) return previous;
    const next = new Set(previous); if (keep) next.add(key); else next.delete(key); return next;
  }), []);
  const update = useCallback(() => {
    const element = body.current?.parentElement;
    if (!element) return;
    // Observer-backed clients need no height measurement on the scroll path.
    const top = Math.floor(element.scrollTop / 56), height = viewportHeight.current ?? element.clientHeight;
    setViewport(previous => previous.top === top && (!height || previous.height === height) ? previous : { top, height: height || previous.height });
  }, []);
  useEffect(() => {
    const element = body.current?.parentElement;
    if (typeof ResizeObserver === 'function') viewportHeight.current = element.clientHeight || 560;
    update();
    element.addEventListener('scroll', update, { passive: true });
    if (typeof ResizeObserver !== 'function') return () => element.removeEventListener('scroll', update);
    const observer = new ResizeObserver(entries => {
      const entry = entries.find(entry => entry.target === element);
      // Collapse must not erase the last usable height before reopening/navigation.
      if (entry?.contentRect.height > 0) { viewportHeight.current = entry.contentRect.height; update(); }
    }); observer.observe(element);
    return () => { observer.disconnect(); element.removeEventListener('scroll', update); };
  }, [update]);
  useEffect(() => {
    const reveal = key => {
      const index = entries.findIndex(row => row.key === key), element = body.current?.parentElement;
      if (index < 0 || !element) return;
      pending.current = key;
      const top = element.scrollTop, height = viewportHeight.current ?? element.clientHeight;
      if (index * 56 < top) element.scrollTop = index * 56;
      else if ((index + 1) * 56 > top + height) element.scrollTop = (index + 1) * 56 - height;
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
  const end = Math.min(entries.length, viewport.top + Math.ceil(viewport.height / 56) + 3);
  const positions = useMemo(() => new Map(entries.map((row, index) => [row.key, index])), [entries]);
  const indexes = windowed ? [...new Set([
    ...Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset),
    ...[...retained, focusedKey].map(key => positions.get(key)).filter(index => index !== undefined)
  ])].sort((a, b) => a - b) : entries.map((_, index) => index);
  return h('div', { ref: body, className: 'sf-window', onScroll: update,
    onFocusCapture: event => { const row = event.target.closest('[data-session-id]'); if (row) setFocusedKey(row.dataset.sessionId); },
    onBlurCapture: event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusedKey(null); },
    style: { position: 'relative', height: windowed ? entries.length * 56 : undefined } },
    ...indexes.map(index => h('div', { key: entries[index].key, style: windowed ? { position: 'absolute', top: index * 56, left: 0, right: 0 } : undefined }, renderRow(entries[index], retain))));
}
export function HermesT3Sidebar({ ctx, controller }) {
  const connectionId = useValue(host.state.connectionId), profile = useValue(host.state.profile);
  useValue(host.state.gateway);
  useValue(activationEpoch);
  const epoch = gatewayActivationEpoch();
  const scope = useMemo(() => ({ connectionId, profile: profile || 'default', epoch }), [connectionId, profile, epoch]);
  return h(ScopedSidebar, { key: JSON.stringify(scopeKey(scope)), scope, controller, ctx });
}
export function ProjectPicker({ controller, scope, close }) {
  const [query, setQuery] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true), creationKeys = useRef(new Map());
  useEffect(() => () => { alive.current = false; }, []);
  const projects = useQuery({ queryKey: [...scopeKey(scope), 'projects'], queryFn: () => controller.projects(scope), retry: false });
  const select = async project => {
    if (busy) return;
    setBusy(true); setError('');
    try { controller.check(scope); await controller.newChat(scope, project, creationKeys.current.get(project.id) || (() => { const key = `hermes-t3sidebar:${globalThis.crypto.randomUUID()}`; creationKeys.current.set(project.id, key); return key; })()); controller.check(scope); if (alive.current) close(); }
    catch (err) { if (alive.current && sameScope(scope, captureScope())) setError(err.message); }
    finally { if (alive.current) setBusy(false); }
  };
  const entries = (projects.data?.projects || []).filter(project => !project.isNoProject && project.id !== '__no_project__');
  return h('div', { className: 'sf-menu', 'aria-label': 'Choose project for new session' },
    h('strong', null, 'New session in…'),
    entries.length > 8 ? h('input', { type: 'search', 'aria-label': 'Search projects', placeholder: 'Search projects', value: query, onChange: event => setQuery(event.target.value) }) : null,
    projects.isLoading ? h('div', { role: 'status' }, 'Loading projects…') : null,
    projects.isError ? h('div', { role: 'alert' }, projects.error.message, h(sdk.Button, { onClick: () => projects.refetch() }, 'Retry projects')) : null,
    projects.data && !entries.length ? h('div', { role: 'status' }, 'No projects available') : null,
    ...entries.filter(project => project.name.toLowerCase().includes(query.toLowerCase())).map(project => h(sdk.Button, { key: project.id, type: 'button', variant: 'ghost', className: 'sf-project-choice', disabled: busy, 'aria-label': `New session in ${project.name}`, onClick: () => void select(project) },
      h('span', { className: 'sf-project-icon', 'aria-hidden': true, style: { color: project.color || undefined } }, projectMark(project)), h('span', { className: 'sf-project-name' }, project.name))),
    busy ? h('div', { role: 'status' }, 'Creating session…') : null,
    error ? h('div', { role: 'alert' }, error) : null);
}
function ScopedSidebar({ ctx, controller, scope }) {
  const presetTime = useSnoozeTime(ctx);
  const client = useQueryClient(), activeId = useValue(host.state.focusedStoredSessionId), activeOwner = useValue(host.state.focusedSessionOwner);
  const [query, setQuery] = useState(''), [project, setProject] = useState('*'), [filterOpen, setFilterOpen] = useState(false), [pickerOpen, setPickerOpen] = useState(false), [deleteTarget, setDeleteTarget] = useState(null);
  const [collapsed, setCollapsed] = useState(() => readFolds(ctx, scope)), [limit, setLimit] = useState(0), [archiveLimit, setArchiveLimit] = useState(0), [actionError, setActionError] = useState('');
  const preferenceKey = foldStorageKey(scope);
  useEffect(() => {
    try { ctx.storage.set(preferenceKey, collapsed); } catch (_) { /* Folding still works when persistence is unavailable. */ }
  }, [ctx, preferenceKey, collapsed]);
  const search = useRef(null), rowRefs = useRef(new Map()), navigators = useRef(new Map()), focused = useRef(null), latest = useRef(null), readMarkers = useRef(new Set());
  const key = scopeKey(scope);
  const mutation = useMutation({ mutationFn: async ({ id, payload }) => controller.mutate(scope, id, payload) });
  const opts = { refetchInterval: 5000, staleTime: 2000, retry: false };
  const sessions = useQuery({ ...opts, queryKey: [...key, 'sessions'], queryFn: () => controller.list(scope) });
  const runtime = useQuery({ ...opts, queryKey: [...key, 'runtime'], queryFn: () => controller.runtime(scope) });
  const metadata = useQuery({ ...opts, queryKey: [...key, 'metadata'], queryFn: () => controller.metadata(scope), enabled: !mutation.isPending });
  const expanded = useQuery({ ...opts, staleTime: Infinity, refetchInterval: false, queryKey: [...key, 'expanded', limit], enabled: limit > 0, queryFn: () => controller.expanded(scope, limit) });
  const archives = useQuery({ ...opts, queryKey: [...key, 'archives', archiveLimit], queryFn: () => controller.archives(scope, archiveLimit) });
  const live = runtime.isError ? EMPTY_ROWS : runtime.data?.sessions || EMPTY_ROWS;
  const rich = sessions.data?.sessions || EMPTY_ROWS, extra = sessions.data?.capped ? EMPTY_ROWS : expanded.data?.sessions || EMPTY_ROWS;
  const archivedRows = archives.isError ? EMPTY_ROWS : archives.data?.sessions || EMPTY_ROWS;
  const rows = useMemo(() => mergeRows(rich, extra, live, true, archivedRows), [rich, extra, live, archivedRows]);
  const runtimeKnown = !!runtime.data && !runtime.isError;
  // Successful polls still advance ages and due snoozes when Query structural
  // sharing keeps data references unchanged. Use existing polls, no extra timer.
  const now = useMemo(() => Date.now() / 1000, [sessions.dataUpdatedAt, runtime.dataUpdatedAt, metadata.dataUpdatedAt, archives.dataUpdatedAt]);
  const classified = useMemo(() => buildSections(rows, metadata.data || EMPTY_STATE, live, { runtimeKnown, now }), [rows, metadata.data, live, runtimeKnown, now]);
  const sections = useMemo(() => Object.fromEntries(SECTIONS.map(section => [section,
    classified[section].filter(row => matchesFilters(row, query, project))])), [classified, query, project]);
  const searching = !!query.trim();
  const isClosed = section => !!collapsed[section] && !(searching && section === 'working');
  const sectionTrack = section => {
    // CSS owns Working's content fit, cap, and body-track fold animation.
    if (section === 'working') return 'fit-content(18%)';
    const count = sections[section].length;
    if (isClosed(section)) return 'minmax(24px,0fr)';
    return `minmax(25px,${section === 'archived' && count ? 3 : count ? .65 : .25}fr)`;
  };
  const filtering = searching || project !== '*';
  const hasMatches = SECTIONS.some(section => sections[section].length > 0);
  const visible = SECTIONS.flatMap(section => isClosed(section) && !(section === 'active' && sections.active.some(row => row.status === 'waiting' || row.status === 'unknown')) ? [] : sections[section]);
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
  const projects = useMemo(() => [...projectChoices.values()].sort((a, b) => a.name.localeCompare(b.name) || a.cwd.localeCompare(b.cwd)), [projectChoices]);
  const selectedProject = projectChoices.get(project) || { name: project || 'No project' };
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
  });
  const focusRow = useCallback(id => { focused.current = id; }, []);
  const rowRef = useCallback((id, element) => { if (element) rowRefs.current.set(id, element); else rowRefs.current.delete(id); }, []);
  const disabled = latest.current.disabled;
  const renderRow = (row, retain) => h(MemoSessionRow, { key: row.key, row, retain, scope, controller, mutate, hidden: isClosed(row.section), filterProject: selectProject, deleteSession: setDeleteTarget, disabled: disabled || row._liveOnly,
    presetTime, snoozeDetail: row.meta.state === 'snoozed' ? snoozePreciseRemaining(row.meta.wake_at, now) : null,
    active: activeOwner?.connectionId === (scope.connectionId ?? 'local') && activeOwner?.profile === scope.profile && aliases(row).includes(activeId), onFocus: focusRow, onNavigate: navigate, rowRef, age: row.section === 'snoozed' ? snoozeRemaining(row.meta.wake_at, now) : relative(row.activity, now) });
  const renderSection = section => {
    const entries = sections[section], closed = isClosed(section);
    const items = h(SessionWindow, { entries, section, renderRow, navigators, rowRefs });
    const headerless = section === 'active' || section === 'pinned';
    if (section === 'pinned' && !entries.length) return null;
    return h('section', { key: section, className: 'sf-section', 'aria-label': LABELS[section], 'data-section': section, 'data-populated': entries.length > 0, 'data-closed': closed },
      !headerless ? h('button', { type: 'button', className: 'sf-section-toggle', 'aria-expanded': !closed, 'aria-label': `${LABELS[section]} (${entries.length})`,
        onClick: () => setCollapsed(previous => ({ ...previous, [section]: !previous[section] })) },
        h('span', { className: 'sf-section-label' }, LABELS[section]), h('span', { className: 'sf-count' }, `(${entries.length})`),
        h('span', { className: 'sf-section-line', 'aria-hidden': true }),
        h('span', { className: 'sf-section-chevron', 'aria-hidden': true }, icon(closed ? 'ChevronRight' : 'ChevronUp', closed ? '›' : '⌃'))) : null,
      h('div', { className: 'sf-section-body', 'aria-label': `${section === 'active' ? 'Ready' : LABELS[section]} sessions`, 'aria-hidden': closed || undefined, inert: closed || undefined, tabIndex: -1 },
        section === 'archived' && archives.isError ? h('div', { className: 'sf-empty', role: 'alert' }, `Archives unavailable: ${archives.error.message}`) : entries.length ? items : section === 'active' && filtering ? null : h('div', { className: 'sf-empty' }, section === 'active' ? 'All caught up' : section === 'archived' && archives.isLoading ? 'Loading archives…' : 'No sessions'),
        section === 'archived' && !archives.isError && archives.data?.has_more ? h(sdk.Button, { variant: 'ghost', size: 'xs', disabled: archives.isFetching, onClick: () => setArchiveLimit(previous => previous + 1) }, 'Browse older archives') : null));

  };
  // Toolbar/popover/error state is not a list input: retain its element tree,
  // not only the cards, so these interactions never walk thousands of rows.
  const renderedSections = useMemo(() => SECTIONS.map(renderSection), [sections, collapsed, searching, filtering, activeId, activeOwner,
    scope, controller, mutate, selectProject, disabled, focusRow, navigate, rowRef, now, presetTime,
    archives.isError, archives.error, archives.isLoading, archives.isFetching, archives.data?.has_more]);
  const total = sessions.data?.total;
  const knownTotal = typeof total === 'number' && Number.isFinite(total) && total >= 0;
  const fallbackCount = knownTotal && total > 500 ? ` is capped at 500 of ${total}`
    : `: ${sessions.data?.sessions.length || 0} loaded${knownTotal ? ` of ${total} available` : ''}`;
  const canExpand = !sessions.data?.capped && (limit === 0 ? sessions.data?.has_more : expanded.data?.has_more);
  return h('aside', { className: 'sf', 'aria-label': 'hermes-t3sidebar', onKeyDown: event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); search.current?.focus(); }
    if (event.key === 'Escape' && event.target === search.current) { setQuery(''); search.current?.blur(); }
  } }, h('style', null, CSS),
    h('header', { className: 'sf-header' },
      h('div', { className: 'sf-search' }, icon('Search', '⌕'), h('input', { ref: search, type: 'search', placeholder: 'Search', 'aria-label': 'Search sessions', value: query, onChange: event => setQuery(event.target.value) }),
        query ? h(IconButton, { label: 'Clear search', name: 'X', glyph: '×', className: 'sf-clear', onClick: () => { setQuery(''); search.current?.focus(); } }) : null),
      h(sdk.Popover, { open: filterOpen, onOpenChange: setFilterOpen },
        h(sdk.PopoverTrigger, { asChild: true }, h(IconButton, { label: 'Filter sessions', name: 'ListFilter', glyph: '≡', 'data-filtered': project !== '*', title: project === '*' ? 'Filter sessions' : `Filter sessions: ${selectedProject.name}` },
          project !== '*' ? h('span', { className: 'sf-project-icon', 'aria-hidden': true, style: { color: selectedProject.color || undefined } }, projectMark(selectedProject)) : null)),
        h(sdk.PopoverContent, { align: 'end', 'aria-label': 'Session filters' }, h('div', { className: 'sf-menu' },
          h(sdk.Button, { type: 'button', variant: 'ghost', className: 'sf-project-choice', 'aria-label': 'All projects', 'aria-pressed': project === '*', onClick: () => selectProject('*') },
            icon('ListFilter', '≡'), h('span', { className: 'sf-project-name' }, 'All projects'), project === '*' ? icon('Check', '✓') : null),
          ...projects.map(choice => h(sdk.Button, { key: choice.cwd, type: 'button', variant: 'ghost', className: 'sf-project-choice', 'aria-label': `Filter by ${choice.name}`, 'aria-pressed': project === choice.cwd, onClick: () => selectProject(choice.cwd) },
            h('span', { className: 'sf-project-icon', 'aria-hidden': true, style: { color: choice.color || undefined } }, projectMark(choice)),
            h('span', { className: 'sf-project-name' }, choice.name), project === choice.cwd ? icon('Check', '✓') : null))))),

      h(sdk.Popover, { open: pickerOpen, onOpenChange: setPickerOpen },
        h(sdk.PopoverTrigger, { asChild: true }, h(IconButton, { label: 'New session', name: 'SquarePen', glyph: '+' })),
        h(sdk.PopoverContent, { align: 'end', 'aria-label': 'New session project' }, pickerOpen ? h(ProjectPicker, { controller, scope, close: () => setPickerOpen(false) }) : null))),
    sessions.isLoading ? h(Note, null, 'Loading sessions…') : null,
    sessions.isError ? h(Note, { error: true }, `Session list failed: ${sessions.error.message} `, h(sdk.Button, { variant: 'ghost', size: 'xs', onClick: refresh }, 'Retry')) : null,
    !runtimeKnown ? h(Note, { error: runtime.isError }, runtime.isError ? `Runtime status unavailable: ${runtime.error.message}. Native archives remain Archived; other sessions stay accessible in Ready.` : 'Checking runtime status…') : null,
    metadata.isError ? h(Note, { error: true }, `hermes-t3sidebar backend unavailable: ${metadata.error.message}. Read-only browsing; no local metadata fallback. `, h(sdk.Button, { variant: 'ghost', size: 'xs', onClick: refresh }, 'Retry')) : null,
    expanded.isError ? h(Note, { error: true }, `Older sessions could not load: ${expanded.error.message}`) : null,
    actionError ? h(Note, { error: true }, actionError) : null,
    h('div', { className: 'sf-scroll' }, renderedSections[0],
      h('div', { className: 'sf-shelves', style: { gridTemplateRows: `minmax(0,1fr) ${['working', 'snoozed', 'archived'].map(sectionTrack).join(' ')}` } }, ...renderedSections.slice(1),
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
        || /^(message\.start|subagent\.(start|complete))$/.test(type);
      if (!runtime) return;
      if (pending && sameScope(pending.scope, scope)) { pending.history ||= history; return; }
      const work = pending = { scope, history };
      // Coalesce a turn's lifecycle burst without a timer. Query dedupes a
      // still-running read instead of cancelling/restarting it on the next burst.
      void Promise.resolve().then(() => {
        if (disposed || pending !== work) return;
        pending = null;
        if (!sameScope(scope, captureScope())) return;
        const resources = work.history ? ['sessions', 'expanded', 'page', 'archives', 'metadata', 'runtime'] : ['runtime'];
        return queryClient.invalidateQueries({ queryKey: scopeKey(scope), predicate: query => resources.includes(query.queryKey[4]), refetchType: 'active' }, { cancelRefetch: false });
      }).catch(() => { /* Query retains errors for the pane's normal recovery UI. */ });
    });
    ctx.onDispose(() => { disposed = true; pending = null; controller.dispose(); disposeEvent(); for (const root of ['hermes-t3sidebar', 'hermes-t3sidebar-drafts', 'hermes-t3sidebar-preferences']) { void queryClient.cancelQueries({ queryKey: [root] }); queryClient.removeQueries({ queryKey: [root] }); } });
  }
};
