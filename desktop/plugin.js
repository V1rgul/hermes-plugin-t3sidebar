// hermes-t3sidebar — independent T3-inspired session browser; plain disk-plugin ESM.
import * as sdk from '@hermes/plugin-sdk';
import { createElement as h, useEffect, useRef, useState } from 'react';

const { host, useValue, useQuery, useMutation, useQueryClient, queryClient, gatewayActivationEpoch } = sdk;
export const SECTIONS = ['pinned', 'active', 'working', 'snoozed', 'archived'];
const LABELS = { active: 'Ready', pinned: 'Pinned', working: 'Working', snoozed: 'Snoozed', archived: 'Archived' };
const EMPTY_STATE = { version: 1, sessions: {} };
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
      (item.state === 'snoozed' && !(Number.isFinite(item.wake_at) && item.wake_at > 0))) throw new Error('Invalid hermes-t3sidebar metadata.');
  }
  return value;
}
export const visibleSource = row => !['cron', 'tool', 'oneshot', 'kanban'].includes(String(row.source || '').toLowerCase());
export function compactTokens(row) {
  const valid = value => Number.isFinite(value) && value >= 0;
  const total = valid(row.total_tokens) ? row.total_tokens : valid(row.input_tokens) && valid(row.output_tokens) ? row.input_tokens + row.output_tokens : null;
  return total === null ? '—' : Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(total);
}
export function mergeRows(rich, extra = [], live = [], extraRich = false, archives = []) {
  const rows = new Map();
  // Archive feed wins over stale active pages, and remains rich/project-filterable.
  for (const row of [...extra.map(r => ({ ...r, _limited: !extraRich })), ...rich.map(r => ({ ...r, _limited: false })), ...archives.map(r => ({ ...r, _limited: false }))]) {
    const key = durableId(row), previousKey = rows.has(key) ? key : [...rows.keys()].find(id => aliases(rows.get(id)).some(alias => aliases(row).includes(alias))), previous = rows.get(previousKey);
    if (!key || !visibleSource(row)) continue;
    if (previousKey && previousKey !== key) rows.delete(previousKey);
    rows.set(key, { ...previous, ...row, _lineage_ids: [...new Set([...(previous ? aliases(previous) : []), ...aliases(row)])] });
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
  for (const row of rows) {
    if (!visibleSource(row)) continue;
    const meta = metadata.sessions[durableId(row)] || { state: 'active', pinned: false };
    const ids = new Set(aliases(row));
    const matches = live.filter(item => ids.has(item.session_key) || ids.has(item.id));
    // Waiting wins over every metadata shelf and working signal, across the entire lineage.
    const status = !runtimeKnown ? 'unknown' : matches.some(i => i.status === 'waiting') ? 'waiting'
      : matches.some(i => i.status === 'working' || i.status === 'starting') ? 'working'
      : matches.some(i => !['idle', 'working', 'starting', 'waiting'].includes(i.status)) ? 'unknown' : 'idle';
    const woke = meta.state === 'snoozed' && meta.wake_at <= now;
    const section = status === 'waiting' ? 'active'
      : row.archived === true ? 'archived'
      : status === 'unknown' ? 'active'
      : meta.state === 'snoozed' && !woke ? 'snoozed'
      : status === 'working' ? 'working'
      : meta.pinned ? 'pinned' : 'active';
    const text = [row.title, row.preview, row.cwd, row.git_branch, ...aliases(row)].filter(Boolean).join(' ').toLowerCase();
    if (query && !query.trim().toLowerCase().split(/\s+/).every(token => text.includes(token))) continue;
    if (project !== '*' && (row._limited || (row.cwd || '') !== project)) continue;
    result[section].push({ ...row, key: durableId(row), meta, section, status, woke,
      activity: Math.max(seconds(row.last_active || row.updated_at || row.started_at || row.created_at), ...matches.map(i => seconds(i.last_active))) });
  }
  for (const section of SECTIONS) result[section].sort((a, b) => {
    if (section === 'active' && (a.status === 'waiting') !== (b.status === 'waiting')) return a.status === 'waiting' ? -1 : 1;
    // Native history has no archive timestamp; archives are ordered by last activity.
    const delta = section === 'snoozed' ? a.meta.wake_at - b.meta.wake_at : b.activity - a.activity;
    return delta || a.key.localeCompare(b.key);
  });
  return result;
}
export function snoozePresets(now = Date.now()) {
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
  return [{ label: 'In 1 hour', wake_at: Math.floor(now / 1000) + 3600 },
    { label: 'In 3 hours', wake_at: Math.floor(now / 1000) + 10800 },
    { label: 'Tomorrow at 9:00', wake_at: Math.floor(tomorrow.getTime() / 1000) }];
}
export function parseLocalWake(value, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Choose a local date and time.');
  const date = new Date(value), wake = date.getTime();
  const [year, month, day, hour, minute] = value.split(/[-T:]/).map(Number);
  if (!Number.isFinite(wake) || date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute) throw new Error('That local time does not exist.');
  if (wake <= now) throw new Error('Choose a future time.');
  return Math.floor(wake / 1000);
}
export function inverseAction(action, before = { state: 'active', pinned: false }) {
  if (action === 'pin' || action === 'unpin') return { action: before.pinned ? 'pin' : 'unpin' };
  if (before.state === 'snoozed' && before.wake_at > Date.now() / 1000) return { action: 'snooze', wake_at: before.wake_at };
  return { action: before.state === 'settled' ? 'settle' : 'restore' };
}
export function verifyAction(state, id, payload) {
  const item = state.sessions[id];
  const expected = payload.action === 'settle' ? item?.state === 'settled'
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
  function check(scope) { if (disposed || !sameScope(scope, env.capture())) throw new Error('Source/profile changed; refresh before trying again.'); }
  async function fenced(scope, fn) { check(scope); const result = await fn(); check(scope); return result; }
  async function routeFor(scope) { return currentRoute(scope, await fenced(scope, () => env.routes())); }
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
  return {
    dispose() { disposed = true; generation++; }, check,
    async list(scope) {
      const ticket = generation, route = await routeFor(scope);
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
      const ticket = generation, route = await routeFor(scope), sessions = [];
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
      const ticket = generation, route = await routeFor(scope), sessions = [];
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
          await client.invalidateQueries({ queryKey: native ? scopeKey(scope) : key, exact: !native });
        }
      }
    },
    async open(scope, row) {
      const route = await routeFor(scope); check(scope);
      return env.host.openSession(row.resolved_id || row.id, { route, profile: route?.profile || scope.profile, intent: 'in-place' });
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
    async openProjects(scope) {
      await routeFor(scope);
      throw new Error('Adding projects is unavailable through the public Desktop plugin API. Use native project management.');
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
.sf-icon:hover,.sf-row:hover,.sf-row:focus-within,.sf-section-toggle:hover{background:var(--chrome-action-hover,var(--ui-bg-quaternary));color:var(--ui-text-primary)}
.sf-search{display:flex;align-items:center;gap:8px;flex:1;min-width:0;color:var(--ui-text-tertiary)}.sf-search svg{flex-shrink:0;width:18px;height:18px}
.sf-search input{width:100%;min-width:0;padding:0;border:0;background:transparent;color:var(--ui-text-primary);outline:none}
.sf-header input{font-size:14px}.sf-menu select{max-width:260px;background:var(--ui-bg-quaternary);color:var(--ui-text-primary);border:1px solid var(--ui-stroke-secondary)}
.sf-scroll{overflow:hidden;flex:1;min-height:0;display:flex;flex-direction:column;padding:0 6px;gap:1px;--sf-body-min:clamp(0px,calc((100% - 76px)/5),56px)}
/* Reserve three headers and four gaps before sharing the remaining minimum body space; banners can reduce this below a full card. */
.sf-section{display:flex;flex-direction:column;flex:0 1 auto;max-height:22%;min-height:24px;overflow:hidden}.sf-section[data-populated=true][data-closed=false]{min-height:calc(24px + var(--sf-body-min))}.sf-section[data-section=active]{flex:1 1 0;max-height:none;min-height:var(--sf-body-min)}.sf-section[data-section=pinned][data-populated=true],.sf-section[data-section=active][data-populated=true]{min-height:var(--sf-body-min)}
.sf-section-body{overflow:auto;overscroll-behavior:contain;min-height:0;flex:1 1 auto;scrollbar-width:thin}.sf-section-toggle{display:flex;flex-shrink:0;align-items:center;gap:5px;width:100%;height:24px;min-height:24px;padding:3px 6px;border:0;background:transparent;color:var(--ui-text-tertiary);font-size:11px;text-align:left}.sf-count{margin-left:auto;color:var(--ui-text-quaternary);font-variant-numeric:tabular-nums}
.sf-row{position:relative;height:56px;flex-shrink:0;padding:0 10px;border-radius:5px}.sf-row[data-current=true]{background:var(--ui-bg-quaternary);box-shadow:inset 2px 0 var(--ui-accent)}
.sf-row[data-dimmed=true]{opacity:.55}.sf-row[data-dimmed=true]:hover,.sf-row[data-dimmed=true]:focus-within{opacity:1}
.sf-open{display:flex;flex-direction:column;justify-content:center;gap:5px;width:100%;height:100%;min-width:0;padding:5px 0;border:0;background:transparent;text-align:left;color:inherit}.sf-card-meta{display:flex;align-items:center;gap:8px;width:100%;min-width:0;font-size:12px;color:var(--ui-text-tertiary);height:19px}.sf-project{display:flex;align-items:center;gap:7px;flex:1;min-width:0}.sf-project-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sf-project-icon{display:inline-flex;align-items:center;justify-content:center;width:19px;height:19px;border-radius:4px;background:var(--ui-bg-quaternary);flex-shrink:0}.sf-project-icon svg{width:13px;height:13px}.sf-provider{display:flex;width:14px;height:14px;flex-shrink:0}.sf-provider svg{width:14px;height:14px}.sf-token,.sf-time{flex-shrink:0;white-space:nowrap;font-variant-numeric:tabular-nums}.sf-row-title{display:block;width:100%;font-size:14px;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sf-wait{color:var(--ui-accent);flex-shrink:0;display:inline-flex}.sf-pin{display:inline-flex;flex-shrink:0}.sf-hover{position:absolute;right:8px;top:3px;height:25px;display:none;align-items:center;gap:2px;background:var(--ui-bg-elevated,var(--ui-bg-quaternary));border-radius:4px}.sf-hover .sf-icon{width:22px;height:25px}.sf-hover .sf-archive{width:auto;gap:4px;white-space:nowrap}.sf-row:hover .sf-hover{display:flex}.sf-row:hover .sf-provider,.sf-row:hover .sf-token,.sf-row:hover .sf-time{visibility:hidden}
.sf-context-trigger{position:absolute;right:8px;top:4px;width:1px;height:1px;clip-path:inset(50%);overflow:hidden;padding:0;border:0}
.sf-empty{padding:7px 20px;color:var(--ui-text-quaternary);font-size:11px}.sf-note{margin:5px 10px;padding:7px;border:1px solid var(--ui-stroke-secondary);border-radius:4px;font-size:11px;color:var(--ui-text-secondary)}
.sf-undo{display:flex;align-items:center;gap:6px}.sf-undo span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sf-group{padding:6px 12px 2px;font-size:10px;color:var(--ui-text-quaternary)}
.sf-menu{display:flex;flex-direction:column;gap:4px;padding:8px;min-width:200px;max-width:290px;color:var(--ui-text-primary)}.sf-menu button{justify-content:flex-start}.sf-menu-title{font-size:11px;color:var(--ui-text-tertiary);margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sf-menu label{font-size:11px}.sf-menu input{width:100%;background:var(--ui-bg-quaternary);color:var(--ui-text-primary);border:1px solid var(--ui-stroke-secondary);padding:5px}.sf-menu p{font-size:10px;color:var(--ui-text-tertiary);margin:4px 0}.sf-error{color:var(--ui-accent)}
.sf-project-choice{display:flex;align-items:center;gap:7px;min-width:0}
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
  return path ? h('svg', { viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true, 'data-provider-mark': slug }, h('path', { d: path })) : icon('HelpCircle', '?');
}
function projectMark(project) {
  const value = typeof project?.icon === 'string' ? project.icon.trim() : '';
  if (value && !/^[a-z][a-z0-9-]*$/.test(value)) return value;
  const name = value || (project?.is_home || project?.isNoProject ? 'home' : 'folder');
  return sdk.Codicon ? h(sdk.Codicon, { name, size: 13 }) : icon(name === 'home' ? 'House' : 'Folder', '◇');
}
function icon(name, fallback) {
  const local = { Archive: 'M3 3h18v4H3zM5 7v14h14V7M10 11h4', ArchiveRestore: 'M3 3h18v4H3zM5 7v14h14V7M12 17v-7M9 13l3-3 3 3', FolderPlus: 'M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2M12 10v7M8.5 13.5h7', SquarePen: 'M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7M10 14l1-4 9-9 3 3-9 9-4 1', ListFilter: 'M4 6h16M7 12h10M10 18h4' }[name];
  if (local) return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: local }));
  const Component = sdk.icons?.[name]; return Component ? h(Component, { size: 14, 'aria-hidden': true }) : h('span', { 'aria-hidden': true }, fallback);
}
function IconButton({ label, name, glyph, ...props }) { return h(sdk.Button, { type: 'button', variant: 'ghost', size: 'icon-xs', ...props, className: `sf-icon ${props.className || ''}`, 'aria-label': label, title: label }, icon(name, glyph)); }
function Note({ children, error = false }) { return h('div', { className: 'sf-note', role: error ? 'alert' : 'status' }, children); }
function Settings() {
  return h('section', { style: { padding: 20, maxWidth: 650, color: 'var(--ui-text-secondary)' } },
    h('h2', null, 'hermes-t3sidebar'), h('p', null, 'A compact T3-style session browser for the active source and profile.'),
    h('p', null, 'Archive and Unarchive change native Hermes archives and keep conversation history. Snoozes return when their chosen time passes; no agent is stopped or awakened, and no prompt is sent.'),
    h('p', null, 'Use normal layout controls to select hermes-t3sidebar in the left pane or hide the native Sessions pane. hermes-t3sidebar never modifies the core sidebar or conversation workspace.'),
    h('p', null, 'Project filtering changes this list only. New session asks for a named project before creating an empty session; Home creation is unavailable with the current public workspace contract.'),
    h('p', null, 'Keyboard: ↑/↓ or Home/End to focus rows; Enter to open; Shift+F10 for actions; Shift+Enter to archive and advance (only with confirmed idle status).'),
    h('p', null, 'Pins and snoozes belong to this plugin’s backend. Archived includes existing native archives, sorted by last activity, not archive time. Older plugin-only completed entries return to Ready; no history is automatically archived. Missing backend: browsing remains available, organization is read-only.'));
}
function RowActions({ row, scope, mutate, disabled, close, snoozeOnly = false }) {
  const [value, setValue] = useState(''), [error, setError] = useState('');
  const archived = row.archived === true, waiting = row.status !== 'idle', snoozeDisabled = waiting || archived;
  const run = payload => { void mutate(row, payload).then(ok => { if (ok) close(); }); };
  const action = (text, payload, extraDisabled = false) => h(sdk.Button, { key: text, type: 'button', variant: 'ghost', size: 'sm', disabled: disabled || extraDisabled,
    onClick: () => run(payload) }, text);
  return h('div', { className: 'sf-menu' }, h('div', { className: 'sf-menu-title' }, row.title || 'Untitled session'),
    !snoozeOnly ? action(row.meta.pinned ? 'Unpin' : 'Pin', { action: row.meta.pinned ? 'unpin' : 'pin' }) : null,
    !snoozeOnly && !archived && row.meta.state === 'snoozed' ? action('Restore to Ready', { action: 'restore' }) : null,
    !snoozeOnly ? action(archived ? 'Unarchive' : 'Archive', { action: archived ? 'unarchive' : 'archive' }, !archived && waiting) : null,
    !snoozeOnly && !archived ? action('Archive and advance', { action: 'archive', advance: true }, waiting) : null,
    ...snoozePresets().map(preset => action(`Snooze · ${preset.label}`, { action: 'snooze', wake_at: preset.wake_at }, snoozeDisabled)),
    h('label', null, 'Custom snooze · local time', h('input', { type: 'datetime-local', value, disabled: disabled || snoozeDisabled,
      'aria-label': 'Custom snooze date and time', onChange: event => { setValue(event.target.value); setError(''); } })),
    h(sdk.Button, { variant: 'ghost', size: 'sm', disabled: disabled || snoozeDisabled || !value, onClick: () => {
      try { const wake_at = parseLocalWake(value); setError(''); run({ action: 'snooze', wake_at }); } catch (e) { setError(e.message); }
    } }, 'Snooze until chosen time'),
    error ? h('div', { role: 'alert', className: 'sf-error' }, error) : null,
    waiting ? h('p', null, 'Archive and snooze require confirmed idle status. Waiting stays visible in Ready; Unarchive remains available.') : null,
    archived ? h('p', null, 'Unarchive before snoozing this conversation.') : null,
    h('p', null, 'History kept · never stops the agent.'));
}
function SessionRow({ row, active, controller, scope, mutate, disabled, onFocus, onNavigate, rowRef }) {
  const [menuOpen, setMenuOpen] = useState(false), [snoozeOpen, setSnoozeOpen] = useState(false), trigger = useRef(null);
  const attention = row.status === 'waiting';
  const open = () => Promise.resolve().then(() => controller.open(scope, row)).catch(error => host.notify({ kind: 'error', message: error.message }));
  const keyDown = event => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); setMenuOpen(true); }
    else if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); if (!disabled && (row.archived === true || row.status === 'idle')) void mutate(row, { action: row.archived === true ? 'unarchive' : 'archive', advance: row.archived !== true }); }
    else onNavigate(event, row.key);
  };
  return h('div', { className: 'sf-row', 'data-current': active, 'data-working': row.section === 'working', 'data-dimmed': ['working', 'snoozed', 'archived'].includes(row.section), 'data-session-id': row.key,
    onContextMenu: event => { event.preventDefault(); setMenuOpen(true); } },
    h('button', { type: 'button', className: 'sf-open', ref: rowRef, 'aria-current': active ? 'page' : undefined,
      'aria-label': `${row.title || 'Untitled session'}${attention ? ', waiting for approval or answer' : ''}${row.status === 'unknown' ? ', status unknown' : ''}`,
      onClick: open, onFocus: () => onFocus(row.key), onKeyDown: keyDown,
      title: [row.title, row.cwd, row.git_branch, row.status === 'waiting' ? 'Waiting for approval or answer' : row.status].filter(Boolean).join('\n') },
      h('span', { className: 'sf-card-meta' },
        h('span', { className: 'sf-project' },
          h('span', { className: 'sf-project-icon', 'aria-hidden': true, style: { color: row.project?.color || undefined } }, projectMark(row.project)),
          row.meta.pinned ? h('span', { className: 'sf-pin', 'aria-label': 'Pinned' }, icon('Pin', '♧')) : null,
          h('span', { className: 'sf-project-name' }, row.project?.name || 'Project unavailable')),
        attention || row.status === 'unknown' || row.woke || row.unread ? h('span', { className: 'sf-wait', role: 'img', 'aria-label': attention ? 'Waiting for approval or answer' : row.status === 'unknown' ? 'Status unknown' : row.woke ? 'Snooze ended' : 'Unread' }, attention ? 'Waiting' : row.status === 'unknown' ? '?' : row.woke ? 'Woke' : '•') : null,
        h('span', { className: 'sf-provider', role: 'img', 'aria-label': row.provider ? `Provider: ${row.provider}` : 'Provider unavailable', title: row.provider || 'Provider unavailable' }, providerMark(row.provider)),
        h('span', { className: 'sf-token', title: 'Total input and output tokens', 'aria-label': `Total tokens: ${compactTokens(row)}` }, compactTokens(row)),
        h('span', { className: 'sf-time' }, row.status === 'working' ? 'Working' : relative(row.activity))),
      h('span', { className: 'sf-row-title' }, row.title || 'Untitled session')),
    h('div', { className: 'sf-hover' },
      h(sdk.Popover, { open: snoozeOpen, onOpenChange: setSnoozeOpen },
        h(sdk.PopoverTrigger, { asChild: true }, h(IconButton, { label: 'Snooze session', name: 'Clock', glyph: '◷', disabled: disabled || row.status !== 'idle' || row.archived === true, 'aria-haspopup': 'dialog' })),
        h(sdk.PopoverContent, { align: 'start', side: 'right', style: { padding: 0 }, 'aria-label': 'Snooze session' },
          h(RowActions, { row, scope, mutate, disabled, snoozeOnly: true, close: () => setSnoozeOpen(false) }))),
      h(sdk.Button, { type: 'button', variant: 'ghost', size: 'xs', className: 'sf-icon sf-archive', 'aria-label': row.archived === true ? 'Unarchive session' : 'Archive session', disabled: disabled || (row.archived !== true && row.status !== 'idle'),
        onClick: () => void mutate(row, { action: row.archived === true ? 'unarchive' : 'archive' }) }, icon(row.archived === true ? 'ArchiveRestore' : 'Archive', '▤'), row.archived === true ? 'Unarchive' : 'Archive')),
    h(sdk.Popover, { open: menuOpen, onOpenChange: setMenuOpen },
      h(sdk.PopoverTrigger, { asChild: true }, h(IconButton, { ref: trigger, className: 'sf-context-trigger', label: `Actions for ${row.title || 'Untitled session'}`, name: 'Ellipsis', glyph: '…', 'aria-haspopup': 'dialog' })),
      h(sdk.PopoverContent, { align: 'start', side: 'right', style: { padding: 0 }, 'aria-label': 'Session actions' }, h(RowActions, { row, scope, mutate, disabled, close: () => setMenuOpen(false) }))));
}
export function HermesT3Sidebar({ ctx, controller }) {
  const connectionId = useValue(host.state.connectionId), profile = useValue(host.state.profile);
  useValue(host.state.gateway);
  useValue(activationEpoch);
  const scope = { connectionId, profile: profile || 'default', epoch: gatewayActivationEpoch() };
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
  const entries = projects.data?.projects || [];
  return h('div', { className: 'sf-menu', 'aria-label': 'Choose project for new session' },
    h('strong', null, 'New session in…'),
    h('p', null, 'Home remains listed, but detached Home creation is unavailable through the public SDK. Named project folders are supported.'),
    entries.length > 8 ? h('input', { type: 'search', 'aria-label': 'Search projects', placeholder: 'Search projects', value: query, onChange: event => setQuery(event.target.value) }) : null,
    projects.isLoading ? h('div', { role: 'status' }, 'Loading projects…') : null,
    projects.isError ? h('div', { role: 'alert' }, projects.error.message, h(sdk.Button, { onClick: () => projects.refetch() }, 'Retry projects')) : null,
    ...entries.filter(project => project.name.toLowerCase().includes(query.toLowerCase())).map(project => h(sdk.Button, { key: project.id, type: 'button', variant: 'ghost', className: 'sf-project-choice', disabled: busy, 'aria-label': `New session in ${project.name}`, onClick: () => void select(project) },
      h('span', { className: 'sf-project-icon', 'aria-hidden': true, style: { color: project.color || undefined } }, projectMark(project)), h('span', { className: 'sf-project-name' }, project.name))),
    busy ? h('div', { role: 'status' }, 'Creating session…') : null,
    error ? h('div', { role: 'alert' }, error) : null,
    h(sdk.Button, { type: 'button', variant: 'ghost', onClick: close }, 'Cancel'));
}
function ScopedSidebar({ ctx, controller, scope }) {
  const client = useQueryClient(), activeId = useValue(host.state.focusedStoredSessionId), activeOwner = useValue(host.state.focusedSessionOwner);
  const [query, setQuery] = useState(''), [project, setProject] = useState('*'), [grouped, setGrouped] = useState(false), [filterOpen, setFilterOpen] = useState(false), [pickerOpen, setPickerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState({}), [limit, setLimit] = useState(0), [archiveLimit, setArchiveLimit] = useState(0), [undo, setUndo] = useState(null), [actionError, setActionError] = useState('');
  const search = useRef(null), rowRefs = useRef(new Map()), focused = useRef(null), latest = useRef(null);
  const key = scopeKey(scope);
  const mutation = useMutation({ mutationFn: async ({ id, payload }) => controller.mutate(scope, id, payload) });
  const opts = { refetchInterval: 5000, staleTime: 2000, retry: false };
  const sessions = useQuery({ ...opts, queryKey: [...key, 'sessions'], queryFn: () => controller.list(scope) });
  const runtime = useQuery({ ...opts, queryKey: [...key, 'runtime'], queryFn: () => controller.runtime(scope) });
  const metadata = useQuery({ ...opts, queryKey: [...key, 'metadata'], queryFn: () => controller.metadata(scope), enabled: !mutation.isPending });
  const expanded = useQuery({ ...opts, staleTime: Infinity, refetchInterval: false, queryKey: [...key, 'expanded', limit], enabled: limit > 0, queryFn: () => controller.expanded(scope, limit) });
  const archives = useQuery({ ...opts, queryKey: [...key, 'archives', archiveLimit], queryFn: () => controller.archives(scope, archiveLimit) });
  const live = runtime.isError ? [] : runtime.data?.sessions || [];
  const rows = mergeRows(sessions.data?.sessions || [], sessions.data?.capped ? [] : expanded.data?.sessions || [], live, true, archives.isError ? [] : archives.data?.sessions || []);
  const runtimeKnown = !!runtime.data && !runtime.isError;
  const sections = buildSections(rows, metadata.data || EMPTY_STATE, live, { runtimeKnown, query, project });
  const searching = !!query.trim();
  const visible = SECTIONS.flatMap(section => collapsed[section] && !searching && !(section === 'active' && sections.active.some(row => row.status === 'waiting' || row.status === 'unknown')) ? [] : sections[section]);
  const projects = [...new Set(rows.filter(row => !row._limited).map(row => row.cwd || ''))].sort();
  latest.current = { rows, sections, visible, metadata: metadata.data, disabled: !metadata.data || metadata.isError || sessions.data?.capped || !archives.data || archives.isError || mutation.isPending };
  const refresh = () => { try { controller.check(scope); void client.invalidateQueries({ queryKey: key }); } catch (_) { /* old pane */ } };
  const mutate = async (row, input, isUndo = false) => {
    try {
      controller.check(scope);
      if (latest.current.disabled) throw new Error('hermes-t3sidebar backend unavailable or another change is saving.');
      const { advance, ...payload } = input;
      const before = latest.current.metadata.sessions[row.key] || { state: 'active', pinned: false };
      if (!isUndo && ['archive', 'snooze'].includes(payload.action) && row.status !== 'idle') throw new Error('Archive and snooze require confirmed idle status.');
      if (row._liveOnly) throw new Error('This session has no confirmed stored history yet.');
      setActionError('');
      const result = await mutation.mutateAsync({ id: row.key, payload }); controller.check(scope);
      const native = payload.action === 'archive' || payload.action === 'unarchive';
      if (!isUndo) setUndo({ row, payload: native ? { action: result.before ? 'archive' : 'unarchive', restoreMetadata: before } : inverseAction(payload.action, before), label: payload.action === 'archive' ? 'Archived' : payload.action === 'unarchive' ? 'Unarchived' : payload.action === 'snooze' ? 'Snoozed' : payload.action === 'restore' ? 'Restored' : payload.action === 'pin' ? 'Pinned' : 'Unpinned' });
      else setUndo(null);
      if (advance) {
        const next = [...latest.current.sections.active, ...latest.current.sections.pinned].find(item => item.key !== row.key && latest.current.visible.some(visible => visible.key === item.key));
        if (next) await controller.open(scope, next); else await controller.newChat(scope);
      }
      return true;
    } catch (error) { if (sameScope(scope, captureScope())) setActionError(error.message); return false; }
  };
  const navigate = (event, id) => {
    const keys = latest.current.visible.map(row => row.key), index = keys.indexOf(id);
    let target;
    if (event.key === 'ArrowDown') target = keys[Math.min(keys.length - 1, index + 1)];
    if (event.key === 'ArrowUp') target = keys[Math.max(0, index - 1)];
    if (event.key === 'Home') target = keys[0];
    if (event.key === 'End') target = keys.at(-1);
    if (target) { event.preventDefault(); const element = rowRefs.current.get(target); element?.focus({ preventScroll: true }); const body = element?.closest('.sf-section-body'); if (body) { const r = element.getBoundingClientRect(), b = body.getBoundingClientRect(); if (r.top < b.top) body.scrollTop -= b.top - r.top; else if (r.bottom > b.bottom) body.scrollTop += r.bottom - b.bottom; } }
  };
  useEffect(() => {
    if (focused.current && !visible.some(row => row.key === focused.current)) { focused.current = visible[0]?.key; rowRefs.current.get(focused.current)?.focus(); }
  });
  const renderRow = row => h(SessionRow, { key: row.key, row, scope, controller, mutate, disabled: latest.current.disabled || row._liveOnly,
    active: activeOwner?.connectionId === (scope.connectionId ?? 'local') && activeOwner?.profile === scope.profile && aliases(row).includes(activeId), onFocus: id => { focused.current = id; }, onNavigate: navigate,
    rowRef: element => { if (element) rowRefs.current.set(row.key, element); else rowRefs.current.delete(row.key); } });
  const renderSection = section => {
    const entries = sections[section], force = searching || section === 'active' && entries.some(row => ['waiting', 'unknown'].includes(row.status));
    const closed = !!collapsed[section] && !force;
    const items = grouped ? [...Map.groupBy(entries, row => row.cwd || (row._limited ? 'Project unavailable' : 'No project'))].flatMap(([cwd, entries]) => [h('div', { className: 'sf-group', key: `project:${cwd}`, title: cwd }, cwd.split(/[\\/]/).filter(Boolean).pop() || cwd), ...entries.map(renderRow)]) : entries.map(renderRow);
    const headerless = section === 'active' || section === 'pinned';
    if (section === 'pinned' && !entries.length) return null;
    return h('section', { key: section, className: 'sf-section', 'aria-label': LABELS[section], 'data-section': section, 'data-populated': entries.length > 0, 'data-closed': closed },
      !headerless ? h('button', { type: 'button', className: 'sf-section-toggle', 'aria-expanded': !closed, 'aria-label': `${LABELS[section]} (${entries.length})`,
        onClick: () => setCollapsed(previous => ({ ...previous, [section]: !previous[section] })) }, icon(closed ? 'ChevronRight' : 'ChevronDown', closed ? '›' : '⌄'), LABELS[section], h('span', { className: 'sf-count' }, entries.length)) : null,
      !closed ? h('div', { className: 'sf-section-body', 'aria-label': `${section === 'active' ? 'Ready' : LABELS[section]} sessions`, tabIndex: -1 },
        section === 'archived' && archives.isError ? h('div', { className: 'sf-empty', role: 'alert' }, `Archives unavailable: ${archives.error.message}`) : entries.length ? items : h('div', { className: 'sf-empty' }, section === 'active' ? 'All caught up' : section === 'archived' && archives.isLoading ? 'Loading archives…' : 'No sessions'),
        section === 'archived' && !archives.isError && archives.data?.has_more ? h(sdk.Button, { variant: 'ghost', size: 'xs', disabled: archives.isFetching, onClick: () => setArchiveLimit(previous => previous + 1) }, 'Browse older archives') : null) : null);

  };
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
      h('div', { className: 'sf-search' }, icon('Search', '⌕'), h('input', { ref: search, type: 'search', placeholder: 'Search', 'aria-label': 'Search sessions', value: query, onChange: event => setQuery(event.target.value) })),
      h(sdk.Popover, { open: filterOpen, onOpenChange: setFilterOpen },
        h(sdk.PopoverTrigger, { asChild: true }, h(IconButton, { label: 'Filter sessions', name: 'ListFilter', glyph: '≡' })),
        h(sdk.PopoverContent, { align: 'end', 'aria-label': 'Session filters' }, h('div', { className: 'sf-menu' },
          h('select', { 'aria-label': 'Filter by project', value: project, onChange: event => setProject(event.target.value) }, h('option', { value: '*' }, 'All projects'), ...projects.map(cwd => h('option', { key: cwd, value: cwd }, cwd || 'No project'))),
          h(sdk.Button, { variant: 'ghost', 'aria-label': grouped ? 'Use flat list' : 'Group by project', 'aria-pressed': grouped, onClick: () => setGrouped(value => !value) }, grouped ? 'Use flat list' : 'Group by project'),
          h(sdk.Button, { variant: 'ghost', onClick: refresh, 'aria-label': 'Refresh sessions' }, 'Refresh sessions')))),
      h(IconButton, { label: 'Add project', name: 'FolderPlus', glyph: '+', onClick: () => { void Promise.resolve().then(() => controller.openProjects(scope)).catch(error => { if (sameScope(scope, captureScope())) setActionError(error.message); }); } }),
      h(sdk.Popover, { open: pickerOpen, onOpenChange: setPickerOpen },
        h(sdk.PopoverTrigger, { asChild: true }, h(IconButton, { label: 'New session', name: 'SquarePen', glyph: '+' })),
        h(sdk.PopoverContent, { align: 'end', 'aria-label': 'New session project' }, pickerOpen ? h(ProjectPicker, { controller, scope, close: () => setPickerOpen(false) }) : null))),
    sessions.isLoading ? h(Note, null, 'Loading sessions…') : null,
    sessions.isError ? h(Note, { error: true }, `Session list failed: ${sessions.error.message} `, h(sdk.Button, { variant: 'ghost', size: 'xs', onClick: refresh }, 'Retry')) : null,
    !runtimeKnown ? h(Note, { error: runtime.isError }, runtime.isError ? `Runtime status unavailable: ${runtime.error.message}. Native archives remain Archived; other sessions stay accessible in Ready.` : 'Checking runtime status…') : null,
    metadata.isError ? h(Note, { error: true }, `hermes-t3sidebar backend unavailable: ${metadata.error.message}. Read-only browsing; no local metadata fallback. `, h(sdk.Button, { variant: 'ghost', size: 'xs', onClick: refresh }, 'Retry')) : null,
    expanded.isError ? h(Note, { error: true }, `Older sessions could not load: ${expanded.error.message}`) : null,
    actionError ? h(Note, { error: true }, actionError) : null,
    h('div', { className: 'sf-scroll' }, ...SECTIONS.map(renderSection),
      !visible.length && (query || project !== '*') ? h('div', { className: 'sf-empty' }, 'No matching sessions') : null),
    sessions.data?.capped ? h(Note, null, `Companion session listing unavailable. Read-only SDK browsing${fallbackCount}; older organized sessions cannot be recovered until the companion returns.`) : null,
    canExpand ? h(Note, null, h(sdk.Button, { variant: 'ghost', size: 'xs', disabled: expanded.isFetching, onClick: () => setLimit(previous => previous + 1) }, 'Browse older sessions')) : null,
    undo ? h('div', { className: 'sf-note sf-undo', role: 'status' }, h('span', null, `${undo.label} · ${undo.row.title || 'session'}`), h(sdk.Button, { variant: 'ghost', size: 'xs', disabled: latest.current.disabled, onClick: () => void mutate(undo.row, undo.payload, true) }, 'Undo'), h(IconButton, { label: 'Dismiss undo', name: 'X', glyph: '×', onClick: () => setUndo(null) })) : null,
    null);
}
export default {
  id: 'hermes-t3sidebar', name: 'hermes-t3sidebar', defaultEnabled: false,
  register(ctx) {
    const controller = createController(ctx);
    ctx.register({ id: 'sidebar', area: 'panes', title: 'hermes-t3sidebar', order: 0,
      data: { placement: 'left', width: '290px' }, render: () => h(HermesT3Sidebar, { ctx, controller }) });
    ctx.registerSettingsPage({ id: 'settings', title: 'hermes-t3sidebar', icon: 'list-tree', render: () => h(Settings) });
    const disposeEvent = ctx.onEvent('*', event => {
      activationEpoch.set(gatewayActivationEpoch());
      if (/^(session\.|gateway\.|approval\.|question\.|server_request\.|message\.complete)/.test(event.type || '')) {
        void queryClient.invalidateQueries({ queryKey: scopeKey(captureScope()) });
      }
    });
    ctx.onDispose(() => { controller.dispose(); disposeEvent(); void queryClient.cancelQueries({ queryKey: ['hermes-t3sidebar'] }); queryClient.removeQueries({ queryKey: ['hermes-t3sidebar'] }); });
  }
};
