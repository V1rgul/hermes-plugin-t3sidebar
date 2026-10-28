import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import * as mock from './sdk.mock.mjs';
import plugin, * as usage from '../desktop/plugin.js';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
let root;
const H = 3600, D = 86400;
const tick = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const button = label => $$('button').find(node => node.textContent === label || node.getAttribute('aria-label') === label);
async function click(node) { assert.ok(node, 'element to click exists'); await act(async () => node.click()); await tick(); }
async function key(node, name) { await act(async () => node.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true }))); await tick(); }
async function render(contribution) {
  root = createRoot($('#app'));
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: mock.queryClient }, contribution.render())));
  await tick(); await tick();
}
const page = () => mock.control.contributions.find(item => item.id === 'usage');
afterEach(async () => {
  if (root) { await act(async () => root.unmount()); root = null; }
  mock.control.disposers.forEach(dispose => dispose());
  mock.reset();
});

// Pure projection math ------------------------------------------------------------------------------------------------
const account = (id, priority, remaining, resetsAt, period = 604800, fetched = 1000) => ({ id, label: id, priority, fetched_at: fetched,
  windows: [{ key: 'weekly', label: 'Weekly', window_seconds: period, remaining_percent: remaining, resets_at: resetsAt }] });
const round = points => points.map(point => [Math.round(point.t), Math.round(point.value * 1000) / 1000]);

test('projection drains the lowest priority number first, then the next account', () => {
  const now = 1000;
  const result = usage.projectPool([account('b', 2, 80, now + 10 * D), account('a', 1, 50, now + 10 * D)], [], 'weekly', now, 10 * H, { rate: 10 });
  assert.equal(result.current, 130); assert.equal(result.capacity, 200);
  assert.deepEqual(round(result.points), [[now, 130], [now + 5 * H, 80], [now + 10 * H, 30]]);
  assert.deepEqual(result.accounts, [{ id: 'a', remaining: 0 }, { id: 'b', remaining: 30 }]);
  assert.equal(result.resets.length, 0);
  assert.deepEqual(result.nextReset, { t: now + 10 * D, gain: null });
});

test('projection steps each account back to 100% at every reset and rolls its window forward', () => {
  const now = 1000;
  const result = usage.projectPool([account('a', 1, 20, now + H, 5 * H), account('b', 2, 60, now + 3 * H, 5 * H)], [], 'weekly', now, 8 * H, { rate: 10 });
  assert.deepEqual(round(result.points), [[now, 80], [now + H, 70], [now + H, 160], [now + 3 * H, 140], [now + 3 * H, 180], [now + 6 * H, 150], [now + 6 * H, 200], [now + 8 * H, 180]]);
  assert.deepEqual(result.resets.map(item => [item.t - now, item.account, Math.round(item.gain)]), [[H, 'a', 90], [3 * H, 'b', 40], [6 * H, 'a', 50]]);
  assert.deepEqual(result.nextReset, { t: now + H, gain: 90 });
});

test('a reset that passed after the last reading counts the account full and schedules the next window', () => {
  const now = 10_000;
  const result = usage.projectPool([account('a', 1, 30, now - 600, D, now - 900)], [], 'weekly', now, 2 * D, { rate: 0 });
  assert.equal(result.current, 100);
  assert.deepEqual(result.resets.map(item => item.t - now), [D - 600, 2 * D - 600], 'resets continue one window after the missed one');
  const noPeriod = usage.projectPool([{ id: 'a', priority: 1, fetched_at: now - 900, windows: [{ key: 'weekly', remaining_percent: 30, resets_at: now - 600 }] }], [], 'weekly', now, 2 * D, { rate: 0 });
  assert.equal(noPeriod.current, 100); assert.equal(noPeriod.nextReset, null);
  const already = usage.projectPool([account('a', 1, 30, now - 600, D, now - 300)], [], 'weekly', now, H, { rate: 0 });
  assert.equal(already.current, 30, 'a reading taken after the reset already reflects it');
});

test('without drain data the projection is flat apart from resets, and unknown readings stay out of the pool', () => {
  const now = 1000;
  const accounts = [account('a', 1, 40, now + 2 * H, 5 * H), { id: 'u', priority: 2, fetched_at: null, windows: [{ key: 'weekly', remaining_percent: null, resets_at: null }] }];
  const result = usage.projectPool(accounts, [{ t: now - 60, account: 'a', window: 'weekly', remaining_percent: 40, resets_at: now + 2 * H }], 'weekly', now, 4 * H);
  assert.equal(result.rate, null); assert.equal(result.unknown, true);
  assert.deepEqual(round(result.points), [[now, 40], [now + 2 * H, 40], [now + 2 * H, 100], [now + 4 * H, 100]]);
  assert.deepEqual(result.unknownAccounts, ['u']); assert.equal(result.capacity, 100);
});

