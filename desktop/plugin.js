// Session Flow — independent T3-inspired session browser; plain disk-plugin ESM.
import * as sdk from '@hermes/plugin-sdk';
import { createElement as h, useEffect, useRef, useState } from 'react';

const { host, useValue, useQuery, useMutation, useQueryClient, queryClient, gatewayActivationEpoch } = sdk;
export const SECTIONS = ['active', 'pinned', 'working', 'snoozed', 'settled'];
const LABELS = { active: 'Active', pinned: 'Pinned', working: 'Working', snoozed: 'Snoozed', settled: 'Recently Settled' };
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
export function scopeKey(scope) { return ['session-flow', scope.connectionId, scope.profile, scope.epoch]; }
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
  if (value?.version !== 1 || !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions)) throw new Error('Unsupported Session Flow backend response.');
  for (const item of Object.values(value.sessions)) {
    if (!item || !['active', 'settled', 'snoozed'].includes(item.state) || typeof item.pinned !== 'boolean' ||
      (item.state === 'snoozed' && !(Number.isFinite(item.wake_at) && item.wake_at > 0))) throw new Error('Invalid Session Flow metadata.');
  }
  return value;
}
export function mergeRows(rich, extra = [], live = [], extraRich = false) {
  const rows = new Map();
  for (const row of [...extra.map(r => ({ ...r, _limited: !extraRich })), ...rich.map(r => ({ ...r, _limited: false }))]) {
    const key = durableId(row), previous = rows.get(key);
    if (!key) continue;
    rows.set(key, { ...previous, ...row, _lineage_ids: [...new Set([...(previous ? aliases(previous) : []), ...aliases(row)])] });
  }
  const known = new Set([...rows.values()].flatMap(aliases));
  for (const item of live) {
    if (!item.session_key || known.has(item.session_key)) continue;
    const row = { id: item.session_key, title: item.title, last_active: item.last_active, _limited: true, _liveOnly: true };
    rows.set(row.id, row); known.add(row.id);
  }
  return [...rows.values()];
}
export function buildSections(rows, metadata, live, { now = Date.now() / 1000, runtimeKnown = true, query = '', project = '*' } = {}) {
  const result = Object.fromEntries(SECTIONS.map(section => [section, []]));
  for (const row of rows) {
    const meta = metadata.sessions[durableId(row)] || { state: 'active', pinned: false };
    const ids = new Set(aliases(row));
    const matches = live.filter(item => ids.has(item.session_key) || ids.has(item.id));
    // Waiting wins over every metadata shelf and working signal, across the entire lineage.
    const status = !runtimeKnown ? 'unknown' : matches.some(i => i.status === 'waiting') ? 'waiting'
      : matches.some(i => i.status === 'working' || i.status === 'starting') ? 'working'
      : matches.some(i => !['idle', 'working', 'starting', 'waiting'].includes(i.status)) ? 'unknown' : 'idle';
    const woke = meta.state === 'snoozed' && meta.wake_at <= now;
    const section = status === 'waiting' || status === 'unknown' ? 'active'
      : meta.state === 'snoozed' && !woke ? 'snoozed'
      : meta.state === 'settled' ? 'settled'
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
    const delta = section === 'settled' ? (b.meta.settled_at || 0) - (a.meta.settled_at || 0)
      : section === 'snoozed' ? a.meta.wake_at - b.meta.wake_at : b.activity - a.activity;
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
  return {
    dispose() { disposed = true; generation++; }, check,
    async list(scope) {
      const route = await routeFor(scope);
      try {
        return qualified(await fenced(scope, () => ctx.rest('/sessions?offset=0&limit=500')), scope, route);
      } catch (error) {
        check(scope);
        const value = await fenced(scope, () => env.host.listPersistedSessions(route, { profile: route?.targetProfile || scope.profile, limit: 500 }));
        return { ...value, capped: true, companionError: error.message };
      }
    },
    async runtime(scope) {
      const route = await routeFor(scope);
      return qualified(await fenced(scope, () => ctx.rest('/runtime')), scope, route);
    },
    async expanded(scope, pages) {
      const route = await routeFor(scope), sessions = [];
      let has_more = true;
      for (let page = 1; page <= pages && has_more; page++) {
        const offset = page * 500;
        const value = await fenced(scope, () => client.fetchQuery({ queryKey: [...scopeKey(scope), 'page', offset], staleTime: Infinity,
          queryFn: async () => qualified(await fenced(scope, () => ctx.rest(`/sessions?offset=${offset}&limit=500`)), scope, route) }));
        sessions.push(...value.sessions); has_more = value.has_more;
      }
      return { sessions, has_more };
    },
    async metadata(scope) {
      if (writing) throw new Error('Session Flow is saving a change.');
      const ticket = generation;
      const value = await fenced(scope, () => ctx.rest('/state'));
      if (ticket !== generation) throw new Error('Superseded metadata read.');
      return validState(value);
    },
    async mutate(scope, id, payload) {
      check(scope);
      if (writing) throw new Error('Another Session Flow change is still saving.');
      writing = true; generation++;
      const key = [...scopeKey(scope), 'metadata'];
      try {
        await client.cancelQueries({ queryKey: key, exact: true }); check(scope);
        await fenced(scope, () => ctx.rest(`/sessions/${encodeURIComponent(id)}`, { method: 'POST', body: payload }));
        const value = verifyAction(validState(await fenced(scope, () => ctx.rest('/state'))), id, payload);
        await client.cancelQueries({ queryKey: key, exact: true }); check(scope);
        client.setQueryData(key, value);
        return value;
      } finally {
        writing = false;
        if (!disposed && sameScope(scope, env.capture())) void client.invalidateQueries({ queryKey: key, exact: true });
      }
    },
    async open(scope, row) {
      const route = await routeFor(scope); check(scope);
      return env.host.openSession(row.resolved_id || row.id, { route, profile: route?.profile || scope.profile, intent: 'in-place' });
    },
    async newChat(scope) { const route = await routeFor(scope); check(scope); return env.host.newChat(route); }
  };
}

const CSS = `
.sf{display:flex;flex-direction:column;height:100%;min-height:0;min-width:220px;font:12px/1.4 var(--font-sans,inherit);color:var(--ui-text-primary)}
.sf *{box-sizing:border-box}.sf button,.sf input,.sf select{font:inherit}.sf button{cursor:pointer}.sf button:disabled{cursor:default;opacity:.4}
.sf button:focus-visible,.sf input:focus-visible,.sf select:focus-visible{outline:2px solid var(--ui-accent);outline-offset:-2px}
.sf-header{padding:10px 10px 6px;display:flex;align-items:center;gap:6px}.sf-title{font-weight:600;flex:1;letter-spacing:-.02em}.sf-icon{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:4px;border:0;border-radius:4px;color:var(--ui-text-tertiary);background:transparent}
.sf-icon:hover,.sf-row:hover,.sf-row:focus-within,.sf-section-toggle:hover{background:var(--chrome-action-hover,var(--ui-bg-quaternary));color:var(--ui-text-primary)}
.sf-search{display:flex;align-items:center;gap:5px;margin:0 10px 7px;padding:5px 7px;border:1px solid var(--ui-stroke-secondary);border-radius:5px;color:var(--ui-text-tertiary)}
.sf-search input{width:100%;min-width:0;padding:0;border:0;background:transparent;color:var(--ui-text-primary);outline:none}
.sf-tools{display:flex;align-items:center;gap:6px;padding:0 10px 7px}.sf-tools select{flex:1;min-width:0;max-width:100%;border:0;background:var(--ui-bg-quaternary);color:var(--ui-text-secondary);padding:4px;border-radius:3px}
.sf-scope{padding:0 12px 8px;color:var(--ui-text-quaternary);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sf-scroll{overflow:auto;flex:1;min-height:0;display:flex;flex-direction:column;padding:0 6px 8px}.sf-shelf-start{margin-top:auto;padding-top:14px}
.sf-section{flex-shrink:0}.sf-section-toggle{display:flex;align-items:center;gap:5px;width:100%;padding:8px 6px 5px;border:0;background:transparent;color:var(--ui-text-tertiary);font-size:11px;text-align:left}.sf-count{margin-left:auto;color:var(--ui-text-quaternary);font-variant-numeric:tabular-nums}
.sf-row{display:flex;align-items:center;position:relative;gap:6px;min-height:36px;padding:0 4px 0 6px;border-radius:5px}.sf-row[data-current=true]{background:var(--ui-bg-quaternary);box-shadow:inset 2px 0 var(--ui-accent)}
.sf-row[data-working=true]{opacity:.55}.sf-row[data-working=true]:hover,.sf-row[data-working=true]:focus-within{opacity:1}
.sf-open{display:flex;align-items:center;gap:7px;flex:1;min-width:0;align-self:stretch;padding:5px 0;border:0;background:transparent;text-align:left;color:inherit}.sf-row-text{min-width:0;flex:1}.sf-row-title{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sf-row-detail{display:block;font-size:10px;color:var(--ui-text-quaternary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sf-status{flex-shrink:0;width:13px;display:flex;color:var(--ui-text-quaternary)}.sf-status[data-attention=true],.sf-wait{color:var(--ui-accent)}.sf-wait{font-size:10px;white-space:nowrap}.sf-time{color:var(--ui-text-quaternary);font-size:10px;white-space:nowrap;font-variant-numeric:tabular-nums}.sf-hover{display:flex;gap:0}.sf-hover .sf-icon{width:22px;height:25px}
@media (hover:hover){.sf-hover{display:none}.sf-row:hover .sf-hover,.sf-row:focus-within .sf-hover{display:flex}.sf-row:hover .sf-time,.sf-row:focus-within .sf-time{display:none}}
.sf-empty{padding:7px 20px;color:var(--ui-text-quaternary);font-size:11px}.sf-note{margin:5px 10px;padding:7px;border:1px solid var(--ui-stroke-secondary);border-radius:4px;font-size:11px;color:var(--ui-text-secondary)}
.sf-footer{padding:7px 10px;border-top:1px solid var(--ui-stroke-secondary);color:var(--ui-text-quaternary);font-size:10px}.sf-undo{display:flex;align-items:center;gap:6px}.sf-undo span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sf-group{padding:6px 12px 2px;font-size:10px;color:var(--ui-text-quaternary)}
.sf-menu{display:flex;flex-direction:column;gap:4px;padding:8px;min-width:200px;max-width:290px;color:var(--ui-text-primary)}.sf-menu button{justify-content:flex-start}.sf-menu-title{font-size:11px;color:var(--ui-text-tertiary);margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sf-menu label{font-size:11px}.sf-menu input{width:100%;background:var(--ui-bg-quaternary);color:var(--ui-text-primary);border:1px solid var(--ui-stroke-secondary);padding:5px}.sf-menu p{font-size:10px;color:var(--ui-text-tertiary);margin:4px 0}.sf-error{color:var(--ui-accent)}
`;
function icon(name, fallback) { const Component = sdk.icons?.[name]; return Component ? h(Component, { size: 14, 'aria-hidden': true }) : h('span', { 'aria-hidden': true }, fallback); }
function IconButton({ label, name, glyph, ...props }) { return h(sdk.Button, { type: 'button', variant: 'ghost', size: 'icon-xs', ...props, className: `sf-icon ${props.className || ''}`, 'aria-label': label, title: label }, icon(name, glyph)); }
function Note({ children, error = false }) { return h('div', { className: 'sf-note', role: error ? 'alert' : 'status' }, children); }
function Settings() {
  return h('section', { style: { padding: 20, maxWidth: 650, color: 'var(--ui-text-secondary)' } },
    h('h2', null, 'Session Flow'), h('p', null, 'A compact T3-style session browser for the active source and profile.'),
    h('p', null, 'Settle and snooze organize the list only. They do not archive, delete, stop, resume or send a prompt. Snoozes return when their chosen time passes; no agent is awakened.'),
    h('p', null, 'Use normal layout controls to select Session Flow in the left pane or hide the native Sessions pane. Session Flow never modifies the core sidebar or conversation workspace.'),
    h('p', null, 'Project filtering changes this list only. New session uses Hermes’ native new-chat flow; the SDK does not expose a pre-send draft project selector.'),
    h('p', null, 'Keyboard: ↑/↓ or Home/End to focus rows; Enter to open; Shift+F10 for actions; Shift+Enter to settle and advance (when no approval is pending).'),
    h('p', null, 'Pins, settlement and snoozes belong to this plugin’s backend, not native archival or native pins. Missing backend: browsing remains available, organization is read-only.'));
}
function RowActions({ row, scope, mutate, disabled, close }) {
  const [value, setValue] = useState(''), [error, setError] = useState('');
  const waiting = row.status === 'waiting' || row.status === 'unknown';
  const run = payload => { void mutate(row, payload).then(ok => { if (ok) close(); }); };
  const action = (text, payload, extraDisabled = false) => h(sdk.Button, { key: text, type: 'button', variant: 'ghost', size: 'sm', disabled: disabled || extraDisabled,
    onClick: () => run(payload) }, text);
  return h('div', { className: 'sf-menu' }, h('div', { className: 'sf-menu-title' }, row.title || 'Untitled session'),
    action(row.meta.pinned ? 'Unpin' : 'Pin', { action: row.meta.pinned ? 'unpin' : 'pin' }),
    row.meta.state !== 'active' ? action('Restore to Active', { action: 'restore' }) : null,
    row.section !== 'settled' ? action('Settle', { action: 'settle' }, waiting) : null,
    row.section !== 'settled' ? action('Settle and advance', { action: 'settle', advance: true }, waiting) : null,
    ...snoozePresets().map(preset => action(`Snooze · ${preset.label}`, { action: 'snooze', wake_at: preset.wake_at }, waiting)),
    h('label', null, 'Custom snooze · local time', h('input', { type: 'datetime-local', value, disabled: disabled || waiting,
      'aria-label': 'Custom snooze date and time', onChange: event => { setValue(event.target.value); setError(''); } })),
    h(sdk.Button, { variant: 'ghost', size: 'sm', disabled: disabled || waiting || !value, onClick: () => {
      try { const wake_at = parseLocalWake(value); setError(''); run({ action: 'snooze', wake_at }); } catch (e) { setError(e.message); }
    } }, 'Snooze until chosen time'),
    error ? h('div', { role: 'alert', className: 'sf-error' }, error) : null,
    waiting ? h('p', null, 'Waiting or unknown runtime status stays visible in Active. Settle and snooze are unavailable until status is known.') : null,
    h('p', null, 'Organization only · never stops the agent.'));
}
function SessionRow({ row, active, controller, scope, mutate, disabled, onFocus, onNavigate, rowRef, detail }) {
  const [menuOpen, setMenuOpen] = useState(false), trigger = useRef(null);
  const attention = row.status === 'waiting';
  const open = () => Promise.resolve().then(() => controller.open(scope, row)).catch(error => host.notify({ kind: 'error', message: error.message }));
  const keyDown = event => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); setMenuOpen(true); }
    else if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); if (!disabled && row.status !== 'waiting' && row.status !== 'unknown') void mutate(row, { action: 'settle', advance: true }); }
    else onNavigate(event, row.key);
  };
  return h('div', { className: 'sf-row', 'data-current': active, 'data-working': row.section === 'working', 'data-session-id': row.key,
    onContextMenu: event => { event.preventDefault(); setMenuOpen(true); } },
    h('button', { type: 'button', className: 'sf-open', ref: rowRef, 'aria-current': active ? 'page' : undefined,
      'aria-label': `${row.title || 'Untitled session'}${attention ? ', waiting for approval or answer' : ''}${row.status === 'unknown' ? ', status unknown' : ''}`,
      onClick: open, onFocus: () => onFocus(row.key), onKeyDown: keyDown,
      title: [row.title, row.cwd, row.git_branch, row.status === 'waiting' ? 'Waiting for approval or answer' : row.status].filter(Boolean).join('\n') },
      h('span', { className: 'sf-status', 'data-attention': attention }, icon(attention ? 'CircleHelp' : row.status === 'unknown' ? 'CircleHelp' : row.section === 'working' ? 'LoaderCircle' : row.section === 'snoozed' ? 'AlarmClock' : row.section === 'settled' ? 'CircleCheck' : row.meta.pinned ? 'Pin' : 'MessageSquare', attention ? '!' : '·')),
      h('span', { className: 'sf-row-text' }, h('span', { className: 'sf-row-title' }, row.title || 'Untitled session'),
        detail ? h('span', { className: 'sf-row-detail' }, row.cwd ? `${row.cwd.split(/[\\/]/).filter(Boolean).pop()}${row.git_branch ? ` · ${row.git_branch}` : ''}` : row._limited ? 'Project unavailable' : 'No project') : null),
      attention ? h('span', { className: 'sf-wait' }, 'Waiting') : row.status === 'unknown' ? h('span', { className: 'sf-wait' }, '?') : row.woke ? h('span', { className: 'sf-wait' }, 'Woke') : row.unread ? h('span', { className: 'sf-wait', 'aria-label': 'Unread' }, '•') : null),
    h('span', { className: 'sf-time', title: row.section === 'snoozed' ? new Date(row.meta.wake_at * 1000).toLocaleString() : undefined }, relative(row.section === 'snoozed' ? row.meta.wake_at : row.section === 'settled' ? row.meta.settled_at : row.activity)),
    h('div', { className: 'sf-hover' }, h(IconButton, { label: row.meta.state !== 'active' ? 'Restore session' : 'Settle session', name: row.meta.state !== 'active' ? 'Undo2' : 'Check', glyph: '✓', disabled: disabled || (row.meta.state === 'active' && ['waiting', 'unknown'].includes(row.status)),
      onClick: () => void mutate(row, { action: row.meta.state !== 'active' ? 'restore' : 'settle' }) })),
    h(sdk.Popover, { open: menuOpen, onOpenChange: setMenuOpen },
      h(sdk.PopoverTrigger, { asChild: true }, h(IconButton, { ref: trigger, label: `Actions for ${row.title || 'Untitled session'}`, name: 'Ellipsis', glyph: '…', 'aria-haspopup': 'dialog' })),
      h(sdk.PopoverContent, { align: 'start', side: 'right', style: { padding: 0 }, 'aria-label': 'Session actions' }, h(RowActions, { row, scope, mutate, disabled, close: () => setMenuOpen(false) }))));
}
export function SessionFlow({ ctx, controller }) {
  const connectionId = useValue(host.state.connectionId), profile = useValue(host.state.profile);
  useValue(host.state.gateway);
  useValue(activationEpoch);
  const scope = { connectionId, profile: profile || 'default', epoch: gatewayActivationEpoch() };
  return h(ScopedSidebar, { key: JSON.stringify(scopeKey(scope)), scope, controller, ctx });
}
function ScopedSidebar({ ctx, controller, scope }) {
  const client = useQueryClient(), activeId = useValue(host.state.focusedStoredSessionId), activeOwner = useValue(host.state.focusedSessionOwner);
  const [query, setQuery] = useState(''), [project, setProject] = useState('*'), [grouped, setGrouped] = useState(false), [detail, setDetail] = useState(false);
  const [collapsed, setCollapsed] = useState({}), [limit, setLimit] = useState(0), [undo, setUndo] = useState(null), [actionError, setActionError] = useState('');
  const search = useRef(null), rowRefs = useRef(new Map()), focused = useRef(null), latest = useRef(null);
  const key = scopeKey(scope);
  const mutation = useMutation({ mutationFn: async ({ id, payload }) => controller.mutate(scope, id, payload) });
  const opts = { refetchInterval: 5000, staleTime: 2000, retry: false };
  const sessions = useQuery({ ...opts, queryKey: [...key, 'sessions'], queryFn: () => controller.list(scope) });
  const runtime = useQuery({ ...opts, queryKey: [...key, 'runtime'], queryFn: () => controller.runtime(scope) });
  const metadata = useQuery({ ...opts, queryKey: [...key, 'metadata'], queryFn: () => controller.metadata(scope), enabled: !mutation.isPending });
  const expanded = useQuery({ ...opts, staleTime: Infinity, refetchInterval: false, queryKey: [...key, 'expanded', limit], enabled: limit > 0, queryFn: () => controller.expanded(scope, limit) });
  const live = runtime.isError ? [] : runtime.data?.sessions || [];
  const rows = mergeRows(sessions.data?.sessions || [], sessions.data?.capped ? [] : expanded.data?.sessions || [], live, true);
  const runtimeKnown = !!runtime.data && !runtime.isError;
  const sections = buildSections(rows, metadata.data || EMPTY_STATE, live, { runtimeKnown, query, project });
  const searching = !!query.trim();
  const visible = SECTIONS.flatMap(section => collapsed[section] && !searching && !(section === 'active' && sections.active.some(row => row.status === 'waiting' || row.status === 'unknown')) ? [] : sections[section]);
  const projects = [...new Set(rows.filter(row => !row._limited).map(row => row.cwd || ''))].sort();
  latest.current = { rows, sections, visible, metadata: metadata.data, disabled: !metadata.data || metadata.isError || sessions.data?.capped || mutation.isPending };
  const refresh = () => { try { controller.check(scope); void client.invalidateQueries({ queryKey: key }); } catch (_) { /* old pane */ } };
  const mutate = async (row, input, isUndo = false) => {
    try {
      controller.check(scope);
      if (latest.current.disabled) throw new Error('Session Flow backend unavailable or another change is saving.');
      const { advance, ...payload } = input;
      const before = latest.current.metadata.sessions[row.key] || { state: 'active', pinned: false };
      setActionError('');
      await mutation.mutateAsync({ id: row.key, payload }); controller.check(scope);
      if (!isUndo) setUndo({ row, payload: inverseAction(payload.action, before), label: payload.action === 'settle' ? 'Settled' : payload.action === 'snooze' ? 'Snoozed' : payload.action === 'restore' ? 'Restored' : payload.action === 'pin' ? 'Pinned' : 'Unpinned' });
      else setUndo(null);
      if (advance) {
        const next = latest.current.visible.find(item => item.key !== row.key && (item.section === 'active' || item.section === 'pinned'));
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
    if (target) { event.preventDefault(); rowRefs.current.get(target)?.focus(); }
  };
  useEffect(() => {
    if (focused.current && !visible.some(row => row.key === focused.current)) { focused.current = visible[0]?.key; rowRefs.current.get(focused.current)?.focus(); }
  });
  const renderRow = row => h(SessionRow, { key: row.key, row, scope, controller, mutate, disabled: latest.current.disabled || row._liveOnly,
    active: activeOwner?.connectionId === (scope.connectionId ?? 'local') && activeOwner?.profile === scope.profile && aliases(row).includes(activeId), detail, onFocus: id => { focused.current = id; }, onNavigate: navigate,
    rowRef: element => { if (element) rowRefs.current.set(row.key, element); else rowRefs.current.delete(row.key); } });
  const renderSection = section => {
    const entries = sections[section], force = searching || section === 'active' && entries.some(row => ['waiting', 'unknown'].includes(row.status));
    const closed = !!collapsed[section] && !force;
    const items = grouped ? [...Map.groupBy(entries, row => row.cwd || (row._limited ? 'Project unavailable' : 'No project'))].flatMap(([cwd, entries]) => [h('div', { className: 'sf-group', key: `project:${cwd}`, title: cwd }, cwd.split(/[\\/]/).filter(Boolean).pop() || cwd), ...entries.map(renderRow)]) : entries.map(renderRow);
    return h('section', { key: section, className: `sf-section ${section === 'working' ? 'sf-shelf-start' : ''}`, 'aria-label': LABELS[section] },
      h('button', { type: 'button', className: 'sf-section-toggle', 'aria-expanded': !closed, 'aria-label': `${LABELS[section]} (${entries.length})`,
        onClick: () => setCollapsed(previous => ({ ...previous, [section]: !previous[section] })), title: force ? 'Attention keeps Active expanded' : undefined }, icon(closed ? 'ChevronRight' : 'ChevronDown', closed ? '›' : '⌄'), LABELS[section], h('span', { className: 'sf-count' }, entries.length)),
      !closed ? entries.length ? items : h('div', { className: 'sf-empty' }, section === 'active' ? 'All caught up' : 'No sessions') : null);
  };
  const count = rows.length;
  const total = sessions.data?.total || 0;
  const canExpand = !sessions.data?.capped && (limit === 0 ? sessions.data?.has_more : expanded.data?.has_more);
  return h('aside', { className: 'sf', 'aria-label': 'Session Flow', onKeyDown: event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); search.current?.focus(); }
    if (event.key === 'Escape' && event.target === search.current) { setQuery(''); search.current?.blur(); }
  } }, h('style', null, CSS),
    h('header', { className: 'sf-header' }, h('span', { className: 'sf-title' }, 'Session Flow'),
      h(IconButton, { label: 'New session', name: 'SquarePen', glyph: '+', onClick: () => { try { Promise.resolve(controller.newChat(scope)).catch(error => setActionError(error.message)); } catch (error) { setActionError(error.message); } } }),
      h(IconButton, { label: 'Search sessions', name: 'Search', glyph: '⌕', onClick: () => search.current?.focus() }),
      h(IconButton, { label: 'Session Flow settings', name: 'Settings2', glyph: '⚙', onClick: () => host.navigate('/settings?tab=plugins&plugin=session-flow') })),
    h('div', { className: 'sf-search' }, icon('Search', '⌕'), h('input', { ref: search, type: 'search', placeholder: 'Search sessions…', 'aria-label': 'Search sessions', value: query, onChange: event => setQuery(event.target.value) })),
    h('div', { className: 'sf-tools' }, h('select', { 'aria-label': 'Filter by project', value: project, onChange: event => setProject(event.target.value) }, h('option', { value: '*' }, 'All projects'), ...projects.map(cwd => h('option', { key: cwd, value: cwd }, cwd || 'No project'))),
      h(IconButton, { label: grouped ? 'Use flat list' : 'Group by project', name: grouped ? 'List' : 'FolderTree', glyph: '☷', 'aria-pressed': grouped, onClick: () => setGrouped(value => !value) }),
      h(IconButton, { label: detail ? 'Compact rows' : 'Show project details', name: 'ListFilter', glyph: '≡', 'aria-pressed': detail, onClick: () => setDetail(value => !value) })),
    h('div', { className: 'sf-scope', title: `${scope.connectionId ?? 'active local source'} / ${scope.profile}` }, `${scope.connectionId ?? 'Local'} · ${scope.profile} · current scope only`),
    sessions.isLoading ? h(Note, null, 'Loading sessions…') : null,
    sessions.isError ? h(Note, { error: true }, `Session list failed: ${sessions.error.message} `, h(sdk.Button, { variant: 'ghost', size: 'xs', onClick: refresh }, 'Retry')) : null,
    !runtimeKnown ? h(Note, { error: runtime.isError }, runtime.isError ? `Runtime status unavailable: ${runtime.error.message}. Sessions remain in Active with unknown status.` : 'Checking runtime status…') : null,
    metadata.isError ? h(Note, { error: true }, `Session Flow backend unavailable: ${metadata.error.message}. Read-only browsing; no local metadata fallback. `, h(sdk.Button, { variant: 'ghost', size: 'xs', onClick: refresh }, 'Retry')) : null,
    expanded.isError ? h(Note, { error: true }, `Older sessions could not load: ${expanded.error.message}`) : null,
    actionError ? h(Note, { error: true }, actionError) : null,
    h('div', { className: 'sf-scroll' }, ...SECTIONS.map(renderSection),
      !visible.length && (query || project !== '*') ? h('div', { className: 'sf-empty' }, 'No matching sessions') : null),
    sessions.data?.capped ? h(Note, null, `Companion session listing unavailable. Read-only SDK browsing is capped at 500${total ? ` of ${total}` : ''}; older organized sessions cannot be recovered until the companion returns.`) : null,
    canExpand ? h(Note, null, h(sdk.Button, { variant: 'ghost', size: 'xs', disabled: expanded.isFetching, onClick: () => setLimit(previous => previous + 1) }, 'Browse older sessions')) : null,
    undo ? h('div', { className: 'sf-note sf-undo', role: 'status' }, h('span', null, `${undo.label} · ${undo.row.title || 'session'}`), h(sdk.Button, { variant: 'ghost', size: 'xs', disabled: latest.current.disabled, onClick: () => void mutate(undo.row, undo.payload, true) }, 'Undo'), h(IconButton, { label: 'Dismiss undo', name: 'X', glyph: '×', onClick: () => setUndo(null) })) : null,
    h('footer', { className: 'sf-footer' }, h('div', null, `${count} loaded · `, h('button', { type: 'button', className: 'sf-icon', title: 'Refresh sessions', 'aria-label': 'Refresh sessions', onClick: refresh }, icon('RefreshCw', '↻'))),
      h('div', { title: 'The SDK cannot target a native draft project. The project filter never changes new-session workspace.' }, 'New session uses native workspace selection.')));
}
export default {
  id: 'session-flow', name: 'Session Flow', defaultEnabled: false,
  register(ctx) {
    const controller = createController(ctx);
    ctx.register({ id: 'sidebar', area: 'panes', title: 'Session Flow', order: 0,
      data: { placement: 'left', width: '290px' }, render: () => h(SessionFlow, { ctx, controller }) });
    ctx.registerSettingsPage({ id: 'settings', title: 'Session Flow', icon: 'list-tree', render: () => h(Settings) });
    const disposeEvent = ctx.onEvent('*', event => {
      activationEpoch.set(gatewayActivationEpoch());
      if (/^(session\.|gateway\.|approval\.|question\.|server_request\.|message\.complete)/.test(event.type || '')) {
        void queryClient.invalidateQueries({ queryKey: scopeKey(captureScope()) });
      }
    });
    ctx.onDispose(() => { controller.dispose(); disposeEvent(); void queryClient.cancelQueries({ queryKey: ['session-flow'] }); queryClient.removeQueries({ queryKey: ['session-flow'] }); });
  }
};
