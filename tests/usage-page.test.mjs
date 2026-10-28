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

test('drain rate pools consumption over the lookback and ignores reset jumps', () => {
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
  assert.equal(Math.round(usage.drainRate(samples, now, 6 * H) * 1000) / 1000, Math.round(20 / 3 * 1000) / 1000);
  // Twelve hours reach back to the 99% reading: 99→80 adds 19 points over the 8 hours the readings cover.
  const wide = usage.drainStats(samples, now, 12 * H);
  assert.deepEqual([wide.rate, wide.coveredS, wide.consumed, wide.partial], [39 / 8, 8 * H, 39, true], 'less history than the lookback uses what exists and says so');
  assert.equal(usage.drainStats(samples, now, 8 * H).partial, false);
  assert.equal(usage.drainStats(samples, now, H).rate, 10, 'one hour sees only the 100→90 drop after the reset');
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

test('lookback stops are discrete, labeled and drive how much history the limits query asks for', () => {
  assert.deepEqual(usage.LOOKBACK_STOPS.map(usage.lookbackLabel), ['1h', '2h', '5h', '12h', '1d', '2d', '3d', '7d', '15d', '30d']);
  assert.equal(usage.USAGE_DEFAULTS.lookback, 12);
  // The slider runs longest-first; positions map to stored hours, so saved preferences keep their meaning.
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(position => usage.lookbackLabel(usage.lookbackAtPosition(position))), ['30d', '15d', '7d', '3d', '2d', '1d', '12h', '5h', '2h', '1h']);
  assert.deepEqual(usage.LOOKBACK_STOPS.map(usage.lookbackPosition), [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  assert.deepEqual([usage.lookbackPosition(999), usage.lookbackAtPosition(-3), usage.lookbackAtPosition(42), usage.lookbackAtPosition('x')], [6, 720, 1, 720], 'unknown hours show the 12h default; out-of-range positions clamp');
  assert.deepEqual([1, 12, 168, 360, 720].map(usage.limitsHistoryHours), [168, 168, 168, 360, 720]);
  assert.equal(usage.limitsHistoryHours(2000), 840, 'the backend caps history at 840 hours');
  assert.deepEqual([usage.coverageText(20 * 60), usage.coverageText(5.4 * H), usage.coverageText(47 * H), usage.coverageText(9.8 * D)], ['20m', '5h', '47h', '10d']);
});

test('the projection rate follows the lookback and reports partial coverage', () => {
  const now = 1_000_000;
  // a drains 1 point per hour for the last 3 hours, but 4 per hour before that.
  const history = [-10, -3, -2, -1, 0].map(hour => ({ t: now + hour * H, account: 'a', window: 'weekly', remaining_percent: hour === -10 ? 98 : 70 - (hour + 3), resets_at: now + 3 * D }));
  const accounts = [account('a', 1, 67, now + 3 * D, 604800, now)];
  const short = usage.projectPool(accounts, history, 'weekly', now, D, { lookbackS: 2 * H });
  assert.deepEqual([short.rate, short.partial], [1, false]);
  const wide = usage.projectPool(accounts, history, 'weekly', now, D, { lookbackS: 30 * D });
  assert.deepEqual([wide.rate, wide.coveredS, wide.partial], [31 / 10, 10 * H, true]);
  const none = usage.projectPool(accounts, history.slice(-1), 'weekly', now, D, { lookbackS: 12 * H });
  assert.deepEqual([none.rate, none.partial, round(none.points)], [null, false, [[now, 67], [now + D, 67]]], 'without 15 minutes of data the projection stays flat');
});

test('the first zero crossing is interpolated and ignores a later refill', () => {
  assert.equal(usage.firstEmpty([{ t: 0, value: 50 }, { t: 10, value: 0 }]), 10);
  assert.equal(usage.firstEmpty([{ t: 0, value: 50 }, { t: 10, value: -50 }]), 5);
  const now = 1000;
  const projection = usage.projectPool([account('a', 1, 20, now + 5 * H, D), account('b', 2, 10, now + 20 * H, D)], [], 'weekly', now, 2 * D, { rate: 10 });
  const empty = usage.firstEmpty(projection.points);
  assert.equal(empty, now + 3 * H, 'both accounts are drained after 30 points at 10 per hour');
  assert.ok(projection.points.some(point => point.t > empty && point.value === 100), 'the pool refills at a later reset');
  assert.equal(usage.firstEmpty(usage.projectPool([account('a', 1, 20, now + H, D)], [], 'weekly', now, D, { rate: 2 }).points), null, 'a reset before depletion means it never empties');
  assert.equal(usage.firstEmpty([{ t: 7, value: 0 }]), 7, 'an already empty pool is empty now');
  assert.equal(usage.firstEmpty([]), null);
});

test('axis labels show the month only when it changes and the date only at the first hour label and midnight', () => {
  const at = text => Date.parse(text) / 1000;
  const days = ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'].map(day => at(`${day}T00:00:00+01:00`));
  assert.deepEqual(usage.axisLabels(days, 'Europe/Paris', 'day'), ['Oct 30', '31', 'Nov 1', '2']);
  assert.deepEqual(usage.axisLabels([at('2026-12-30T12:00:00Z'), at('2026-12-31T12:00:00Z'), at('2027-01-01T12:00:00Z'), at('2027-01-02T12:00:00Z')], 'UTC', 'day'), ['Dec 30', '31', 'Jan 1', '2']);
  assert.deepEqual(usage.axisLabels([at('2026-01-05T12:00:00Z'), at('2027-01-05T12:00:00Z')], 'UTC', 'day'), ['Jan 5', 'Jan 5'], 'the same month in another year is a change');
  const hours = [21, 24, 27].map(hour => at('2026-10-28T00:00:00Z') + hour * H);
  assert.deepEqual(usage.axisLabels(hours, 'UTC', 'hour'), ['Oct 28, 9 PM', 'Oct 29', '3 AM']);
  assert.deepEqual(usage.axisLabels([at('2026-10-29T00:00:00Z'), at('2026-10-29T03:00:00Z')], 'UTC', 'hour'), ['Oct 29', '3 AM'], 'a first label at midnight is just the date');
});

test('local midnights follow the zone across a DST change', () => {
  const at = text => Date.parse(text) / 1000;
  // Paris leaves summer time on 25 October 2026: that day lasts 25 hours.
  const midnights = usage.localMidnights(at('2026-10-24T12:00:00Z'), at('2026-10-27T12:00:00Z'), 'Europe/Paris');
  assert.deepEqual(midnights.map(t => new Date(t * 1000).toISOString()), ['2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z', '2026-10-26T23:00:00.000Z']);
  assert.equal(usage.startOfLocalDay(at('2026-10-25T20:00:00Z'), 'Europe/Paris'), at('2026-10-24T22:00:00Z'));
  assert.deepEqual(usage.localMidnights(at('2026-03-28T00:00:00Z'), at('2026-03-30T00:00:00Z'), 'America/New_York').map(t => new Date(t * 1000).toISOString()), ['2026-03-28T04:00:00.000Z', '2026-03-29T04:00:00.000Z']);
  const ticks = usage.timeAxisTicks(at('2026-10-27T18:00:00Z'), at('2026-10-29T00:00:00Z'), 'UTC');
  assert.equal(ticks.resolution, 'hour');
  assert.ok(ticks.times.includes(at('2026-10-28T00:00:00Z')) && ticks.times.length <= 10);
  assert.equal(usage.timeAxisTicks(at('2026-10-26T00:00:00Z'), at('2026-11-04T00:00:00Z'), 'UTC').times.length, 10);
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

test('usage charts plot per-day rates with a unit while totals stay actual amounts', () => {
  const hourly = usage.buildUsageCharts({ ...history, resolution: 'hour', tz: 'UTC', buckets: [0, H, 2 * H] }, 'provider', 'stacked');
  const daily = usage.buildUsageCharts({ ...history, buckets: [0, D, 2 * D] }, 'provider', 'stacked');
  assert.deepEqual([hourly.factor, daily.factor, usage.perDayFactor('hour'), usage.perDayFactor('day')], [24, 1, 24, 1]);
  assert.deepEqual(hourly.charts[0].layers.map(layer => layer.upper), [[120, 24, 0], [144, 72, 72]], 'hourly buckets are scaled to a day');
  assert.deepEqual(daily.charts[0].layers.map(layer => layer.upper), [[5, 1, 0], [6, 3, 3]], 'daily buckets already are per day');
  assert.deepEqual(hourly.charts[0].scale.ticks, [0, 50, 100, 150]);
  assert.deepEqual([hourly.charts[0].total, daily.charts[0].total], [12, 12], 'totals stay the period amounts');
  assert.deepEqual(hourly.charts.map(chart => chart.metric.unit), ['tokens/day', '$/day', 'messages/day']);
  assert.deepEqual([hourly.dayLines, hourly.labelIndexes, hourly.labels], [[0], [0], ['Jan 1']], 'the hourly midnight gets a day line and a date label');
  assert.deepEqual([daily.dayLines, daily.labels], [[0, 1, 2], ['Jan 1', '2', '3']]);
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
  assert.deepEqual(usage.validUsagePreferences({ tab: 'limits', days: 30, split: 'model', mode: 'independent', horizon: 3, lookback: 72, window: 'five_hour', provider: 'anthropic' }),
    { tab: 'limits', days: 30, split: 'model', mode: 'independent', horizon: 3, lookback: 72, window: 'five_hour', provider: 'anthropic' });
  assert.deepEqual(usage.validUsagePreferences({ tab: 'x', days: '7', split: 1, mode: 'stack', horizon: 14, lookback: 6, window: '', provider: 5 }), usage.USAGE_DEFAULTS);
  for (const bad of ['12', 0, 13, 1000, null, Infinity]) assert.equal(usage.validUsagePreferences({ lookback: bad }).lookback, 12, `lookback ${bad} falls back to 12h`);
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
  assert.match($('.su-chart[data-metric="tokens"] .su-total').textContent, /^[\d.]+[KMB]? total$/);
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
  assert.deepEqual($$('.su-yunit').map(node => node.textContent), ['tokens/day', '$/day', 'messages/day']);
  await key($('.su-chart[data-metric="user_messages"] .su-plot'), 'End');
  const hourValue = Number($('.su-chart[data-metric="user_messages"] .su-tip-total b .su-tip-raw').textContent.match(/ · ([\d,]+) this hour/)[1].replace(/,/g, ''));
  assert.equal($('.su-chart[data-metric="user_messages"] .su-tip-total b').textContent, `${(hourValue * 24).toLocaleString('en')}/day · ${hourValue.toLocaleString('en')} this hour`);
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

async function slide(node, value) {
  assert.ok(node, 'slider exists');
  await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(node, String(value)); node.dispatchEvent(new window.Event('input', { bubbles: true })); });
  await tick(); await tick();
}

test('the limits tab pools accounts, projects resets and lists per-account windows', async () => {
  mock.ctx.storage.set('usage-preferences', { tab: 'limits' });
  plugin.register(mock.ctx); await render(page());
  assert.deepEqual(restPaths(), ['/usage/limits?hours=168']);
  assert.deepEqual($$('.su-provider').map(node => [node.firstChild.textContent, node.lastChild.textContent, node.getAttribute('aria-pressed')]), [['OpenAI Codex', '2', 'true'], ['Anthropic', 'logged out', 'false']]);
  assert.equal($('.su-pooled').dataset.window, 'weekly', 'weekly is the default window');
  assert.equal($('.su-capacity').textContent, '/ 200% remaining');
  assert.match($('.su-rate').textContent, /^~\d+(\.\d)?% per hour$/);
  assert.equal($('.su-lookback-label').textContent, 'Average over 12h');
  assert.match($('.su-chart-foot').textContent, /^Next reset \+\d+% · /);
  assert.ok($('.su-pooled .su-line.su-past')); assert.ok($('.su-pooled .su-line.su-projected')); assert.ok($('.su-now'));
  assert.ok($$('.su-pooled .su-day-grid').length >= 9, 'a week of history plus a week ahead crosses at least nine midnights');
  assert.equal($$('.su-account').length, 2);
  const first = $('.su-account[data-account="acct-team"]');
  assert.match(first.querySelector('.su-account-head').textContent, /chatgptvitibotteam.*priority 0.*0 banked resets/);
  assert.equal(first.querySelectorAll('.su-window').length, 2);
  assert.equal(first.querySelectorAll('.su-pace').length, 2, 'every window with a length and reset time has a pace tick');
  assert.match(first.querySelector('.su-window[data-window="weekly"] .su-window-reset').textContent, /^resets in 4d \d+h$/);
  assert.match($('.su-footnote').textContent, /^Sampled every 5m · last sample .*averaged over the selected period/);
  await click(button('3d'));
  assert.equal(mock.ctx.storage.get('usage-preferences').horizon, 3);
  await click(button('5-hour'));
  assert.equal($('.su-pooled').dataset.window, 'five_hour');
  await click($$('.su-provider')[1]);
  assert.equal($('.su-pooled'), null, 'a logged-out provider has no chart');
  assert.equal($('[data-auth="logged_out"] .su-logged-out').textContent, 'Logged out in Hermes — sign in to track limits' + 'No usable Anthropic credential in the Hermes pool');
  assert.equal($$('.su-account').length, 0);
  assert.equal(mock.ctx.storage.get('usage-preferences').provider, 'anthropic');
});

test('the lookback slider moves between stops, changes the drain rate and widens the history request', async () => {
  const now = Date.now() / 1000;
  // Four points per hour for the last two hours, one per hour for the eight hours before.
  const history = [[-10 * H + 30, 90], [-2 * H + 30, 82], [-H + 30, 78], [-30, 74]].map(([offset, value]) => ({ t: now + offset, account: 'a', window: 'weekly', remaining_percent: value, resets_at: now + 5 * D }));
  mock.control.usageLimits = { generated_at: now, sampler: null, providers: [{ provider: 'openai-codex', label: 'OpenAI Codex', history,
    accounts: [{ id: 'a', label: 'a', priority: 0, fetched_at: now - 60, windows: [{ key: 'weekly', label: 'Weekly', window_seconds: 604800, remaining_percent: 74, resets_at: now + 5 * D }] }] }] };
  mock.ctx.storage.set('usage-preferences', { tab: 'limits', lookback: 2 });
  plugin.register(mock.ctx); await render(page());
  const slider = $('.su-lookback input[type=range]');
  // Reversed: position 0 is 30d on the left, 9 is 1h on the right, so 2h sits at position 8.
  assert.deepEqual([slider.min, slider.max, slider.step, slider.value, slider.getAttribute('aria-valuetext'), slider.style.getPropertyValue('--su-share')], ['0', '9', '1', '8', '2h', String(8 / 9)]);
  assert.equal($('.su-rate').textContent, '~4.0% per hour');
  assert.equal($('.su-coverage'), null, 'two hours of data cover a two-hour lookback');
  assert.match($('.su-measure').textContent, /^Empty in 18h \d+m · /, '74 points at about 4 per hour');
  await slide(slider, 6);
  assert.equal($('.su-lookback input[type=range]').getAttribute('aria-valuetext'), '12h');
  assert.deepEqual([$('.su-lookback-label').textContent, $('.su-rate').textContent, $('.su-coverage').textContent], ['Average over 12h', '~1.6% per hour', 'based on 10h of data']);
  assert.equal(mock.ctx.storage.get('usage-preferences').lookback, 12);
  assert.equal(restPaths().at(-1), '/usage/limits?hours=168');
  await slide($('.su-lookback input[type=range]'), 1);
  assert.equal($('.su-lookback-label').textContent, 'Average over 15d');
  assert.equal(restPaths().at(-1), '/usage/limits?hours=360', 'a lookback beyond a week asks for that much history');
  await slide($('.su-lookback input[type=range]'), 9);
  assert.equal(mock.ctx.storage.get('usage-preferences').lookback, 1, 'the rightmost stop is the shortest lookback');
  await slide($('.su-lookback input[type=range]'), 0);
  assert.equal(mock.ctx.storage.get('usage-preferences').lookback, 720, 'the leftmost stop is the longest lookback');
});

test('stale, failing and unread accounts keep the normal view', async () => {
  mock.ctx.storage.set('usage-preferences', { tab: 'limits', provider: 'anthropic' });
  const now = Date.now() / 1000;
  mock.control.usageLimits = { generated_at: now, sampler: null, providers: [{ provider: 'anthropic', label: 'Anthropic', auth: 'ok', history: [], accounts: [
    { id: 'acct-b1', label: 'claude-max', priority: 1, plan: 'max', fetched_at: now - 3 * H, stale: true, error: null, windows: [{ key: 'weekly', label: 'Weekly', window_seconds: 604800, remaining_percent: 39, resets_at: now + D }] },
    { id: 'acct-b2', label: 'claude-team', priority: 2, fetched_at: null, stale: false, error: 'HTTP 401 from usage endpoint', windows: [{ key: 'weekly', label: 'Weekly', window_seconds: 604800, remaining_percent: null, resets_at: null }] }] }] };
  plugin.register(mock.ctx); await render(page());
  assert.equal($('.su-provider .su-count').textContent, '2');
  assert.equal($('.su-capacity').textContent, '/ 100% remaining', 'the account without a reading is left out of the pool');
  assert.match($('.su-chart-foot').textContent, /1 account without a reading left out of the pool/);
  assert.equal($('.su-rate').textContent, 'no drain data');
  assert.equal($('.su-measure'), null, 'a flat projection never empties');
  const unknown = $('.su-account[data-account="acct-b2"]');
  assert.equal(unknown.querySelector('.su-window-value').textContent, '—', 'unknown stays a dash, never 0%');
  assert.equal(unknown.querySelector('.su-bar-fill') === null, true);
  assert.equal(unknown.querySelector('[role=alert]').textContent, 'HTTP 401 from usage endpoint');
  assert.equal($('.su-account[data-account="acct-b1"] .su-badge[data-tone=warn]').textContent, 'Stale');
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