test('drain rate pools consumption over the last six hours and ignores reset jumps', () => {
  const now = 100 * H;
  const samples = usage.limitSamples([], [
    { t: now - 8 * H, account: 'a', window: 'weekly', remaining_percent: 99, resets_at: now + D },
    { t: now - 3 * H, account: 'a', window: 'weekly', remaining_percent: 80, resets_at: now + D },
    { t: now - 2 * H, account: 'a', window: 'weekly', remaining_percent: 70, resets_at: now + D },
    { t: now - H, account: 'a', window: 'weekly', remaining_percent: 100, resets_at: now + 8 * D },
    { t: now, account: 'a', window: 'weekly', remaining_percent: 90, resets_at: now + 8 * D },
    { t: now - 2 * H, account: 'b', window: 'weekly', remaining_percent: 50, resets_at: now + 3 * D },
    { t: now - H, account: 'b', window: 'weekly', remaining_percent: 49, resets_at: now + 4 * D },
    { t: now - H, account: 'b', window: 'five_hour', remaining_percent: 0, resets_at: null }
  ], 'weekly');
  // a: 80→70 (10) and 100→90 (10); the rise is a reset. b: 50→49 straddles a new reset time, so it counts as none.
  assert.equal(Math.round(usage.drainRate(samples, now) * 1000) / 1000, Math.round(20 / 3 * 1000) / 1000);
  assert.equal(usage.drainRate(samples.slice(-1), now), null, 'a single reading has no rate');
  assert.equal(usage.drainRate([{ t: now - 300, account: 'a', value: 50, resets_at: null }, { t: now, account: 'a', value: 49, resets_at: null }], now), null, 'under 15 minutes of readings is not enough');
});

test('pooled history carries each account forward and sums only accounts seen so far', () => {
  const points = usage.pooledHistory([{ t: 10, account: 'a', value: 50 }, { t: 20, account: 'b', value: 80 }, { t: 30, account: 'a', value: 40 }, { t: 30, account: 'b', value: 70 }]);
  assert.deepEqual(points, [{ t: 10, value: 50, count: 1 }, { t: 20, value: 130, count: 2 }, { t: 30, value: 110, count: 2 }]);
  const snapshot = usage.limitSamples([account('a', 1, 44, 99_999, 604800, 50)], [{ t: 40, account: 'a', window: 'weekly', remaining_percent: 45, resets_at: 99_999 }], 'weekly');
  assert.deepEqual(snapshot.map(item => [item.t, item.value]), [[40, 45], [50, 44]], 'a snapshot newer than history joins the samples');
});

test('pace tick and windows follow the contract keys', () => {
  assert.equal(usage.paceRemainingPercent({ resets_at: 1000 + 0.25 * 604800, window_seconds: 604800 }, 1000), 25);
  assert.equal(usage.paceRemainingPercent({ resets_at: null, window_seconds: 604800 }, 1000), null);
  const catalog = usage.windowCatalog({ accounts: [{ windows: [{ key: 'weekly:gpt', label: 'Weekly gpt' }, { key: 'weekly', label: 'Weekly' }, { key: 'w7200', label: '2h', window_seconds: 7200 }, { key: 'five_hour', label: '5h' }] }], history: [] });
  assert.deepEqual(catalog.map(item => item.key), ['five_hour', 'weekly', 'w7200', 'weekly:gpt']);
});

// Series transforms ---------------------------------------------------------------------------------------------------
const history = { buckets: [0, 1, 2], resolution: 'day', tz: 'UTC', pricing_missing: [],
  by_provider: [{ key: 'openai-codex', label: 'openai-codex', tokens: [5, 1, 0], cost_usd: [1, 0, 0], user_messages: [1, 0, 0] }, { key: 'anthropic', label: 'anthropic', tokens: [1, 2, 3], cost_usd: [0, 0, 0], user_messages: [0, 0, 2] }],
  by_model: [{ key: 'openai-codex/a', label: 'a', tokens: [5, 0, 0] }, { key: 'openai-codex/b', label: 'b', tokens: [0, 1, 0] }, { key: 'anthropic/c', label: 'c', tokens: [1, 2, 3] }] };

test('stacked layers accumulate while independent layers start from zero', () => {
  const series = usage.usageSeries(history, 'provider', 'tokens');
  const stacked = usage.chartLayers(series, 'stacked'), independent = usage.chartLayers(series, 'independent');
  assert.deepEqual(stacked.layers.map(layer => [layer.lower, layer.upper]), [[[0, 0, 0], [5, 1, 0]], [[5, 1, 0], [6, 3, 3]]]);
  assert.equal(stacked.max, 6);
  assert.deepEqual(independent.layers.map(layer => [layer.lower, layer.upper]), [[[0, 0, 0], [5, 1, 0]], [[0, 0, 0], [1, 2, 3]]]);
  assert.equal(independent.max, 5);
  assert.deepEqual(usage.usageSeries(history, 'provider', 'cost_usd').map(item => item.key), ['openai-codex'], 'series with nothing to draw are left out');
  assert.deepEqual(usage.usageSeries(history, 'model', 'tokens').map(item => item.total), [5, 1, 6]);
});

test('model labels name the provider only when two series share a model', () => {
  const shared = { buckets: [0], by_model: [{ key: 'openai-codex/gpt', label: 'gpt', provider: 'openai-codex', tokens: [5] }, { key: 'unknown/gpt', label: 'gpt', provider: 'unknown', tokens: [1] }, { key: 'anthropic/c', label: 'c', provider: 'anthropic', tokens: [2] }] };
  assert.deepEqual(usage.usageSeries(shared, 'model', 'tokens').map(item => item.label), ['gpt · openai-codex', 'gpt · unknown', 'c']);
});

test('scales, formats and colors are compact and stable per series key', () => {
  assert.deepEqual(usage.niceScale(38_000_000, 4, true), { max: 40_000_000, ticks: [0, 10_000_000, 20_000_000, 30_000_000, 40_000_000] });
  assert.deepEqual(usage.niceScale(3, 4, true).ticks, [0, 1, 2, 3]);
  assert.deepEqual(usage.niceScale(0).ticks, [0, 1]);
  const [tokens, cost, messages] = usage.USAGE_METRICS;
  assert.deepEqual([tokens.format(1_500_000), tokens.format(2_000_000_000), tokens.format(950), cost.format(12.3456), messages.format(1234)], ['1.5M', '2B', '950', '$12.35', '1,234']);
  const first = usage.seriesColors(usage.usageSeries(history, 'model', 'tokens'), 'model');
  const again = usage.seriesColors([...usage.usageSeries(history, 'model', 'tokens')].reverse(), 'model');
  assert.deepEqual([...first.entries()].sort(), [...again.entries()].sort());
  assert.equal(new Set(first.values()).size, 3, 'colliding hashes probe to distinct hues');
  const providers = usage.seriesColors(usage.usageSeries(history, 'provider', 'tokens'), 'provider');
  assert.match(providers.get('anthropic'), /oklch\(0\.72 0\.15 45\)/); assert.match(providers.get('openai-codex'), /var\(--ui-text-primary\)/);
});

test('preferences validate every field and fall back to safe defaults', () => {
  assert.deepEqual(usage.validUsagePreferences(null), usage.USAGE_DEFAULTS);
  assert.deepEqual(usage.validUsagePreferences({ tab: 'limits', days: 30, split: 'model', mode: 'independent', horizon: 3, window: 'five_hour', provider: 'anthropic' }),
    { tab: 'limits', days: 30, split: 'model', mode: 'independent', horizon: 3, window: 'five_hour', provider: 'anthropic' });
  assert.deepEqual(usage.validUsagePreferences({ tab: 'x', days: '7', split: 1, mode: 'stack', horizon: 14, window: '', provider: 5 }), usage.USAGE_DEFAULTS);
  mock.control.storageReadError = true;
  assert.deepEqual(usage.readUsagePreferences(mock.ctx.storage), usage.USAGE_DEFAULTS);
  mock.control.storageReadError = false; mock.control.storageWriteError = true;
  assert.equal(usage.writeUsagePreferences(mock.ctx.storage, { days: 30 }), false);
});

// Sidebar footer and registration -----------------------------------------------------------------------------------
test('the page registers as a routes contribution and the sidebar footer navigates to it', async () => {
  plugin.register(mock.ctx);
  assert.deepEqual([page().area, page().title, page().data.path], ['routes', 'Usage', '/t3sidebar-usage']);
  assert.equal(mock.control.contributions[0].id, 'sidebar', 'the sidebar pane stays the first contribution');
  await render(mock.control.contributions[0]);
  const footer = $('.sf > footer.sf-footer');
  assert.equal(footer !== null, true); assert.equal($('.sf').lastElementChild?.className, 'sf-footer', 'the footer is the last row of the pane');
  const usageButton = footer.querySelector('button.sf-utility');
  assert.equal(usageButton.textContent, 'Usage'); assert.equal(usageButton.getAttribute('title'), 'Token usage and subscription limits');
  assert.equal(usageButton.querySelector('svg')?.getAttribute('data-icon'), 'BarChart3');
  await click(usageButton);
  assert.deepEqual(mock.calls.filter(call => call[0] === 'navigate'), [['navigate', '/t3sidebar-usage']]);
});

// Page rendering -----------------------------------------------------------------------------------------------------
const seriesCount = metric => $$(`.su-chart[data-metric="${metric}"] svg g[data-series]`).length;
const restPaths = () => mock.calls.filter(call => call[0] === 'rest').map(call => call[1]);

test('the usage tab draws three charts from /usage/history and toggles split and mode', async () => {
  plugin.register(mock.ctx); await render(page());
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.deepEqual(restPaths(), [`/usage/history?days=7&tz=${encodeURIComponent(tz)}`]);
  assert.deepEqual($$('.su-chart').map(node => node.dataset.metric), ['tokens', 'cost_usd', 'user_messages']);
  assert.equal($('.su-chart[data-metric="cost_usd"] .su-sub').textContent, 'API-equivalent');
  assert.deepEqual([seriesCount('tokens'), seriesCount('cost_usd'), seriesCount('user_messages')], [3, 2, 3]);
  assert.equal($$('.su-xaxis').length, 1, 'only the bottom chart repeats the shared time axis');
  assert.match($('.su-footnote').textContent, /approximate/); assert.match($('.su-footnote').textContent, /copilot\/gpt-5\.5/);
  const stackedArea = $('.su-chart[data-metric="tokens"] g[data-series="anthropic"] .su-area').getAttribute('d');
  await click(button('Model'));
  assert.equal(seriesCount('tokens'), 5); assert.equal(seriesCount('cost_usd'), 4);
  await click(button('Provider'));
  await click(button('Independent'));
  assert.equal(seriesCount('tokens'), 3);
  assert.notEqual($('.su-chart[data-metric="tokens"] g[data-series="anthropic"] .su-area').getAttribute('d'), stackedArea, 'independent bands no longer sit on the series below');
  assert.deepEqual(mock.ctx.storage.get('usage-preferences'), { ...usage.USAGE_DEFAULTS, mode: 'independent' });
  await click(button('24h'));
  assert.equal(restPaths().at(-1), `/usage/history?days=1&tz=${encodeURIComponent(tz)}`);
  assert.equal($$('.su-chart[data-metric="tokens"] svg g[data-series] .su-line')[0].getAttribute('d').split('L').length, 24, 'the day view has 24 hourly buckets');
});

test('hovering a bucket synchronizes the crosshair and tooltip across all three charts', async () => {
  plugin.register(mock.ctx); await render(page());
  await key($('.su-chart[data-metric="tokens"] .su-plot'), 'End');
  assert.equal($$('.su-cross').length, 3);
  const tips = $$('.su-tip');
  assert.equal(tips.length, 3);
  const rows = tips[0].querySelectorAll('.su-tip-row');
  assert.equal(rows.length, 4, 'three providers plus the total');
  assert.equal(rows[3].querySelector('span:nth-child(2)').textContent, 'Total');
  await key($('.su-chart[data-metric="tokens"] .su-plot'), 'Escape');
  assert.equal($$('.su-tip').length, 0);
});

test('preferences persist through a remount and the page shows empty and error states', async () => {
  mock.ctx.storage.set('usage-preferences', { tab: 'usage', days: 30, split: 'model', mode: 'independent', horizon: 7 });
  mock.control.usageHistory = { generated_at: 1, days: 30, tz: 'UTC', resolution: 'day', buckets: [1, 2], by_provider: [], by_model: [], totals: { tokens: 0, cost_usd: 0, user_messages: 0 }, pricing_missing: [] };
  plugin.register(mock.ctx); await render(page());
  assert.match(restPaths()[0], /^\/usage\/history\?days=30&/);
  assert.equal(button('Model').getAttribute('aria-pressed'), 'true'); assert.equal(button('Independent').getAttribute('aria-pressed'), 'true');
  assert.equal($('.su-state').textContent, 'No usage recorded in this period.');
  await act(async () => root.unmount()); root = null; mock.queryClient.clear();
  mock.control.usageHistory = undefined; mock.control.usageError = '404 backend not enabled';
  await render(page());
  assert.equal($('.su-state[role=alert]').textContent, 'Usage history unavailable: 404 backend not enabled Retry');
  mock.control.usageError = null;
  await click(button('Retry'));
  assert.equal(seriesCount('tokens'), 5);
});

test('the limits tab pools accounts, projects resets and lists per-account windows', async () => {
  mock.ctx.storage.set('usage-preferences', { tab: 'limits' });
  plugin.register(mock.ctx); await render(page());
  assert.deepEqual(restPaths(), ['/usage/limits?hours=168']);
  assert.deepEqual($$('.su-provider').map(node => [node.firstChild.textContent, node.querySelector('.su-count').textContent, node.getAttribute('aria-pressed')]), [['OpenAI Codex', '3', 'true'], ['Anthropic', '2', 'false']]);
  assert.equal($('.su-pooled').dataset.window, 'weekly', 'weekly is the default window');
  assert.equal($('.su-capacity').textContent, '/ 300% remaining');
  assert.match($('.su-rate').textContent, /^~0\.\d% per hour$/);
  assert.match($('.su-chart-foot').textContent, /^Next reset \+100% · /);
  assert.ok($('.su-pooled .su-line.su-past')); assert.ok($('.su-pooled .su-line.su-projected')); assert.ok($('.su-now'));
  assert.equal($$('.su-account').length, 3);
  const first = $('.su-account[data-account="acct-a1"]');
  assert.match(first.querySelector('.su-account-head').textContent, /chatgpt1pro.*priority 1.*2 banked resets/);
  assert.equal(first.querySelectorAll('.su-window').length, 3);
  assert.equal(first.querySelectorAll('.su-pace').length, 3, 'every window with a length and reset time has a pace tick');
  assert.match(first.querySelector('.su-window[data-window="weekly"] .su-window-reset').textContent, /^resets in 2d \d+h$/);
  assert.match($('.su-footnote').textContent, /^Sampled every 5m · last sample /);
  await click(button('3d'));
  assert.equal(mock.ctx.storage.get('usage-preferences').horizon, 3);
  await click(button('5-hour'));
  assert.equal($('.su-pooled').dataset.window, 'five_hour');
  await click($$('.su-provider')[1]);
  assert.equal($('.su-capacity').textContent, '/ 100% remaining', 'the account without a reading is left out of the pool');
  assert.match($('.su-chart-foot').textContent, /1 account without a reading left out of the pool/);
  const unknown = $('.su-account[data-account="acct-b2"]');
  assert.equal(unknown.querySelector('.su-window-value').textContent, '—', 'unknown stays a dash, never 0%');
  assert.equal(unknown.querySelector('.su-bar-fill') === null, true);
  assert.equal(unknown.querySelector('[role=alert]').textContent, 'HTTP 401 from usage endpoint');
  assert.equal($('.su-account[data-account="acct-b1"] .su-badge[data-tone=warn]').textContent, 'Stale');
  assert.equal(mock.ctx.storage.get('usage-preferences').provider, 'anthropic');
});

test('a pool with no account readings shows a dash instead of 0%', async () => {
  mock.ctx.storage.set('usage-preferences', { tab: 'limits' });
  mock.control.usageLimits = { generated_at: 1, sampler: null, providers: [{ provider: 'anthropic', label: 'Anthropic', history: [], accounts: [
    { id: 'x', label: 'x', priority: 1, fetched_at: null, stale: false, error: 'timeout', windows: [{ key: 'weekly', label: 'Weekly', window_seconds: 604800, remaining_percent: null, resets_at: null }] }] }] };
  plugin.register(mock.ctx); await render(page());
  assert.deepEqual([$('.su-pool').textContent, $('.su-capacity').textContent], ['—', 'no account readings yet']);
  assert.equal($('.su-window-value').textContent, '—');
});

test('the limits tab reports a missing backend and an empty sampler', async () => {
  mock.ctx.storage.set('usage-preferences', { tab: 'limits' });
  mock.control.usageError = 'fixture limits unavailable';
  plugin.register(mock.ctx); await render(page());
  assert.equal($('.su-state[role=alert]').textContent, 'Limits unavailable: fixture limits unavailable Retry');
  mock.control.usageError = null; mock.control.usageLimits = { generated_at: 1, sampler: null, providers: [] };
  await click(button('Retry'));
  assert.equal($('.su-state').textContent, 'No subscription limits recorded yet.');
  assert.equal($('.su-footnote').textContent, 'The limits sampler has not reported yet.');
});
