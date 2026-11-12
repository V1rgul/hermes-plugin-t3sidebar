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
const limitsPage = () => mock.control.contributions.find(item => item.id === 'limits');
afterEach(async () => {
  if (root) { await act(async () => root.unmount()); root = null; }
  mock.control.disposers.forEach(dispose => dispose());
  mock.reset();
});

// Pure projection math ------------------------------------------------------------------------------------------------ Pro 100 accounts weigh 100 plan units, so in these projection tests one percent of an account is exactly one unit of the pool.
const account = (id, priority, remaining, resetsAt, period = 604800, fetched = 1000, plan = 'prolite') => ({ id, label: id, priority, plan, fetched_at: fetched,
  windows: [{ key: 'weekly', label: 'Weekly', window_seconds: period, remaining_percent: remaining, resets_at: resetsAt }] });
const codex = { provider: 'openai-codex' };
const remainingOf = result => result.accounts.map(item => ({ id: item.id, remaining: item.remaining }));
const round = points => points.map(point => [Math.round(point.t), Math.round(point.value * 1000) / 1000]);

test('projection drains the lowest priority number first, then the next account', () => {
  const now = 1000;
  const result = usage.projectPool([account('b', 2, 80, now + 10 * D), account('a', 1, 50, now + 10 * D)], [], 'weekly', now, 10 * H, { rate: 10, ...codex });
  assert.equal(result.current, 130); assert.equal(result.capacity, 200);
  assert.deepEqual(round(result.points), [[now, 130], [now + 5 * H, 80], [now + 10 * H, 30]]);
  assert.deepEqual(remainingOf(result), [{ id: 'a', remaining: 0 }, { id: 'b', remaining: 30 }]);
  assert.equal(result.resets.length, 0);
  assert.deepEqual(result.nextReset, { t: now + 10 * D, gain: null });
});

test('projection steps each account back to 100% at every reset and rolls its window forward', () => {
  const now = 1000;
  const result = usage.projectPool([account('a', 1, 20, now + H, 5 * H), account('b', 2, 60, now + 3 * H, 5 * H)], [], 'weekly', now, 8 * H, { rate: 10, ...codex });
  assert.deepEqual(round(result.points), [[now, 80], [now + H, 70], [now + H, 160], [now + 3 * H, 140], [now + 3 * H, 180], [now + 6 * H, 150], [now + 6 * H, 200], [now + 8 * H, 180]]);
  assert.deepEqual(result.resets.map(item => [item.t - now, item.account, Math.round(item.gain)]), [[H, 'a', 90], [3 * H, 'b', 40], [6 * H, 'a', 50]]);
  assert.deepEqual(result.nextReset, { t: now + H, gain: 90 });
});

test('a reset that passed after the last reading counts the account full and schedules the next window', () => {
  const now = 10_000;
  const result = usage.projectPool([account('a', 1, 30, now - 600, D, now - 900)], [], 'weekly', now, 2 * D, { rate: 0, ...codex });
  assert.equal(result.current, 100);
  assert.deepEqual(result.resets.map(item => item.t - now), [D - 600, 2 * D - 600], 'resets continue one window after the missed one');
  const noPeriod = usage.projectPool([{ id: 'a', priority: 1, plan: 'prolite', fetched_at: now - 900, windows: [{ key: 'weekly', remaining_percent: 30, resets_at: now - 600 }] }], [], 'weekly', now, 2 * D, { rate: 0, ...codex });
  assert.equal(noPeriod.current, 100); assert.equal(noPeriod.nextReset, null);
  const already = usage.projectPool([account('a', 1, 30, now - 600, D, now - 300)], [], 'weekly', now, H, { rate: 0, ...codex });
  assert.equal(already.current, 30, 'a reading taken after the reset already reflects it');
});

test('without drain data the projection is flat apart from resets, and unknown readings stay out of the pool', () => {
  const now = 1000;
  const accounts = [account('a', 1, 40, now + 2 * H, 5 * H), { id: 'u', priority: 2, fetched_at: null, windows: [{ key: 'weekly', remaining_percent: null, resets_at: null }] }];
  // A single reading: no interval to measure a drain over (two readings, even a minute apart, would give one).
  const result = usage.projectPool(accounts, [], 'weekly', now, 4 * H, codex);
  assert.equal(result.rate, null); assert.equal(result.unknown, true);
  assert.deepEqual(round(result.points), [[now, 40], [now + 2 * H, 40], [now + 2 * H, 100], [now + 4 * H, 100]]);
  assert.deepEqual(result.unknownAccounts, ['u']); assert.equal(result.capacity, 100);
});

test('compacted history gives the same drain rates, pooled line, past resets, projection and verdict as every sample', () => {
  // The synthetic drain follows office hours; pin the browser smoke's weekday afternoon so idle nights and weekends give long unchanged stretches.
  const realNow = Date.now, fixed = Date.parse('2026-10-28T15:00:00+01:00');
  Date.now = () => fixed;
  try {
    const now = fixed / 1000, round = (value, digits = 0) => value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits;
    for (const scenario of ['mixed', 'light', 'steady']) {
      // Reference: every sample at the wire precision (whole seconds, one decimal), so only the dropped samples differ.
      const raw = mock.syntheticUsageLimits(840, scenario, { compact: false });
      const precise = series => series.map(item => ({ ...item, t: item.t.map(t => round(t)), remaining_percent: item.remaining_percent.map(value => round(value, 1)), resets_at: item.resets_at.map(value => round(value)) }));
      const reference = usage.validUsageLimits({ ...raw, providers: raw.providers.map(item => ({ ...item, history: precise(item.history) })) });
      const compact = usage.validUsageLimits(mock.syntheticUsageLimits(840, scenario));
      for (const [index, full] of reference.providers.entries()) {
        const kept = compact.providers[index], label = `${scenario} ${full.provider}`;
        assert.ok(kept.history.length < full.history.length, `${label}: compaction keeps ${kept.history.length} of ${full.history.length} samples`);
        for (const windowKey of ['weekly', 'five_hour']) {
          const a = usage.limitSamples(full.accounts, full.history, windowKey, full.provider), b = usage.limitSamples(kept.accounts, kept.history, windowKey, kept.provider);
          for (const hours of usage.LOOKBACK_STOPS) {
            const x = usage.drainStats(a, now, hours * H), y = usage.drainStats(b, now, hours * H);
            assert.ok(Math.abs(x.rate - y.rate) <= 1e-9 * Math.max(1, Math.abs(x.rate)) && x.coveredS === y.coveredS && x.partial === y.partial, `${label} ${windowKey} ${hours}h: ${JSON.stringify([x, y])}`);
          }
          const pooledA = usage.pooledHistory(a), pooledB = usage.pooledHistory(b);
          const at = (points, t) => { let value = null; for (const point of points) { if (point.t > t) break; value = point.value; } return value; };
          assert.ok(pooledA.every(point => Math.abs(at(pooledB, point.t) - point.value) < 1e-9), `${label} ${windowKey}: the pooled step line is unchanged`);
          const marks = samples => usage.pastResetMarkers(full.accounts, samples, now - 35 * D, now, full.provider).map(group => [group.t, group.accounts.map(item => [item.id, round(item.base, 6), round(item.top, 6)])]);
          assert.deepEqual(marks(b), marks(a), `${label} ${windowKey}: past reset markers`);
          const points = history => usage.projectPool(full.accounts, history, windowKey, now, 30 * D, { lookbackS: 12 * H, provider: full.provider }).points.map(point => [point.t, round(point.value, 6)]);
          assert.deepEqual(points(kept.history), points(full.history), `${label} ${windowKey}: projection`);
        }
        assert.deepEqual(usage.limitsVerdict(kept, usage.USAGE_DEFAULTS, now), usage.limitsVerdict(full, usage.USAGE_DEFAULTS, now), `${label}: verdict`);
      }
    }
  } finally { Date.now = realNow; }
});

test('limit history rows come from the compacted series, in time order', () => {
  const series = [{ account: 'b', window: 'weekly', t: [10, 30], remaining_percent: [50, 49.5], resets_at: [100, null] }, { account: 'a', window: 'weekly', t: [10, 20], remaining_percent: [60, null], resets_at: [90, 90] }, { account: 5, window: 'weekly', t: [1] }, null];
  assert.deepEqual(usage.limitHistoryRows(series), [
    { t: 10, account: 'a', window: 'weekly', remaining_percent: 60, resets_at: 90 }, { t: 10, account: 'b', window: 'weekly', remaining_percent: 50, resets_at: 100 },
    { t: 20, account: 'a', window: 'weekly', remaining_percent: null, resets_at: 90 }, { t: 30, account: 'b', window: 'weekly', remaining_percent: 49.5, resets_at: null }]);
  // Per-sample objects are not a history shape: they are dropped.
  assert.deepEqual(usage.limitHistoryRows([{ t: 20, account: 'a', window: 'weekly', remaining_percent: 1, resets_at: null }]), []);
  assert.deepEqual([usage.limitHistoryRows(null), usage.validUsageLimits({ providers: [{ provider: 'x', history: series }] }).providers[0].history.length], [[], 4]);
});

test('drain rate pools consumption over the lookback and ignores reset jumps', () => {
  const now = 100 * H;
  const samples = usage.limitSamples([{ id: 'a', plan: 'prolite' }, { id: 'b', plan: 'prolite' }], [
    { t: now - 8 * H, account: 'a', window: 'weekly', remaining_percent: 99, resets_at: now + D },
    { t: now - 3 * H, account: 'a', window: 'weekly', remaining_percent: 80, resets_at: now + D },
    { t: now - 2 * H, account: 'a', window: 'weekly', remaining_percent: 70, resets_at: now + D },
    { t: now - H, account: 'a', window: 'weekly', remaining_percent: 100, resets_at: now + 8 * D },
    { t: now, account: 'a', window: 'weekly', remaining_percent: 90, resets_at: now + 8 * D },
    { t: now - 2 * H, account: 'b', window: 'weekly', remaining_percent: 50, resets_at: now + 3 * D },
    { t: now - H, account: 'b', window: 'weekly', remaining_percent: 49, resets_at: now + 4 * D },
    { t: now - H, account: 'b', window: 'five_hour', remaining_percent: 0, resets_at: null }
  ], 'weekly', 'openai-codex');
  // a: 80→70 (10) and 100→90 (10); the rise is a reset. b: 50→49 straddles a new reset time, so it counts as none. The 99→80 pair straddles the 6h lookback start, so its last 3 of 5 hours count (11.4) and the coverage starts at the lookback.
  const six = usage.drainStats(samples, now, 6 * H);
  assert.deepEqual([Math.round(six.rate * 1000) / 1000, six.coveredS, Math.round(six.consumed * 1000) / 1000, six.partial], [Math.round(31.4 / 6 * 1000) / 1000, 6 * H, 31.4, false]);
  // Twelve hours reach back to the 99% reading: 99→80 adds 19 points over the 8 hours the readings cover.
  const wide = usage.drainStats(samples, now, 12 * H);
  assert.deepEqual([wide.rate, wide.coveredS, wide.consumed, wide.partial], [39 / 8, 8 * H, 39, true], 'less history than the lookback uses what exists and says so');
  assert.equal(usage.drainStats(samples, now, 8 * H).partial, false);
  assert.equal(usage.drainStats(samples, now, H).rate, 10, 'one hour sees only the 100→90 drop after the reset');
  assert.equal(usage.drainRate(samples.slice(-1), now), null, 'a single reading has no rate');
  assert.equal(usage.drainRate([{ t: now - 300, account: 'a', value: 50, resets_at: null }, { t: now, account: 'a', value: 49, resets_at: null }], now), 12, 'two readings five minutes apart are enough: the rate uses whatever history exists');
  assert.equal(usage.drainRate([{ t: now, account: 'a', value: 50, resets_at: null }], now), null, 'a single reading has no rate');
});

test('drain rate ignores readings at 0% remaining (Hermes reports Anthropic 1% used as 100%)', () => {
  const now = 100 * H, reading = (t, value) => ({ t, account: 'claude-code', value, resets_at: null });
  // A fresh window as stored: 0% used, then 1% misread as 100%, then 2%.
  const stats = usage.drainStats([reading(now - 2 * H, 100), reading(now - H, 0), reading(now, 98)], now, 2 * H);
  assert.deepEqual([stats.rate, stats.coveredS, stats.consumed], [1, 2 * H, 2], 'only the real 100 → 98 delta counts, over the full covered time');
  assert.equal(usage.drainRate([{ t: now - H, account: 'a', value: 0, resets_at: null }, { t: now, account: 'a', value: 0, resets_at: null }], now), null, 'an account seen only at zero has no rate');
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
  assert.deepEqual([1, 12, 168, 360, 720].map(hours => usage.limitsHistoryHours(hours)), [168, 168, 168, 360, 720]);
  // The longest past of either window group counts too, so switching the window never waits for more history: 30 days of weekly past need 720 hours, a week of session past no more than the week minimum.
  const range = (weekly, session) => ({ weekly: { past: weekly, future: 168 }, session: { past: session, future: 24 } });
  assert.deepEqual([usage.limitsHistoryHours(12, range(720, 5)), usage.limitsHistoryHours(12, range(24, 168)), usage.limitsHistoryHours(360, range(168, 24)), usage.limitsHistoryHours(12, null)], [720, 168, 360, 168]);
  assert.equal(usage.limitsHistoryHours(2000), 840, 'the backend caps history at 840 hours');
  assert.deepEqual([usage.coverageText(20 * 60), usage.coverageText(5.4 * H), usage.coverageText(47 * H), usage.coverageText(9.8 * D)], ['20m', '5h', '47h', '10d']);
});

test('the projection rate follows the lookback and reports partial coverage', () => {
  const now = 1_000_000;
  // a drains 1 point per hour for the last 3 hours, but 4 per hour before that.
  const history = [-10, -3, -2, -1, 0].map(hour => ({ t: now + hour * H, account: 'a', window: 'weekly', remaining_percent: hour === -10 ? 98 : 70 - (hour + 3), resets_at: now + 3 * D }));
  const accounts = [account('a', 1, 67, now + 3 * D, 604800, now)];
  const short = usage.projectPool(accounts, history, 'weekly', now, D, { lookbackS: 2 * H, ...codex });
  assert.deepEqual([short.rate, short.partial], [1, false]);
  const wide = usage.projectPool(accounts, history, 'weekly', now, D, { lookbackS: 30 * D, ...codex });
  assert.deepEqual([wide.rate, wide.coveredS, wide.partial], [31 / 10, 10 * H, true]);
  const none = usage.projectPool(accounts, history.slice(-1), 'weekly', now, D, { lookbackS: 12 * H, ...codex });
  assert.deepEqual([none.rate, none.partial, round(none.points)], [null, false, [[now, 67], [now + D, 67]]], 'with a single reading the projection stays flat');
});

test('the first zero crossing is interpolated and ignores a later refill', () => {
  assert.equal(usage.firstEmpty([{ t: 0, value: 50 }, { t: 10, value: 0 }]), 10);
  assert.equal(usage.firstEmpty([{ t: 0, value: 50 }, { t: 10, value: -50 }]), 5);
  const now = 1000;
  const projection = usage.projectPool([account('a', 1, 20, now + 5 * H, D), account('b', 2, 10, now + 20 * H, D)], [], 'weekly', now, 2 * D, { rate: 10, ...codex });
  const empty = usage.firstEmpty(projection.points);
  assert.equal(empty, now + 3 * H, 'both accounts are drained after 30 points at 10 per hour');
  assert.ok(projection.points.some(point => point.t > empty && point.value === 100), 'the pool refills at a later reset');
  assert.equal(usage.firstEmpty(usage.projectPool([account('a', 1, 20, now + H, D)], [], 'weekly', now, D, { rate: 2, ...codex }).points), null, 'a reset before depletion means it never empties');
  assert.equal(usage.firstEmpty([{ t: 7, value: 0 }]), 7, 'an already empty pool is empty now');
  assert.equal(usage.firstEmpty([]), null);
});

// Plan units -----------------------------------------------------------------------------------------------------------
test('plan units follow the capacity table: Codex is linear in price in every window, Anthropic differs per window', () => {
  const codexRows = [['plus', 20], ['team', 20], ['business', 20], ['self_serve_business_usage_based', 20], ['self_serve_business_prolite', 100], ['prolite', 100], ['pro', 200], ['promax', 500]];
  for (const [plan, units] of codexRows) for (const key of ['weekly', 'five_hour', 'weekly:gpt-5', 'w7200']) {
    assert.equal(usage.planWeight('openai-codex', plan, key), units, `Codex ${plan} in ${key}`);
    assert.equal(usage.planAssumed('openai-codex', plan), false, `Codex ${plan} is known`);
  }
  // Older samples hold Hermes's title-cased plan; case and separators fold back to the enum.
  assert.deepEqual(['Team', 'Prolite', 'Self Serve Business Usage Based', ' PROMAX ', 'Self Serve Business Prolite'].map(plan => usage.planWeight('openai-codex', plan)), [20, 100, 20, 500, 100]);
  const anthropicRows = [['pro', 20, 20], ['max_5x', 100, 100], ['max_20x', 200, 400], ['team_standard', 20, 20], ['team_premium', 100, 100]];
  for (const [plan, weekly, fiveHour] of anthropicRows) {
    assert.deepEqual([usage.planWeight('anthropic', plan, 'weekly'), usage.planWeight('anthropic', plan, 'five_hour'), usage.planAssumed('anthropic', plan)], [weekly, fiveHour, false], `Anthropic ${plan}`);
  }
  assert.deepEqual([usage.planWeight('anthropic', 'max_20x', 'weekly'), usage.planWeight('anthropic', 'max_20x', 'five_hour')], [200, 400], 'Max 20x is 2x Max 5x weekly but 4x in five hours');
  assert.deepEqual([usage.planWeight('anthropic', 'max_20x', 'weekly:opus'), usage.planWeight('anthropic', 'max_20x', 'five_hour:opus'), usage.planWeight('anthropic', 'max_20x', 'w7200'), usage.planWeight('anthropic', 'max_20x', undefined)], [200, 400, 200, 200], 'unknown windows use the weekly weight');
  // Anthropic strings vary by source; the seat tiers match tolerantly.
  const tolerant = { 'Claude Pro': 20, 'default_claude_max_5x': 100, 'Max 5x': 100, 'default_claude_max_20x': 200, 'MAX 20X': 200, 'Team Standard': 20, 'standard seat': 20, 'Team Premium': 100, premium: 100, 'Enterprise Premium Seat': 100 };
  for (const [plan, units] of Object.entries(tolerant)) assert.equal(usage.planWeight('anthropic', plan), units, `Anthropic "${plan}"`);
  assert.deepEqual([usage.planLabel('anthropic', 'default_claude_max_20x'), usage.planLabel('anthropic', 'team_standard'), usage.planLabel('anthropic', 'premium')], ['Max 20x', 'Standard seat', 'Premium seat']);
  // Unknown capacity counts as one base plan and is flagged; "premium" alone never matches a Codex row, and a bare "max" stays unknown.
  for (const [provider, plan] of [['openai-codex', 'premium'], ['openai-codex', 'enterprise'], ['openai-codex', null], ['anthropic', 'max'], ['anthropic', 'team'], ['nous', 'pro']]) {
    assert.deepEqual([usage.planWeight(provider, plan), usage.planAssumed(provider, plan)], [20, true], `${provider} ${plan} is assumed`);
  }
  assert.equal(usage.BASE_PLAN_UNITS, 20);
});

test('plan labels use T3 Code\'s names', () => {
  const labels = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro 200', prolite: 'Pro 100', promax: 'Pro 500', self_serve_business_prolite: 'Business Premium', team: 'Business', business: 'Business', self_serve_business_usage_based: 'Business',
    ent26: 'Enterprise', enterprise: 'Enterprise', enterprise_cbp_automation: 'Enterprise', enterprise_cbp_usage_based: 'Enterprise', edu: 'Edu', edu_plus: 'Edu', edu_pro: 'Edu' };
  for (const [plan, label] of Object.entries(labels)) assert.equal(usage.planLabel('openai-codex', plan), label, plan);
  assert.deepEqual([usage.planLabel('openai-codex', 'Prolite'), usage.planLabel('openai-codex', 'mystery_plan'), usage.planLabel('openai-codex', null), usage.planLabel('anthropic', 'max')], ['Pro 100', 'mystery_plan', null, 'max']);
});

test('units format and vertical ticks run to the pool capacity', () => {
  assert.deepEqual([74.4, 9.96, 3.25, 0, NaN].map(usage.unitsText), ['74', '10', '3.3', '0', '—']);
  assert.deepEqual(usage.unitTicks(120), [0, 25, 50, 75, 100, 120]);
  assert.deepEqual(usage.unitTicks(20), [0, 5, 10, 15, 20]);
  assert.deepEqual(usage.unitTicks(200), [0, 50, 100, 150, 200]);
  assert.deepEqual(usage.unitTicks(520), [0, 200, 400, 520]);
});

test('the pool weighs accounts by plan units: a raw point on Pro 100 moves it five times one on Business', () => {
  const now = 100 * H;
  const accounts = [{ id: 'biz', plan: 'team', priority: 0, windows: [] }, { id: 'pro', plan: 'prolite', priority: 1, windows: [] }];
  const at = (t, biz, pro) => [{ t, account: 'biz', window: 'weekly', remaining_percent: biz, resets_at: now + D }, { t, account: 'pro', window: 'weekly', remaining_percent: pro, resets_at: now + 2 * D }];
  const pooled = history => usage.pooledHistory(usage.limitSamples(accounts, history, 'weekly', 'openai-codex')).map(point => Math.round(point.value * 1000) / 1000);
  // 60% of 20 units plus 60% of 100 units.
  assert.deepEqual(pooled(at(now - H, 60, 60)), [72]);
  const businessDrop = pooled([...at(now - H, 60, 60), ...at(now, 50, 60)]), proDrop = pooled([...at(now - H, 60, 60), ...at(now, 60, 50)]);
  assert.deepEqual([businessDrop.at(-1), proDrop.at(-1)], [70, 62], 'ten raw points cost 2 units on Business and 10 on Pro 100');
  assert.equal((72 - proDrop.at(-1)) / (72 - businessDrop.at(-1)), 5);
  const samples = usage.limitSamples(accounts, [...at(now - H, 60, 60), ...at(now, 50, 50)], 'weekly', 'openai-codex');
  assert.equal(usage.drainRate(samples, now, 2 * H), 12, 'the drain rate is in plan units per hour');
  const withWindows = accounts.map((account, index) => ({ ...account, label: account.id, fetched_at: now, windows: [{ key: 'weekly', window_seconds: 7 * D, remaining_percent: 50, resets_at: now + (index + 1) * D }] }));
  const projection = usage.projectPool(withWindows, [], 'weekly', now, 3 * D, { rate: 0, provider: 'openai-codex' });
  assert.deepEqual([projection.capacity, projection.current], [120, 60]);
  assert.deepEqual(projection.members.map(item => [item.id, item.plan_label, item.weight, item.assumed]), [['biz', 'Business', 20, false], ['pro', 'Pro 100', 100, false]]);
  // Each reset restores the account's own weight: Business gains 10 units, Pro 100 gains 50; what was left expires as `lost`.
  assert.deepEqual(projection.resets.map(item => [item.account, item.t - now, item.gain, item.lost, item.before]), [['biz', D, 10, 10, 60], ['pro', 2 * D, 50, 50, 70]]);
  assert.deepEqual(usage.projectPool(withWindows, [], 'five_hour', now, D, { rate: 0, provider: 'openai-codex' }).capacity, 0, 'no readings in that window, no capacity');
});

// A two-account pool for verdict cases: the priority-0 Business seat is empty and resets in 4 days, while the Pro 100 account (one percent = one unit) has `left` percent, resets in 1 day and has dropped `perHour` points every hour for the last 12 hours.
// What the backend would serve for a hand-built provider: its per-sample rows as series on the wire.
const served = provider => ({ ...provider, history: mock.limitSeries(provider.history) });
function verdictProvider(now, { provider = 'openai-codex', label = 'OpenAI Codex', plans = ['team', 'prolite'], left = 60, perHour = 0.5, stale = false, auth = 'ok', firstReset = 4 * D } = {}) {
  const history = [];
  for (let hour = 12; hour >= 0; hour--) history.push(
    { t: now - hour * H, account: 'second', window: 'weekly', remaining_percent: left + hour * perHour, resets_at: now + D },
    { t: now - hour * H, account: 'first', window: 'weekly', remaining_percent: 0, resets_at: now + firstReset });
  const win = (remaining, resets) => [{ key: 'weekly', label: 'Weekly', window_seconds: 7 * D, remaining_percent: remaining, resets_at: resets }];
  return { provider, label, auth, history, accounts: [
    { id: 'first', label: 'codex-team', priority: 0, plan: plans[0], fetched_at: now, stale, windows: win(0, now + firstReset) },
    { id: 'second', label: 'codex-pro', priority: 1, plan: plans[1], fetched_at: now, stale, windows: win(left, now + D) }] };
}

test('the verdict says waste when resets discard at least 5% of capacity and the pool never runs dry', () => {
  const now = 1_000_000, prefs = usage.USAGE_DEFAULTS;
  const verdict = usage.limitsVerdict(verdictProvider(now), prefs, now);
  // 0.5 units an hour for a day leaves 48 of Pro 100's 60 units to expire at its reset; afterwards 120 units outlast the week.
  assert.deepEqual([verdict.status, verdict.window, verdict.remaining, verdict.capacity, verdict.remaining_pct, verdict.empty_at, verdict.last_loss_at - now], ['waste', 'weekly', 60, 120, 50, null, D]);
  assert.equal(Math.round(verdict.lost * 1000) / 1000, 48); assert.equal(Math.round(verdict.lost_pct * 10) / 10, 40);
  assert.match(usage.verdictText(verdict, now), /^48 units will expire unused by [A-Z][a-z]{2}$/, 'the fact only, no advice');
  assert.deepEqual([verdict.severity, verdict.missing], ['medium', 0], '48 of 120 units lost is 40% of the capacity: orange from 30%');
  const marks = usage.wasteMarks(usage.projectPool(verdictProvider(now).accounts, verdictProvider(now).history, 'weekly', now, 7 * D, { lookbackS: 12 * H, provider: 'openai-codex' }));
  assert.deepEqual(marks.map(mark => [mark.t - now, Math.round(mark.before), Math.round(mark.lost), mark.accounts.map(item => `${item.label} ${item.plan_label}`).join()]), [[D, 48, 48, 'codex-pro Pro 100']]);
  // A loss under 5% of capacity is noise: 13% of Pro 100 at 0.5 units an hour leaves 1 unit at the reset.
  const ok = usage.limitsVerdict(verdictProvider(now, { left: 13 }), prefs, now);
  assert.deepEqual([ok.status, Math.round(ok.lost), ok.severity], ['ok', 1, null]);
  assert.match(usage.verdictText(ok, now), /^On track for the next 7 days/);
});

test('the verdict says waste when a reset discards units before the pool runs dry, keeping the run-out facts', () => {
  const now = 1_000_000;
  // Two units an hour: 12 units still expire at Pro 100's reset after a day, then its fresh 100 run out 50 hours later, 22 hours before the Business seat resets. Only spending now saves those 12, so the glyph says waste.
  const verdict = usage.limitsVerdict(verdictProvider(now, { perHour: 2 }), usage.USAGE_DEFAULTS, now);
  assert.deepEqual([verdict.status, Math.round(verdict.empty_at - now), verdict.next_reset_at - now, verdict.last_loss_at - now], ['waste', 74 * H, 4 * D, D]);
  assert.match(usage.verdictText(verdict, now), /^12 units will expire unused by [A-Z][a-z]{2}, then runs out [A-Z][a-z]{2} \d{1,2}:\d{2} (AM|PM), 22h 0m before the next reset · missing ~168 units$/, 'both facts in the order they happen, no advice');
  // Severity follows the 12 units lost (10% of capacity), not the 84 hours blocked later.
  assert.deepEqual([Math.round(verdict.lost), verdict.severity, Math.round(verdict.missing * 1000) / 1000, verdict.blocked_s], [12, 'low', 168, 84 * H]);
  // A loss under 5% of capacity is not a meaningful event: 2.4 units an hour leaves 2.4 units to expire at Pro 100's reset, so the later run-out decides.
  const small = usage.limitsVerdict(verdictProvider(now, { perHour: 2.4 }), usage.USAGE_DEFAULTS, now);
  assert.deepEqual([small.status, small.severity], ['short', 'high']);
});

test('the verdict skips a reset that discards nothing and judges the next meaningful event', () => {
  const now = 1_000_000;
  // The empty Business seat resets first, in six hours, and loses nothing; the next event is Pro 100 discarding 32 units at its reset in a day, before the pool runs dry.
  const waste = usage.limitsVerdict(verdictProvider(now, { perHour: 2, firstReset: 6 * H }), usage.USAGE_DEFAULTS, now);
  assert.deepEqual([waste.status, Math.round(waste.lost), waste.severity, waste.last_loss_at - now, Math.round(waste.empty_at - now)], ['waste', 32, 'caution', D, 74 * H]);
  // From 20 units, the same empty reset is followed by the pool running dry after 20 hours, before Pro 100 resets with nothing left to lose.
  const short = usage.limitsVerdict(verdictProvider(now, { left: 20, perHour: 2, firstReset: 6 * H }), usage.USAGE_DEFAULTS, now);
  assert.deepEqual([short.status, short.lost, Math.round(short.empty_at - now)], ['short', 0, 20 * H]);
});

test('the verdict says short when the projection hits zero before a reset, using the saved lookback', () => {
  const now = 1_000_000;
  // Two units an hour from 20: Pro 100 runs dry after 10 hours, 14 hours before its reset, so nothing expires first.
  const verdict = usage.limitsVerdict(verdictProvider(now, { left: 20, perHour: 2 }), usage.USAGE_DEFAULTS, now);
  assert.deepEqual([verdict.status, Math.round(verdict.empty_at - now), verdict.next_reset_at - now], ['short', 10 * H, D]);
  assert.match(usage.verdictText(verdict, now), /^Runs out [A-Z][a-z]{2} \d{1,2}:\d{2} (AM|PM), 14h 0m before the next reset · missing ~196 units$/, 'the facts only, no advice');
  // Missing units are the drain over every empty stretch in the week at 2 units an hour: 14 hours until Pro 100 resets, 22 hours from when its fresh 100 run out until the Business seat refills, then 62 hours from when its 20 units run out to the end of the week.
  // 98 hours blocked is over a day: red.
  assert.deepEqual([Math.round(verdict.missing * 1000) / 1000, verdict.blocked_s, verdict.severity, Math.round(verdict.lost)], [196, 98 * H, 'high', 0]);
  // The verdict reads the user's lookback: one hour of the same steady drain gives the same rate, so the same empty time.
  assert.equal(Math.round(usage.limitsVerdict(verdictProvider(now, { perHour: 2 }), { ...usage.USAGE_DEFAULTS, lookback: 1 }, now).empty_at - now), 74 * H);
  const steep = verdictProvider(now, { perHour: 2 });
  steep.history = steep.history.map(item => item.account === 'second' && item.t === now - H ? { ...item, remaining_percent: 70 } : item);
  assert.ok(usage.limitsVerdict(steep, { ...usage.USAGE_DEFAULTS, lookback: 1 }, now).empty_at < usage.limitsVerdict(steep, usage.USAGE_DEFAULTS, now).empty_at, 'a steeper last hour moves the 1h-lookback verdict earlier');
  const now0 = usage.limitsVerdict(verdictProvider(now, { left: 0, perHour: 2 }), usage.USAGE_DEFAULTS, now);
  assert.match(usage.verdictText(now0, now), /^Out of quota now, 1d 0h before the next reset · missing ~\d+ units$/);
});

test('the verdict is unknown without drain data, with stale readings or for a logged-out provider', () => {
  const now = 1_000_000, prefs = usage.USAGE_DEFAULTS;
  const flat = verdictProvider(now); flat.history = [];
  assert.deepEqual([usage.limitsVerdict(flat, prefs, now).status, usage.limitsVerdict(flat, prefs, now).remaining], ['unknown', 60], 'no drain data still reports what is left');
  assert.equal(usage.limitsVerdict(verdictProvider(now, { stale: true }), prefs, now).status, 'unknown');
  assert.equal(usage.limitsVerdict(verdictProvider(now, { auth: 'logged_out' }), prefs, now).status, 'unknown');
  assert.equal(usage.limitsVerdict(null, prefs, now).status, 'unknown');
  assert.match(usage.verdictText({ status: 'unknown' }, now), /^Not enough recent readings/);
});

test('verdict severity follows the severity bands: hours blocked for a run-out, units lost against capacity for waste', () => {
  // Blocked: from 24h red, 6h orange, 2h yellow, 15 min muted; below that no glyph.
  assert.deepEqual([24 * H, 24 * H - 1, 6 * H, 6 * H - 1, 2 * H, 2 * H - 1, 900, 899, 0, NaN].map(usage.blockedSeverity), ['high', 'medium', 'medium', 'caution', 'caution', 'low', 'low', null, null, null]);
  // Lost: from 50% of capacity red, 30% orange, 15% yellow, 5% muted; below that no glyph.
  assert.deepEqual([[60, 120], [59.99, 120], [36, 120], [35.99, 120], [18, 120], [17.99, 120], [6, 120], [5.99, 120], [0, 120]].map(([lost, capacity]) => usage.lostSeverity(lost, capacity)), ['high', 'medium', 'medium', 'caution', 'caution', 'low', 'low', null, null]);
  assert.deepEqual([usage.lostSeverity(10, 0), usage.lostSeverity(NaN, 120)], [null, null]);
  // Pro 100 at half a unit an hour loses its remaining units minus 12 at its reset: 72 units leave exactly 60 of the pool's 120 (50%), 48 leave 36 (30%), 30 leave 18 (15%), 18 leave 6 (5%), 17 leave 5.
  const now = 1_000_000, at = left => usage.limitsVerdict(verdictProvider(now, { left }), usage.USAGE_DEFAULTS, now);
  assert.deepEqual([72, 48, 30, 18, 17].map(left => { const verdict = at(left); return [verdict.status, Math.round(verdict.lost * 1000) / 1000, verdict.severity]; }),
    [['waste', 60, 'high'], ['waste', 36, 'medium'], ['waste', 18, 'caution'], ['waste', 6, 'low'], ['ok', 5, null]]);
  // A run-out shorter than 15 minutes is not an event either: half a unit an hour from 11.95 units empties Pro 100 6 minutes before its reset, and its fresh 100 units then outlast the week.
  const brief = usage.limitsVerdict(verdictProvider(now, { left: 11.95, perHour: 0.5 }), usage.USAGE_DEFAULTS, now);
  assert.deepEqual([brief.status, brief.severity, brief.empty_at], ['ok', null, null]);
});

test('accounts resetting together stack their markers in pool priority order on one vertical line', () => {
  const now = 1000;
  // Business (20 units, priority 0) is empty and Pro 100 (priority 1) holds 30 units; both reset in a day, and a second Pro 100 resets ten minutes later.
  const accounts = [account('biz', 0, 0, now + D, 7 * D, now, 'team'), account('pro', 1, 30, now + D, 7 * D, now), account('late', 2, 50, now + D + 600, 7 * D, now)];
  const projection = usage.projectPool(accounts, [], 'weekly', now, 3 * D, { rate: 0, ...codex });
  const markers = usage.resetMarkers(projection, now, now + 3 * D);
  assert.equal(markers.length, 1, 'ten minutes apart is within the 15-minute tolerance: one vertical line');
  assert.deepEqual(markers[0].accounts.map(item => [item.id, item.t - now, item.base, item.top, item.gain]), [['biz', D, 80, 100, 20], ['pro', D, 100, 170, 70], ['late', D + 600, 170, 220, 50]],
    'each segment starts where the previous account left the pool and rises by what this account restores');
  assert.equal(markers[0].t, now + D);
  const waste = usage.wasteMarks(projection);
  assert.deepEqual(waste.map(mark => [mark.t - now, mark.before, mark.lost, mark.accounts.map(item => item.id).join()]), [[D, 80, 80, 'pro,late']], 'the waste arrow of the group sits at the same x below the step');
  const apart = usage.projectPool([accounts[1], { ...accounts[2], windows: [{ ...accounts[2].windows[0], resets_at: now + D + 16 * 60 }] }], [], 'weekly', now, 3 * D, { rate: 0, ...codex });
  assert.equal(usage.resetMarkers(apart, now, now + 3 * D).length, 2, 'sixteen minutes apart are two lines');
  assert.deepEqual(usage.resetMarkers(projection, now, now + D - 1), [], 'resets beyond the visible range get no marker');
  assert.deepEqual(usage.resetMarkLines(markers[0].accounts[1], now).slice(0, 1).concat(usage.resetMarkLines(markers[0].accounts[1], now).slice(2)), ['pro · Pro 100', '+70 units restored', '30 units lost at this reset']);
  assert.match(usage.resetMarkLines(markers[0].accounts[1], now)[1], /^Resets [A-Z][a-z]{2} \d{1,2}:\d{2} (AM|PM)$/);
  assert.equal(usage.resetMarkLines(markers[0].accounts[0], now).length, 3, 'an empty account loses nothing, so its tooltip has no loss line');
});

test('past step-ups stack below the pooled level after the step', () => {
  const at = (t, account, remaining, resetsAt) => ({ t, account, window: 'weekly', remaining_percent: remaining, resets_at: resetsAt });
  const accounts = [{ id: 'biz', label: 'biz', priority: 0, plan: 'team' }, { id: 'pro', label: 'pro', priority: 1, plan: 'prolite' }];
  const samples = usage.limitSamples(accounts, [at(0, 'biz', 10, 100), at(0, 'pro', 40, 100), at(200, 'biz', 100, 100 + 7 * D), at(200, 'pro', 100, 100 + 7 * D), at(400, 'pro', 90, 100 + 7 * D)], 'weekly', 'openai-codex');
  const markers = usage.pastResetMarkers(accounts, samples, -1, 1000, 'openai-codex');
  assert.deepEqual(markers.map(group => [group.t, group.accounts.map(item => [item.id, item.base, item.top, item.gain, item.reset_at, item.plan_label])]), [[200, [['biz', 42, 60, 18, 100, 'Business'], ['pro', 60, 120, 60, 100, 'Pro 100']]]]);
  assert.deepEqual(usage.pastResetMarkers(accounts, samples, 200, 1000), [], 'a step at the range start is outside it');
});

test('a redeemed reset is judged by the weekly allowance it throws away', () => {
  const win = (key, remaining, extra = {}) => ({ key, label: key === 'weekly' ? 'Weekly' : key, remaining_percent: remaining, window_seconds: key === 'weekly' ? 604800 : 18000, ...extra });
  // Business seat: the full 5-hour window does not count, only the empty weekly one.
  const team = usage.redeemLoss('openai-codex', { plan: 'team' }, [win('five_hour', 100), win('weekly', 0)]);
  assert.deepEqual([team.win.key, team.percent, team.units], ['weekly', 0, 0]);
  const pro = usage.redeemLoss('openai-codex', { plan: 'prolite' }, [win('weekly', 59.4), win('weekly:gpt', 10, { scope: 'model' })]);
  assert.deepEqual([pro.win.key, pro.percent, pro.units], ['weekly', 59, 59], 'Pro 100 weighs 100 units, so 59% left is 59 units lost');
  assert.equal(usage.redeemWindow([win('five_hour', 50), win('monthly', 30, { window_seconds: 2592000 })]).key, 'monthly', 'without weekly, the longest account-wide window');
  assert.deepEqual([usage.redeemLoss('openai-codex', { plan: 'plus' }, [win('weekly', null)]).percent, usage.redeemLoss('openai-codex', {}, [])], [null, null]);
  assert.deepEqual(['reset', 'already_redeemed'].map(status => usage.redeemFailure({ status })), [null, null]);
  for (const status of ['nothing_to_reset', 'not_exhausted', 'no_credit', 'no_credits_banked', 'unavailable', 'surprise', undefined]) assert.equal(typeof usage.redeemFailure({ status }), 'string', String(status));
  assert.match(usage.redeemFailure({ status: 'nothing_to_reset' }), /not spent/);
});

test('banked reset credits are validated defensively and flagged by expiry', () => {
  assert.equal(usage.validBankedCredits(null), null);
  assert.equal(usage.validBankedCredits([]), null);
  const credits = usage.validBankedCredits({ fetched_at: 5, applicable_count: 2, credits: [
    { status: 'available', expires_at: 300, granted_at: 1 }, { status: 'available', expires_at: null, granted_at: null }, { status: 'available', expires_at: 100 },
    { status: 'used', expires_at: 50 }, { status: 'available', expires_at: '200' }, { status: 'available', expires_at: Infinity }, { status: 'available', expires_at: 80, granted_at: 'x' }, null, 'credit'] });
  assert.deepEqual(credits.credits.map(item => [item.expires_at, item.granted_at]), [[100, null], [300, 1], [null, null]], 'malformed, used and unparseable entries are dropped; the rest are sorted with no expiry last');
  assert.deepEqual([credits.fetched_at, credits.applicable_count], [5, 2]);
  assert.deepEqual([-1, 1.5, '2', null].map(count => usage.validBankedCredits({ applicable_count: count, credits: 'none' })).map(item => [item.applicable_count, item.credits.length]), [[null, 0], [null, 0], [null, 0], [null, 0]]);
  assert.equal(usage.validBankedCredits({ applicable_count: 0, credits: [] }).applicable_count, 0, 'zero is a real answer: the credits exist but cannot be used now');
  const win = (remaining_percent, scope = 'account') => ({ key: 'w', scope, remaining_percent });
  assert.deepEqual([[win(79.9)], [win(80), win(85)], [win(100), win(57)], [win(80), win(10, 'model')], [win(null)], []].map(usage.bankedRedeemable), [true, false, true, false, null, null], 'a reset is redeemable once any account allowance has less than 80% left; model windows and unknown readings do not count');
  const parsed = usage.validUsageLimits({ providers: [{ provider: 'openai-codex', accounts: [{ id: 'a', banked_credits: { credits: [{ status: 'available', expires_at: 10 }] } }, { id: 'b', banked_credits: 'broken' }] }] });
  assert.deepEqual(parsed.providers[0].accounts.map(account => account.banked_credits?.credits.length ?? null), [1, null]);
  const now = 1000, accounts = [{ id: 'a', label: 'codex-pro', banked_credits: { credits: [{ expires_at: now + 5 * H }, { expires_at: now + 9 * D }] } }, { id: 'b', label: 'codex-team', banked_credits: { credits: [{ expires_at: now + 5 * H + 600 }, { expires_at: null }] } }];
  const flags = usage.bankedFlags(accounts, now, now + 7 * D);
  assert.deepEqual(flags.map(flag => [flag.t - now, flag.credits.map(item => item.label).join()]), [[5 * H, 'codex-pro'], [5 * H + 600, 'codex-team']], 'one flag per expiry, even ten minutes apart; ones outside the range or without a time get none');
  const minute = 60 * 1000;
  const same = usage.bankedFlags([{ id: 'a', label: 'a', banked_credits: { credits: [{ expires_at: minute + 10 }] } }, { id: 'b', label: 'b', banked_credits: { credits: [{ expires_at: minute + 40 }, { expires_at: minute + 70 }] } }], 0, minute + D);
  assert.deepEqual(same.map(flag => flag.credits.length), [2, 1], 'credits expiring in the same minute share one flag; the next minute gets its own');
  const lines = usage.bankedFlagLines(flags[0], now);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^codex-pro · banked reset expires [A-Z][a-z]{2} \d{1,2}:\d{2} (AM|PM)$/);
});

test('empty spans start at the zero crossing and end at the refill', () => {
  assert.deepEqual(usage.emptySpans([{ t: 0, value: 10 }, { t: 10, value: 0 }, { t: 20, value: 0 }, { t: 20, value: 50 }, { t: 30, value: 40 }]), [{ start: 10, end: 20 }]);
  assert.deepEqual(usage.emptySpans([{ t: 0, value: 10 }, { t: 10, value: 0 }, { t: 10, value: 100 }]), [{ start: 10, end: 10 }], 'touching zero at a reset is a zero-length span');
  assert.deepEqual(usage.emptySpans([{ t: 0, value: 0 }, { t: 5, value: 0 }]), [{ start: 0, end: null }], 'no refill within the horizon');
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

test('usage charts plot the amount in each bucket, the bucket size being the unit', () => {
  const hourly = usage.buildUsageCharts({ ...history, resolution: '60m', bucket_minutes: 60, tz: 'UTC', buckets: [0, H, 2 * H], window_end: 3 * H }, 'provider', 'stacked');
  const daily = usage.buildUsageCharts({ ...history, buckets: [0, D, 2 * D] }, 'provider', 'stacked');
  const legacy = usage.buildUsageCharts({ ...history, resolution: 'hour', tz: 'UTC', buckets: [0, H, 2 * H] }, 'provider', 'stacked');
  assert.deepEqual([hourly.unit, daily.unit, legacy.unit], ['h', 'day', 'h'], 'backends without bucket_minutes still read as hour or day buckets');
  assert.deepEqual([10, 60, 360, 1440, 2880].map(usage.bucketUnit), ['10 min', 'h', '6 h', 'day', '2 days']);
  assert.deepEqual(hourly.charts[0].layers.map(layer => layer.upper), [[5, 1, 0], [6, 3, 3]], 'no per-day scaling');
  assert.deepEqual(hourly.charts[0].scale.ticks, [0, 2, 4, 6]);
  assert.deepEqual([hourly.charts[0].total, daily.charts[0].total], [12, 12]);
  assert.deepEqual(hourly.charts.map(chart => chart.metric.unit), ['tokens', '$', 'messages']);
  assert.deepEqual([hourly.dayLines, hourly.labelIndexes, hourly.labels], [[0], [0], ['Jan 1']], 'the hourly midnight gets a day line and a date label');
  assert.deepEqual([daily.dayLines, daily.labels], [[0, 1, 2], ['Jan 1', '2', '3']]);
});

test('sub-day buckets over several days keep their own length and are labelled by day', () => {
  // Paris, 24-26 October 2026 in 6-hour steps: the 00:00 bucket of the 25th lasts 7 hours (the clocks go back at 03:00).
  const at = text => Date.parse(text) / 1000;
  const buckets = ['2026-10-24T00:00:00+02:00', '2026-10-24T06:00:00+02:00', '2026-10-24T12:00:00+02:00', '2026-10-24T18:00:00+02:00', '2026-10-25T00:00:00+02:00', '2026-10-25T06:00:00+01:00', '2026-10-25T12:00:00+01:00', '2026-10-25T18:00:00+01:00', '2026-10-26T00:00:00+01:00'].map(at);
  const steps = { ...history, resolution: '360m', bucket_minutes: 360, tz: 'Europe/Paris', buckets, window_end: at('2026-10-26T06:00:00+01:00'),
    by_provider: [{ key: 'p', label: 'p', tokens: [6, 6, 6, 6, 7, 6, 6, 6, 3], cost_usd: [], user_messages: [] }], by_model: [] };
  const model = usage.buildUsageCharts(steps, 'provider', 'stacked');
  assert.deepEqual(model.lengths.map(seconds => seconds / H), [6, 6, 6, 6, 7, 6, 6, 6, 6]);
  assert.deepEqual([model.unit, model.charts[0].layers[0].upper], ['6 h', [6, 6, 6, 6, 7, 6, 6, 6, 3]], 'the 7-hour bucket shows its real amount');
  assert.equal(model.charts[0].total, 52);
  assert.deepEqual([model.dayLines, model.labelIndexes, model.labels], [[0, 4, 8], [0, 4, 8], ['Oct 24', '25', '26']], 'day lines and labels sit on the local midnights only');
  assert.deepEqual(usage.bucketLengths([0, 3 * H], undefined, 180), [3 * H, 3 * H], 'a missing window end falls back to the nominal length');
});

test('curve slopes pass through every value without overshooting, and stacked boundaries add their bands\' slopes', () => {
  // Ends, peaks, troughs and the edges of flat runs are flat; on a slope the centred slope is capped at three times either side.
  assert.deepEqual(usage.curveSlopes([0, 2, 4, 1, 1, 0, 0, 3, 9]), [0, 2, 0, 0, 0, 0, 0, 4.5, 0]);
  assert.deepEqual(usage.curveSlopes([0, 1, 10, 10]), [0, 3, 0, 0], 'a steep centred slope is capped at three times the gentler side, and a plateau edge is flat');
  assert.deepEqual(usage.curveSlopes([0, 1, 10, 20]), [0, 3, 9.5, 0]);
  const series = usage.usageSeries(history, 'provider', 'tokens'), stacked = usage.chartLayers(series, 'stacked'), independent = usage.chartLayers(series, 'independent');
  const own = series.map(item => usage.curveSlopes(item.values));
  assert.deepEqual(stacked.layers.map(layer => [layer.lowerSlope, layer.upperSlope]), [[[0, 0, 0], own[0]], [own[0], own[0].map((slope, index) => slope + own[1][index])]]);
  assert.deepEqual(independent.layers.map(layer => [layer.lowerSlope, layer.upperSlope]), [[[0, 0, 0], own[0]], [[0, 0, 0], own[1]]]);
  // A Hermite segment with these slopes stays inside its two end values, so a band of non-negative values never turns negative.
  const values = [0, 3, 9, 4, 4, 0, 1, 7, 7, 2], slopes = usage.curveSlopes(values);
  for (let index = 0; index < values.length - 1; index++) for (let step = 0; step <= 20; step++) {
    const t = step / 20, a = values[index], b = values[index + 1];
    const v = (2 * t ** 3 - 3 * t ** 2 + 1) * a + (t ** 3 - 2 * t ** 2 + t) * slopes[index] + (-2 * t ** 3 + 3 * t ** 2) * b + (t ** 3 - t ** 2) * slopes[index + 1];
    assert.ok(v >= Math.min(a, b) - 1e-9 && v <= Math.max(a, b) + 1e-9, `segment ${index} at ${t}: ${v} outside [${a}, ${b}]`);
  }
});

test('model series are split by model alone and keep their bare model labels', () => {
  const merged = { buckets: [0], by_model: [{ key: 'gpt', label: 'gpt', provider: null, tokens: [6] }, { key: 'c', label: 'c', provider: 'anthropic', tokens: [2] }] };
  assert.deepEqual(usage.usageSeries(merged, 'model', 'tokens').map(item => [item.key, item.label]), [['gpt', 'gpt'], ['c', 'c']]);
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
  assert.match(providers.get('anthropic'), /oklch\(0\.72 0\.15 45\)/); assert.match(providers.get('openai-codex'), /oklch\(0\.8 0 0\)/, 'OpenAI draws in light grey, not a hue');
});

test('preferences validate every field and fall back to safe defaults', () => {
  assert.deepEqual(usage.validUsagePreferences(null), usage.USAGE_DEFAULTS);
  const range = { weekly: { past: 720, future: 24 }, session: { past: 168, future: 5 } };
  assert.deepEqual(usage.validUsagePreferences({ days: 30, split: 'model', mode: 'independent', lookback: 72, window: 'five_hour', range, accounts: { 'openai-codex': true, anthropic: false } }),
    { days: 30, split: 'model', mode: 'independent', lookback: 72, window: 'five_hour', range, accounts: { 'openai-codex': true, anthropic: false } });
  assert.deepEqual(usage.validUsagePreferences({ days: '7', split: 1, mode: 'stack', lookback: 6, window: '', range: 'wide', accounts: 'open' }), usage.USAGE_DEFAULTS);
  // Saved before the overview: the Usage|Limits tab and the provider picked by the retired Limits tabs are dropped.
  const legacy = usage.validUsagePreferences({ tab: 'limits', provider: 'anthropic' });
  assert.deepEqual([Object.hasOwn(legacy, 'tab'), Object.hasOwn(legacy, 'provider')], [false, false]);
  // The retired 7d | 30d horizon is dropped; each of the four ranges keeps only a stop of its own window group, else its default (weekly 7d past, 7d ahead; session 5h past, 1d ahead).
  assert.equal(Object.hasOwn(usage.validUsagePreferences({ horizon: 30 }), 'horizon'), false);
  assert.deepEqual(usage.LIMITS_RANGE_STOPS, { weekly: [24, 168, 720], session: [5, 24, 168] });
  assert.deepEqual(usage.validUsagePreferences({ range: { weekly: { past: 5, future: 720 }, session: { past: '24', future: 168 } } }).range, { weekly: { past: 168, future: 720 }, session: { past: 5, future: 168 } });
  assert.deepEqual(usage.validUsagePreferences({ range: { weekly: null, session: [] } }).range, { weekly: { past: 168, future: 168 }, session: { past: 5, future: 24 } });
  assert.deepEqual(['five_hour', 'five_hour:opus', 'weekly', 'weekly:opus', 'w7200', undefined].map(usage.rangeGroup), ['session', 'session', 'weekly', 'weekly', 'weekly', 'weekly']);
  for (const bad of ['12', 0, 13, 1000, null, Infinity]) assert.equal(usage.validUsagePreferences({ lookback: bad }).lookback, 12, `lookback ${bad} falls back to 12h`);
  // Account folds keep only booleans under provider-shaped keys; anything else reads as folded.
  assert.deepEqual(usage.validUsagePreferences({ accounts: { a: true, b: 'yes', c: 1, '': true, ['x'.repeat(201)]: true, d: false } }).accounts, { a: true, d: false });
  assert.deepEqual([usage.validUsagePreferences({ accounts: [true] }).accounts, usage.validUsagePreferences({ accounts: null }).accounts], [{}, {}]);
  mock.control.storageReadError = true;
  assert.deepEqual(usage.readUsagePreferences(mock.ctx.storage), usage.USAGE_DEFAULTS);
  mock.control.storageReadError = false; mock.control.storageWriteError = true;
  assert.equal(usage.writeUsagePreferences(mock.ctx.storage, { days: 30 }), false);
});

test('overview order puts providers with accounts first and logged-out ones last, otherwise keeping the backend order', () => {
  const out = { provider: 'xai', auth: 'logged_out', accounts: [] }, empty = { provider: 'nous', accounts: [] }, first = { provider: 'openai-codex', accounts: [{ id: 'a' }] }, second = { provider: 'anthropic', accounts: [{ id: 'b' }] };
  assert.deepEqual(usage.limitsProviderOrder([out, empty, first, second]).map(item => item.provider), ['openai-codex', 'anthropic', 'nous', 'xai']);
  assert.deepEqual(usage.limitsProviderOrder([second, out, first]).map(item => item.provider), ['anthropic', 'openai-codex', 'xai']);
  const windows = usage.sharedWindowCatalog([{ accounts: [{ windows: [{ key: 'weekly', label: 'Weekly' }] }], history: [] }, { accounts: [{ windows: [{ key: 'five_hour', label: '5-hour' }, { key: 'weekly', label: 'Weekly' }] }], history: [] }, { auth: 'logged_out', accounts: [{ windows: [{ key: 'w7200' }] }], history: [] }]);
  assert.deepEqual(windows.map(item => item.key), ['five_hour', 'weekly'], 'the shared selector offers every logged-in provider\'s windows');
  assert.deepEqual([usage.chartWindow(windows, 'five_hour')?.key, usage.chartWindow([{ key: 'weekly' }], 'five_hour')?.key, usage.chartWindow([{ key: 'w7200' }], 'five_hour')?.key, usage.chartWindow([], 'weekly')], ['five_hour', 'weekly', 'w7200', null]);
  // Model-scoped windows are numbered in selector order across providers; account-wide ones keep their label.
  const scoped = usage.sharedWindowCatalog([{ accounts: [{ windows: [{ key: 'weekly:sonnet', label: 'Sonnet week' }, { key: 'weekly', label: 'Weekly' }] }], history: [] }, { accounts: [{ windows: [{ key: 'weekly:fable', label: 'Fable week' }, { key: 'five_hour', label: '5-hour' }] }], history: [] }]);
  assert.deepEqual(usage.windowOptions(scoped).map(item => `${item.id}=${item.label}`), ['five_hour=5-hour', 'weekly=Weekly', 'weekly:fable=Model limit #1', 'weekly:sonnet=Model limit #2']);
});

// Sidebar footer and registration -----------------------------------------------------------------------------------
const ADVICE = /cut optional|background work|room for|optional work/i;
// Page parts name their tooltip for the page's shared tooltip, or in a native title on hosts without it.
const tipText = node => node.getAttribute('data-sf-tip') ?? node.getAttribute('title');
const adviceFree = () => !ADVICE.test(document.body.textContent) && $$('[aria-label]').every(node => !ADVICE.test(node.getAttribute('aria-label'))) && $$('[title],[data-sf-tip]').every(node => !ADVICE.test(tipText(node)));
test('Usage and Limits register as two routes and the sidebar footer has the Usage icon button then one Limits button', async () => {
  plugin.register(mock.ctx);
  assert.deepEqual([page().area, page().title, page().data.path], ['routes', 'Usage', '/t3sidebar-usage']);
  assert.deepEqual([limitsPage().area, limitsPage().title, limitsPage().data.path], ['routes', 'Limits', '/t3sidebar-limits']);
  assert.equal(mock.control.contributions[0].id, 'sidebar', 'the sidebar pane stays the first contribution');
  await render(mock.control.contributions[0]);
  const footer = $('.sf > footer.sf-footer');
  assert.equal(footer !== null, true); assert.equal($('.sf').lastElementChild?.className, 'sf-footer', 'the footer is the last row of the pane');
  const buttons = [...footer.querySelectorAll('button')];
  // Icon-only Usage: the name comes from aria-label and the tooltip, never from visible text.
  assert.deepEqual(buttons.map(node => node.className), ['sf-limits', 'sf-utility'], 'exactly two controls: the single Limits button on the left, then Usage on the right');
  assert.deepEqual([buttons[1].getAttribute('aria-label'), buttons[1].textContent, buttons[1].getAttribute('title'), buttons[1].querySelector('svg')?.getAttribute('data-icon')], ['Usage', '', 'Token usage', 'ChartNoAxesColumn']);
  assert.deepEqual($$('.sf-footer .sf-limit').map(node => node.dataset.provider), ['openai-codex', 'anthropic'], 'the default fixture has two logged-in providers');
  await click(buttons[1]); await click(buttons[0]);
  assert.deepEqual(mock.calls.filter(call => call[0] === 'navigate').map(call => call[1]), ['/t3sidebar-usage', '/t3sidebar-limits']);
  assert.equal(Object.hasOwn(mock.ctx.storage.get('usage-preferences') ?? {}, 'provider'), false, 'opening the Limits page picks no provider');
  assert.equal(adviceFree(), true);
});

// Page rendering -----------------------------------------------------------------------------------------------------
const seriesCount = metric => $$(`.su-chart[data-metric="${metric}"] svg g[data-series]`).length;
const restPaths = () => mock.calls.filter(call => call[0] === 'rest').map(call => call[1]);

test('the Usage page draws three charts from /usage/history only and toggles split and mode', async () => {
  plugin.register(mock.ctx); await render(page());
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.deepEqual(restPaths(), [`/usage/history?days=7&tz=${encodeURIComponent(tz)}`]);
  // Each route shows only its own content: no Usage|Limits switch and no limits chart here.
  assert.deepEqual([$('.su').dataset.view, button('Usage') === undefined, button('Limits') === undefined, $('.su-pooled') === null], ['usage', true, true, true]);
  assert.deepEqual($$('.su-chart').map(node => node.dataset.metric), ['tokens', 'cost_usd', 'user_messages']);
  assert.equal($('.su-chart[data-metric="cost_usd"] .su-sub').textContent, 'API-equivalent');
  assert.deepEqual([seriesCount('tokens'), seriesCount('cost_usd'), seriesCount('user_messages')], [2, 2, 2]);
  // Largest first in the legend, largest band stacked last (on top): openai-codex leads tokens, anthropic (priced higher) leads cost.
  const order = (metric, selector) => $$(`.su-chart[data-metric="${metric}"] ${selector}`).map(node => node.dataset.series).join();
  assert.deepEqual([order('tokens', '.su-legend-item'), order('tokens', 'svg g[data-series]'), order('cost_usd', '.su-legend-item'), order('cost_usd', 'svg g[data-series]')],
    ['openai-codex,anthropic', 'anthropic,openai-codex', 'anthropic,openai-codex', 'openai-codex,anthropic']);
  assert.equal($$('.su-xaxis').length, 3, 'every chart has its own time axis, as on the Limits page');
  assert.match($('.su-chart[data-metric="tokens"] .su-total').textContent, /^[\d.]+[KMB]? \/ 7 days$/, 'the total names the period shown');
  assert.match($('.su-footnote').textContent, /approximate/); assert.doesNotMatch($('.su-footnote').textContent, /No price available/, 'every fixture model is priced');
  const stackedArea = $('.su-chart[data-metric="tokens"] g[data-series="openai-codex"] .su-area').getAttribute('d');
  await click(button('Model'));
  assert.equal(seriesCount('tokens'), 4); assert.equal(seriesCount('cost_usd'), 4);
  await click(button('Provider'));
  await click(button('Independent'));
  assert.equal(seriesCount('tokens'), 2);
  assert.notEqual($('.su-chart[data-metric="tokens"] g[data-series="openai-codex"] .su-area').getAttribute('d'), stackedArea, 'independent bands no longer sit on the series below');
  assert.deepEqual(mock.ctx.storage.get('usage-preferences'), { ...usage.USAGE_DEFAULTS, mode: 'independent' });
  // The period is an unfold control beside every chart's x axis, not a header selector; it is one page-wide preference.
  assert.deepEqual(['24h', '7d', '30d', '90d'].map(label => button(label) === undefined), [true, true, true, true]);
  assert.deepEqual($$('.su-axis-range').map(node => `${node.closest('.su-chart')?.dataset.metric}:${node.dataset.side}:${node.dataset.hours}`), ['tokens:past:168', 'cost_usd:past:168', 'user_messages:past:168']);
  const arrows = () => $$('.su-chart[data-metric="cost_usd"] .su-axis-range [data-direction]').map(node => `${node.dataset.direction}:${node.getAttribute('aria-label')}:${node.disabled}`);
  assert.deepEqual(arrows(), ['left:Show 30d before Now:false', 'right:Show 1d before Now:false']);
  // The unit opens the line under each title and the legend follows on the same line; no 0 tick label on any chart.
  assert.deepEqual($$('.su-chart').map(chart => [...chart.querySelector('.su-chart-sub').children].map(node => node.className).join()), ['su-yunit,su-legend', 'su-yunit,su-legend', 'su-yunit,su-legend']);
  assert.deepEqual($$('.su-yaxis span').filter(node => /^\$?0(\.00)?$/.test(node.textContent)).length, 0);
  await click($('.su-chart[data-metric="cost_usd"] .su-axis-range [data-direction=right]'));
  assert.deepEqual($$('.su-axis-range').map(node => node.dataset.hours), ['24', '24', '24'], 'a change on one chart applies to all three');
  assert.equal(restPaths().at(-1), `/usage/history?days=1&tz=${encodeURIComponent(tz)}`);
  assert.equal(mock.ctx.storage.get('usage-preferences').days, 1);
  assert.deepEqual($$('.su-total-label').map(node => node.textContent), Array(3).fill('/ day'));
  assert.deepEqual(arrows(), ['left:Show 7d before Now:false', 'right:Shortest past shown:true']);
  // A curve through the 144 ten-minute buckets: one cubic segment between each pair, its anchors on the buckets' x positions.
  const line = $$('.su-chart[data-metric="tokens"] svg g[data-series] .su-line')[0].getAttribute('d');
  const anchors = [...line.matchAll(/(?:^M| )(-?[\d.]+),(-?[\d.]+)(?= C|$)/g)].map(match => Number(match[1]));
  assert.deepEqual([line.split(' C').length, anchors.length, anchors.every((x, index) => Math.abs(x - index / 143 * 1000) < 0.01)], [144, 144, true], 'the day view has 144 ten-minute buckets');
  assert.deepEqual($$('.su-yunit').map(node => node.textContent), ['tokens / 10 min', '$ / 10 min', 'messages / 10 min']);
  await key($('.su-chart[data-metric="user_messages"] .su-plot'), 'End');
  // The tooltip gives each bucket's real amount, no per-day rate.
  const tipValues = $$('.su-chart[data-metric="user_messages"] .su-tip-row b').map(node => Number(node.textContent.replace(/,/g, '')));
  assert.deepEqual([tipValues.length, tipValues.at(-1), $$('.su-tip-raw').length], [3, tipValues[0] + tipValues[1], 0]);
});

// A manual frame queue stands in for requestAnimationFrame, so a test steps glides at chosen timestamps. As in a browser, handles only grow, so cancelling one never hits another frame, and a step runs only the frames requested before it that are still pending.
function fakeFrames(t, reduced) {
  const frames = new Map(), saved = { raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame, media: globalThis.matchMedia };
  let last = 0;
  Object.assign(globalThis, { requestAnimationFrame: callback => { frames.set(++last, callback); return last; }, cancelAnimationFrame: handle => { frames.delete(handle); }, matchMedia: () => ({ matches: reduced() }) });
  t.after(() => Object.assign(globalThis, { requestAnimationFrame: saved.raf, cancelAnimationFrame: saved.caf, matchMedia: saved.media }));
  const run = async time => act(async () => {
    for (const handle of [...frames.keys()]) { const callback = frames.get(handle); if (callback) { frames.delete(handle); callback(time); } }
  });
  return { frames, run };
}

test('a usage period change glides all three charts: a longer period widens once it arrives, a shorter one zooms in on the old drawing first', async t => {
  let reduce = false;
  const { frames, run } = fakeFrames(t, () => reduce);
  plugin.register(mock.ctx); await render(page());
  const charts = () => $$('.su-chart[data-metric]'), gliding = () => charts().map(chart => chart.dataset.gliding ?? '').join();
  const boxes = () => charts().map(chart => chart.querySelector('.su-plot > svg').getAttribute('viewBox')), box = () => boxes()[0].split(' ').map(Number);
  const days = () => $$('.su-chart[data-metric="user_messages"] .su-day-grid').length, translated = () => $$('.su-xaxis > span').filter(node => node.style.translate !== '').length;
  const settled = Array(3).fill('0 0 1000 100').join();
  const step = direction => click($(`.su-axis-range [data-direction=${direction}]`));
  assert.deepEqual([gliding(), boxes().join(), days()], [',,', settled, 7], 'nothing glides on the first render');
  // 7d → 30d: the 30-day payload is drawn when it arrives, and the glide opens on the old seven days at its right end.
  await step('left');
  let [left, , width] = box();
  assert.deepEqual([gliding(), days(), new Set(boxes()).size], ['true,true,true', 30, 1], 'all three charts glide on the 30-day drawing, through one window');
  // The 7-day span ends with the hour in progress, a few hours after the last 6-hour bucket starts, so it reaches just past the 30-day drawing's right edge.
  assert.ok(left > 22 / 30 * 1000 && left < 24 / 30 * 1000 && left + width > 995 && left + width < 1010 && translated() > 0, `the glide opens on the last seven days (${boxes()[0]})`);
  await run(1000); await run(1110);
  [left, , width] = box();
  assert.ok(left > 0 && left < 22 / 30 * 1000 && width > 7 / 30 * 1000 && width < 1000, `half way the window is between the periods (${boxes()[0]})`);
  await run(1300);
  assert.deepEqual([gliding(), boxes().join(), translated(), frames.size], [',,', settled, 0, 0], 'settled: the React viewBox is back and every translate is cleared');
  // 30d → 7d: the 30-day drawing stays while the glide zooms in on the last seven days, then the 7-day payload is drawn once, at the end.
  await step('right');
  assert.deepEqual([gliding(), days(), boxes()[0]], ['true,true,true', 30, '0.000 0 1000.000 100'], 'the click keeps the wide drawing');
  await run(1500); await run(1610);
  [left, , width] = box();
  assert.ok(left > 0 && left < 22 / 30 * 1000 && days() === 30, `half way it zooms inside the same drawing (${boxes()[0]})`);
  await run(1800);
  assert.deepEqual([gliding(), boxes().join(), translated(), days()], [',,', settled, 0, 7], 'the 7-day period is drawn once, at the end');
  // Reduced motion: the period changes instantly.
  reduce = true;
  await step('left');
  assert.deepEqual([gliding(), boxes().join(), days(), frames.size], [',,', settled, 30, 0]);
});

test('hovering a bucket synchronizes the crosshair and tooltip across all three charts', async () => {
  plugin.register(mock.ctx); await render(page());
  await key($('.su-chart[data-metric="tokens"] .su-plot'), 'End');
  assert.equal($$('.su-cross').length, 3);
  const tips = $$('.su-tip');
  assert.equal(tips.length, 3);
  const rows = tips[0].querySelectorAll('.su-tip-row');
  assert.deepEqual([...rows].map(row => row.querySelector('span:nth-child(2)').textContent), ['openai-codex', 'anthropic', 'Total'], 'two providers, largest first, then the total');
  await key($('.su-chart[data-metric="tokens"] .su-plot'), 'Escape');
  assert.equal($$('.su-tip').length, 0);
});

test('preferences persist through a remount and the page shows empty and error states', async () => {
  // Saved before the pages were split: the old tab key must not matter.
  mock.ctx.storage.set('usage-preferences', { tab: 'limits', days: 30, split: 'model', mode: 'independent', horizon: 7 });
  mock.control.usageHistory = { generated_at: 1, days: 30, tz: 'UTC', resolution: 'day', buckets: [1, 2], by_provider: [], by_model: [], totals: { tokens: 0, cost_usd: 0, user_messages: 0 }, pricing_missing: ['mystery/model-x'] };
  plugin.register(mock.ctx); await render(page());
  assert.match(restPaths()[0], /^\/usage\/history\?days=30&/);
  assert.equal(button('Model').getAttribute('aria-pressed'), 'true'); assert.equal(button('Independent').getAttribute('aria-pressed'), 'true');
  assert.equal($('.su-state').textContent, 'No usage recorded in this period.');
  assert.match($('.su-footnote').textContent, / No price available for: mystery\/model-x \(counted as \$0\)\.$/);
  await act(async () => root.unmount()); root = null; mock.queryClient.clear();
  mock.control.usageHistory = undefined; mock.control.usageError = '404 backend not enabled';
  await render(page());
  assert.equal($('.su-state[role=alert]').textContent, 'Usage history unavailable: 404 backend not enabled Retry');
  mock.control.usageError = null;
  await click(button('Retry'));
  assert.equal(seriesCount('tokens'), 4);
});

test('a refetch behind shown data spins the refresh icon on both pages instead of showing text', async () => {
  plugin.register(mock.ctx);
  for (const contribution of [page(), limitsPage()]) {
    await render(contribution);
    const refresh = () => $('.su-refresh');
    assert.deepEqual([refresh().dataset.spinning, refresh().getAttribute('aria-label')], ['false', 'Refresh']);
    let release; mock.control.usageGate = new Promise(resolve => { release = resolve; });
    await click(refresh());
    assert.deepEqual([refresh().dataset.spinning, refresh().getAttribute('aria-busy'), refresh().getAttribute('aria-label'), refresh().disabled], ['true', 'true', 'Updating', true]);
    assert.ok(!document.body.textContent.includes('Updating'), 'no visible Updating text');
    mock.control.usageGate = null; release(); await tick(); await tick();
    assert.deepEqual([refresh().dataset.spinning, refresh().getAttribute('aria-label')], ['false', 'Refresh']);
    await act(async () => root.unmount()); root = null;
  }
});

async function slide(node, value) {
  assert.ok(node, 'slider exists');
  await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(node, String(value)); node.dispatchEvent(new window.Event('input', { bubbles: true })); });
  await tick(); await tick();
}
// The lookback slider lives in a popover behind the pencil after the first chart's "Average over" label; open it once and reuse it.
async function lookbackSlider() {
  if (!$('.su-lookback')) await click($('.su-measure[data-kind="average"] .su-lookback-edit'));
  return $('.su-lookback input[type=range]');
}

test('the Limits page is one overview of every provider under a shared controls bar', async () => {
  plugin.register(mock.ctx); await render(limitsPage());
  assert.deepEqual(restPaths(), ['/usage/limits?hours=168'], 'the Limits page fetches only its own endpoint');
  assert.deepEqual([$('.su').dataset.view, button('Usage') === undefined, $('.su-chart[data-metric]') === null], ['limits', true, true]);
  assert.deepEqual([$$('.su-provider-tabs').length, $$('button.su-provider').length], [0, 0], 'no provider tabs');
  assert.deepEqual($$('.su-provider-limits').map(node => node.dataset.provider), ['openai-codex', 'anthropic']);
  assert.deepEqual($$('.su-provider-head').map(node => [node.textContent, node.querySelector('svg[data-provider-mark]')?.dataset.providerMark]), [['OpenAI Codex', 'openai-codex'], ['Anthropic', 'anthropic']]);
  // One chart per provider with data, each in its own section with its own headline and verdict.
  assert.deepEqual($$('.su-provider-limits').map(node => node.querySelectorAll('.su-pooled').length), [1, 1]);
  assert.deepEqual($$('.su-pooled').map(node => [node.dataset.window, node.getAttribute('aria-label')]), [['weekly', 'OpenAI Codex pooled remaining quota'], ['weekly', 'Anthropic pooled remaining quota']], 'weekly is the default window');
  // Business (20 units) plus Pro 100 (100 units), and one Max 20x (200 weekly units): pools count capacity in plan units, not percent.
  assert.deepEqual($$('.su-capacity').map(node => node.textContent), ['/ 120 units', '/ 200 units']);
  assert.equal($$('.su-composition').length, 0, 'the plan list stays in the Accounts fold, not the headline');
  assert.equal($$('.su-pool').every(node => /^\d+(\.\d)?$/.test(node.textContent)), true);
  // The drain rate is only in each chart's averaging label under the plot, not repeated in the headline.
  assert.deepEqual([$$('.su-rate').length, $$('.su-measure[data-kind="average"]').every(node => / · ~\d+(\.\d)? units \/ h$/.test(node.textContent))], [0, true]);
  assert.deepEqual($$('.su-pooled').map(chart => [...chart.querySelectorAll('.su-yaxis span')].map(node => node.textContent).join()), ['25,50,75,100,120', '50,100,150,200'], 'no unit caption and no 0 label beside the past range control');
  assert.deepEqual($$('.su-verdict').map(node => node.closest('.su-provider-limits').dataset.provider), ['openai-codex', 'anthropic']);
  assert.equal($$('.su-pooled .su-line.su-past').length + $$('.su-pooled .su-line.su-projected').length + $$('.su-now').length, 6);
  assert.ok($$('.su-pooled')[1].querySelectorAll('.su-day-grid').length >= 13, 'a week of past plus a week ahead crosses at least thirteen midnights');
  assert.equal($('.su-legend') === null, true, 'the Remaining/Projected legend is gone');
  // Reset times are markers in the charts now, never a Next reset line; no wording anywhere still says plan units.
  assert.deepEqual([/Next reset/.test(document.body.textContent), /plan units/i.test(document.body.textContent), $$('[title],[data-sf-tip]').some(node => /plan units/i.test(tipText(node)))], [false, false, false]);
  // One controls bar at the top: window and refresh, none of them repeated per chart; the past and future ranges sit beside each chart's x axis and the lookback is edited from each averaging label.
  const bar = $('.su-limits-controls');
  // The bar sits in its own fixed strip above the scrolling pane, so it stays visible whatever is scrolled.
  assert.deepEqual([bar.parentElement.className, bar.parentElement.parentElement.className, bar.closest('.su-scroll') === null, $('.su-scroll').contains($('.su-overview'))], ['su-top', 'su', true, true], 'the controls head the page outside the scrolling pane');
  assert.equal(bar.compareDocumentPosition($('.su-provider-limits')) & 4, 4, 'the controls come before the first section');
  assert.deepEqual([$$('.su-lookback').length, $$('.su-horizon').length, $$('.su [role=group][aria-label=Window]').length, $$('.su [role=group][aria-label=Horizon]').length], [0, 0, 1, 0], 'the lookback slider is not shown until asked for');
  assert.deepEqual([bar.querySelector('.su-axis-range') === null, bar.querySelector('[aria-label=Window]') !== null, bar.querySelector('[aria-label=Refresh]') !== null], [true, true, true]);
  assert.deepEqual($$('.su-pooled').map(chart => [...chart.querySelectorAll('.su-limits-grid > .su-axis-range')].map(node => node.dataset.side).join()), ['past,future', 'past,future'], 'every chart has its own past and future range controls');
  // Each chart's averaging label ends with a pencil that opens the shared lookback slider in a popover.
  const edits = $$('.su-measure[data-kind="average"] .su-measure-label').map(label => { const edit = label.lastElementChild;
    return [edit.classList.contains('su-lookback-edit'), edit.getAttribute('aria-label'), edit.getAttribute('aria-expanded'), edit.querySelector('svg') !== null]; });
  assert.deepEqual(edits, [[true, 'Edit averaging period', 'false', true], [true, 'Edit averaging period', 'false', true]]);
  await lookbackSlider();
  assert.deepEqual([$$('.su-lookback').length, $('.su-lookback').closest('.su') === null, $('.su-lookback-edit').getAttribute('aria-expanded')], [1, true, 'true'], 'one slider, in a popover outside the page');
  const range = $('.su-lookback input[type=range]');
  // The chosen period sits left of the track, since the label above names the period actually averaged, which is shorter with less history.
  const value = $('.su-lookback-value');
  assert.deepEqual([$('.su-lookback').textContent, value.parentElement.firstElementChild === value, value.getAttribute('aria-hidden'), range.getAttribute('aria-label'), range.getAttribute('aria-valuetext')], ['12h', true, 'true', 'Averaging period', '12h']);
  await slide(range, 1);
  assert.equal($('.su-lookback-value').textContent, '15d', 'the value follows the thumb');
  await slide($('.su-lookback input[type=range]'), 6);
  // The popover hangs from a zero-size anchor at the averaging arrow's Now end, right-aligned to it.
  const anchor = $('.su-measures .su-lookback-anchor'), arrowEnd = $('.su-measure[data-kind="average"] .su-measure-span');
  assert.ok(Math.abs(parseFloat(anchor.style.left) - (parseFloat(arrowEnd.style.left) + parseFloat(arrowEnd.style.width))) < 1e-6, 'the anchor sits on the arrow\'s right end');
  assert.deepEqual([...bar.querySelectorAll('[aria-label=Window] button')].map(node => node.textContent), ['5-hour', 'Weekly']);
  // Account details are folded under each chart; the shared footnote appears once at the bottom.
  assert.equal($$('.su-account').length, 0, 'accounts are folded by default');
  assert.deepEqual($$('.su-disclosure').map(node => [node.getAttribute('aria-label'), node.getAttribute('aria-expanded')]), [['Accounts (2)', 'false'], ['Accounts (1)', 'false']]);
  // The folded card previews its accounts by name; the label and count stay separate spans so the count can be quieter.
  assert.deepEqual([...$('.su-disclosure').children].slice(1).map(node => `${node.className}|${node.textContent}`), ['su-disclosure-label|Accounts', 'su-disclosure-count|2', 'su-disclosure-names|codex-team · codex-pro']);
  assert.equal($$('.su-footnote').length, 1);
  assert.match($('.su-footnote').textContent, /^Sampled every 5m · last sample .*averaged over the selected period.*20 units = one \$20 plan's allowance/);
  assert.equal($('.su-overview').lastElementChild.className, 'su-footnotes', 'the footnotes close the page');
  assert.equal(button('3d'), undefined, 'the 1d/3d/7d horizon control is gone');
  await click(button('5-hour'));
  assert.deepEqual($$('.su-pooled').map(node => node.dataset.window), ['five_hour', 'five_hour'], 'the window choice applies to every chart');
  // The Pro 100 account has no five-hour window, so Codex's five-hour pool is the Business seat alone; Max 20x is 400 units in five hours. The verdicts keep judging the weekly pools.
  assert.deepEqual($$('.su-capacity').map(node => node.textContent), ['/ 20 units', '/ 400 units']);
  assert.deepEqual($$('.su-verdict').map(node => [node.dataset.window, node.textContent.startsWith('Weekly: ')]), [['weekly', true], ['weekly', true]]);
  assert.equal(mock.ctx.storage.get('usage-preferences').window, 'five_hour');
  assert.equal(adviceFree(), true, 'no verdict, label or title gives advice');
});

test('the shared lookback and the page-wide axis ranges change every chart at once', async () => {
  // The synthetic drain follows office hours, so at some times of day the 12h and 15d averages coincide; pin the same weekday afternoon as the browser smoke.
  const realNow = Date.now, fixed = Date.parse('2026-10-28T15:00:00+01:00');
  Date.now = () => fixed;
  try {
    plugin.register(mock.ctx); await render(limitsPage());
    const rates = () => $$('.su-measure[data-kind="average"]').map(node => node.textContent.split(' · ')[1]);
    const before = rates();
    await slide(await lookbackSlider(), 1);
    assert.equal($('.su-lookback input[type=range]').getAttribute('aria-valuetext'), '15d');
    const after = rates();
    assert.deepEqual(after.map((text, index) => text !== before[index] && /^(~\d+(\.\d)? units \/ h|no drain data)$/.test(text)), [true, true], `every provider's rate follows the slider (${before} → ${after})`);
    // The fixtures hold ten days of history, so a 15d lookback averages over those ten days.
    assert.deepEqual($$('.su-measure[data-kind="average"]').map(node => node.textContent.split(' · ')[0]), ['Average over 10d', 'Average over 10d']);
    const spans = () => $$('.su-pooled .su-plot').map(node => Math.round((Number(node.dataset.end) - Number(node.dataset.start)) / D * 100) / 100);
    assert.deepEqual(spans(), [14, 14]);
    // Either chart's arrows set the page-wide range, so the other chart follows.
    await click($$('.su-pooled')[1].querySelector('.su-axis-range[data-side=future] [data-direction=right]'));
    assert.deepEqual([spans(), $$('.su-pooled').map(node => node.dataset.future)], [[37, 37], ['720', '720']], 'one future choice extends every chart');
    await click($$('.su-pooled')[0].querySelector('.su-axis-range[data-side=past] [data-direction=left]'));
    assert.deepEqual([spans(), $$('.su-pooled').map(node => node.dataset.past)], [[60, 60], ['720', '720']], 'one past choice extends every chart');
    await click($('.su-axis-range[data-side=future] [data-direction=left]'));
    await click($('.su-axis-range[data-side=past] [data-direction=right]'));
    assert.deepEqual(spans(), [14, 14]);
  } finally { Date.now = realNow; }
});

test('account details are folded by default and each provider remembers its own fold across a remount', async () => {
  plugin.register(mock.ctx); await render(limitsPage());
  const section = id => $(`.su-provider-limits[data-provider="${id}"]`);
  const toggle = id => section(id).querySelector('.su-disclosure');
  await click(toggle('openai-codex'));
  assert.deepEqual([toggle('openai-codex').getAttribute('aria-expanded'), toggle('anthropic').getAttribute('aria-expanded')], ['true', 'false']);
  assert.equal(toggle('openai-codex').getAttribute('aria-controls'), section('openai-codex').querySelector('.su-accounts').id);
  assert.deepEqual([section('openai-codex').querySelectorAll('.su-account').length, section('anthropic').querySelectorAll('.su-account').length], [2, 0]);
  assert.deepEqual(mock.ctx.storage.get('usage-preferences').accounts, { 'openai-codex': true });
  // Open, the card holds the account cards and drops the name preview they would repeat.
  assert.deepEqual([section('openai-codex').querySelector('.su-accounts').parentElement.className, toggle('openai-codex').querySelector('.su-disclosure-names') === null, toggle('anthropic').querySelector('.su-disclosure-names') !== null], ['su-accounts-group', true, true]);
  const first = $('.su-account[data-account="acct-team"]');
  assert.match(first.querySelector('.su-account-head').textContent, /^codex-teampriority0Business20 units/);
  assert.equal($$('.su-badge').some(node => /banked|usable/.test(node.textContent)), false, 'banked resets have no header pill: the redeem button carries their state');
  const plan = (id, part = '.su-badge[data-badge=plan]') => [...$(`.su-account[data-account="${id}"] ${part}`).children].map(half => `${half.dataset.tone ?? ''}|${half.textContent}`).join(' ');
  assert.equal(plan('acct-prolite'), '|Pro 100 primary|100 units', 'the plan pill splits, units in the primary colour');
  assert.equal(plan('acct-prolite', '.su-badge[data-badge=priority]'), '|priority primary|1', 'the priority pill splits, its number in the primary colour');
  assert.equal($('.su-assumed') === null, true, 'every plan is in the capacity table');
  assert.equal(first.querySelectorAll('.su-window').length, 2);
  assert.equal(first.querySelectorAll('.su-pace').length, 2, 'every window with a length and reset time has a pace tick');
  // In the mixed fixture both Codex accounts reset together tomorrow.
  assert.match(first.querySelector('.su-window[data-window="weekly"] .su-window-reset').textContent, /^resets in (23h \d+m|1d 0h)$/);
  await act(async () => root.unmount()); root = null; mock.queryClient.clear();
  await render(limitsPage());
  assert.deepEqual([toggle('openai-codex').getAttribute('aria-expanded'), toggle('anthropic').getAttribute('aria-expanded'), $$('.su-account').length], ['true', 'false', 2], 'the fold survives a remount');
  await click(toggle('anthropic'));
  assert.equal(plan('acct-claude'), '|Max 20x primary|200 units');
  await click(toggle('openai-codex'));
  assert.deepEqual(mock.ctx.storage.get('usage-preferences').accounts, { 'openai-codex': false, anthropic: true });
  assert.deepEqual($$('.su-account').map(node => node.dataset.account), ['acct-claude']);
});

test('the mixed fixture stacks both Codex resets on one line, flags banked credits and lists them under each account', async () => {
  const realNow = Date.now, fixed = Date.parse('2026-10-28T15:00:00+01:00');
  Date.now = () => fixed;
  try {
    plugin.register(mock.ctx); await render(limitsPage());
    const codexSection = $('.su-provider-limits[data-provider="openai-codex"]');
    const stacked = [...codexSection.querySelectorAll('.su-reset[data-kind=projected]')].find(node => node.querySelectorAll('.su-reset-mark').length === 2);
    assert.equal(stacked !== undefined, true, 'both Codex accounts reset at the same time');
    const marks = [...stacked.querySelectorAll('.su-reset-mark')].map(node => ({ id: node.dataset.account, base: Number(node.dataset.base), top: Number(node.dataset.top), weight: Number(node.dataset.weight), gain: Number(node.dataset.gain), label: node.querySelector('.su-reset-text').textContent }));
    assert.deepEqual(marks.map(item => item.id), ['acct-team', 'acct-prolite'], 'stacked in pool priority order');
    assert.deepEqual([Math.abs(marks[1].base - marks[0].top) < 1e-9, Math.abs(marks[1].top - 120) < 1e-9], [true, true], 'the Pro 100 segment starts where the Business one ends and refills the pool');
    assert.deepEqual(marks.map(item => item.label), marks.map(item => `⟳${usage.unitsText(item.weight)} +${usage.unitsText(item.gain)}`), 'each label reads the account\'s full plan units, then what the reset adds');
    assert.equal(codexSection.querySelector('.su-reset-seg') === null, true, 'only the normal curve connects reset discs');
    for (const node of stacked.querySelectorAll('.su-reset-mark')) {
      assert.ok(Math.abs(parseFloat(node.style.bottom) - Number(node.dataset.top) / 120 * 100) < 1e-9, 'each disc is anchored directly at its cumulative level');
      assert.equal(node.style.height, '', 'a reset mark does not span the reset step');
    }
    assert.deepEqual([Number(stacked.dataset.t), codexSection.querySelector('.su-waste').dataset.t], [Math.round(fixed / 1000 + D), stacked.dataset.t], 'the waste arrow sits at the same x');
    // Two credits expiring ten minutes apart, five hours from now, get one flag each; the nine-day ones are beyond the 7-day chart.
    const flags = () => [...codexSection.querySelectorAll('.su-flag')].map(node => [node.dataset.account, node.getAttribute('aria-label').replace(/expires \w{3} \d{1,2}:\d{2} (AM|PM)/g, 'expires <time>')]);
    assert.deepEqual(flags(), [['acct-team', 'codex-team · banked reset expires <time>'], ['acct-prolite', 'codex-pro · banked reset expires <time>']]);
    assert.equal(codexSection.querySelectorAll('.su-flag-count').length, 0, 'different expiries are never counted together');
    assert.equal($$('.su-provider-limits[data-provider="anthropic"] .su-flag').length, 0, 'never-read credits draw no flag');
    const axisStep = (side, direction) => click(codexSection.querySelector(`.su-axis-range[data-side=${side}] [data-direction=${direction}]`));
    await axisStep('future', 'right'); await axisStep('past', 'left');
    assert.deepEqual([flags().length, [...codexSection.querySelectorAll('.su-flag-count')].map(node => node.textContent).join()], [3, '×2'], 'the 30-day projection adds one ×2 flag for the two credits expiring at the same instant');
    // The weekly resets six days ago are within the past shown: a quieter stacked marker without labels.
    const past = [...codexSection.querySelectorAll('.su-reset[data-kind=past]')].find(node => node.querySelectorAll('.su-reset-mark').length === 2);
    assert.deepEqual([past !== undefined, past?.querySelectorAll('.su-reset-text').length], [true, 0]);
    await axisStep('future', 'left'); await axisStep('past', 'right');
    await click(codexSection.querySelector('.su-disclosure'));
    const lines = id => [...$(`.su-account[data-account="${id}"]`).querySelectorAll('.su-banked-credit')].map(node => `${node.dataset.soon}|${node.textContent}`);
    const team = lines('acct-team'), prolite = lines('acct-prolite');
    assert.equal(team.length, 2); assert.equal(prolite.length, 2);
    assert.match(team[0], /^true\|Banked reset · expires [A-Z][a-z]{2} \d{1,2}:\d{2} (AM|PM) in 5h 0m$/, 'within a day: orange');
    assert.match(team[1], /^false\|Banked reset · expires [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM) in 9d 0h$/);
    assert.match(prolite[0], /^true\|Banked reset · expires .* in 5h 10m$/, 'usability is the account button\'s state, not repeated on each credit');
    assert.match(prolite[1], /^false\|Banked reset · expires .* in 9d 0h$/);
    const countdowns = $$('.su-account .su-banked-credit').map(node => node.querySelector('.su-banked-in')?.textContent ?? null);
    assert.equal(countdowns.every(text => /^in \d+[dhm] \d+[hm]$/.test(text ?? '')), true, 'each countdown is its own span, without parentheses');
    const use = id => [...$$(`.su-account[data-account="${id}"] .su-redeem-use`)].map(node => `${node.dataset.state}|${node.getAttribute('aria-disabled') ?? ''}|${node.textContent}`);
    assert.deepEqual([use('acct-team'), use('acct-prolite')], [['usable||Use one'], ['usable||Use one']], 'one button per account; codex-pro is redeemable below 80% left even though Codex\'s applicable count is 0');
  } finally { Date.now = realNow; }
});

test('a logged-out provider is a compact muted row after every chart', async () => {
  mock.control.limitsScenario = 'logged-out';
  plugin.register(mock.ctx); await render(limitsPage());
  assert.deepEqual($$('.su-provider-limits').map(node => [node.dataset.provider, node.dataset.auth ?? 'ok']), [['openai-codex', 'ok'], ['anthropic', 'logged_out']]);
  const row = $('.su-provider-limits[data-auth="logged_out"]');
  assert.equal(row.querySelector('.su-logged-out-row').textContent, 'Anthropic · logged out in Hermes — sign in to track limits' + 'No usable Anthropic credential in the Hermes pool');
  assert.deepEqual([row.querySelectorAll('.su-pooled').length, row.querySelectorAll('.su-disclosure').length, row.querySelector('svg[data-provider-mark]')?.dataset.providerMark], [0, 0, 'anthropic']);
  assert.equal($$('.su-pooled').length, 1);
  // Listed first by the backend, the logged-out provider still comes last.
  const data = mock.syntheticUsageLimits(168, 'logged-out');
  mock.control.usageLimits = { ...data, providers: [...data.providers].reverse() };
  await click(button('Refresh'));
  assert.deepEqual($$('.su-provider-limits').map(node => node.dataset.provider), ['openai-codex', 'anthropic']);
});

test('the Limits page shows the verdict and a waste measurement at each reset that discards quota', async () => {
  const now = Date.now() / 1000;
  mock.control.usageLimits = { generated_at: now, sampler: null, providers: [served(verdictProvider(now))] };
  plugin.register(mock.ctx); await render(limitsPage());
  assert.deepEqual([$('.su-pool').textContent, $('.su-capacity').textContent], ['60', '/ 120 units']);
  assert.equal(tipText($('.su-capacity')), '20 units = one $20 plan\'s allowance (ChatGPT Plus, Claude Pro); units measure capacity, not price.');
  const verdict = $('.su-verdict');
  assert.equal(verdict.dataset.status, 'waste');
  assert.match(verdict.textContent, /^48 units will expire unused by [A-Z][a-z]{2}$/);
  // 48 of 120 units is 40% of the capacity: an orange clock-x, the verdict text itself neutral.
  assert.deepEqual([verdict.dataset.severity, verdict.querySelector('[data-verdict-icon]')?.dataset.verdictIcon, verdict.querySelector('[data-verdict-icon]')?.dataset.severity, verdict.querySelector('svg')?.getAttribute('data-icon')], ['medium', 'waste', 'medium', 'ClockX']);
  const marks = $$('.su-pooled .su-waste');
  assert.equal(marks.length, 1);
  const mark = marks[0], near = (a, b, tolerance = 0.01) => Math.abs(a - b) < tolerance;
  // Default weekly range: seven days either side of Now, so the reset one day ahead sits 192 / 336 of the way along; the pool holds 48 of its 120 units just before the reset, all of which expire.
  assert.ok(near(parseFloat(mark.style.left), 192 / 336 * 100), `x ${mark.style.left}`);
  assert.ok(near(parseFloat(mark.style.top), 60) && near(parseFloat(mark.style.height), 40), `span ${mark.style.top} + ${mark.style.height}`);
  assert.deepEqual([mark.querySelector('.su-waste-text').textContent, mark.querySelectorAll('.su-waste-arrow').length, mark.querySelectorAll('.su-waste-tick').length], ['48 lost', 2, 2]);
  assert.match(tipText(mark), /^codex-pro · Pro 100 · 48 units unused at reset [A-Z][a-z]{2} \d{1,2}:\d{2} (AM|PM)$/);
  // Each reset is a marker on its step: Pro 100 rises from the 48 units left by the 52 it restores; three days of half a unit an hour later the Business seat rises from 64 by its 20.
  const resets = $$('.su-pooled .su-reset[data-kind=projected] .su-reset-mark').map(node => [node.dataset.account, Math.round(Number(node.dataset.base)), Math.round(Number(node.dataset.top)), node.querySelector('.su-reset-text')?.textContent]);
  assert.deepEqual(resets, [['second', 48, 100, '⟳100 +52'], ['first', 64, 84, '⟳20 +20']]);
  const dot = $('.su-reset-mark[data-account=second] .su-reset-dot');
  assert.deepEqual([dot.getAttribute('role'), dot.getAttribute('aria-label').replace(/Resets \w{3} \d{1,2}:\d{2} (AM|PM)/, 'Resets <time>')], ['img', 'codex-pro · Pro 100. Resets <time>. +52 units restored. 48 units lost at this reset']);
  assert.equal($('.su-reset-mark[data-account=first] .su-reset-dot').getAttribute('aria-label').endsWith('+20 units restored'), true, 'an empty account loses nothing at its reset');
  assert.equal($('.su-measure[data-kind="empty"]') === null, true, 'this pool never runs dry');
});

test('a pool that wastes at a reset before running dry gets the waste glyph, both facts and its waste and time-to-empty measurements', async () => {
  const now = Date.now() / 1000;
  mock.control.usageLimits = { generated_at: now, sampler: null, providers: [served(verdictProvider(now, { perHour: 2 }))] };
  plugin.register(mock.ctx); await render(limitsPage());
  assert.equal($('.su-verdict').dataset.status, 'waste');
  assert.match($('.su-verdict').textContent, /^12 units will expire unused by [A-Z][a-z]{2}, then runs out [A-Z][a-z]{2} \d{1,2}:\d{2} (AM|PM), 22h 0m before the next reset · missing ~168 units$/);
  assert.deepEqual([$('.su-verdict [data-verdict-icon]').dataset.verdictIcon, $('.su-verdict [data-verdict-icon]').dataset.severity, $('.su-verdict svg')?.getAttribute('data-icon')], ['waste', 'low', 'ClockX']);
  assert.deepEqual($$('.su-pooled .su-waste .su-waste-text').map(node => node.textContent), ['12 lost']);
  // About 74 hours ahead; the page reads its own clock a moment after the fixture's.
  assert.match($('.su-measure[data-kind="empty"]').textContent, /^Empty in 3d [12]h · /);
});

// Sidebar footer status ------------------------------------------------------------------------------------------------
const footerItems = () => $$('.sf-footer .sf-limits .sf-limit').map(node => ({ provider: node.dataset.provider, status: node.dataset.status, value: node.querySelector('.sf-limit-value').textContent,
  icon: node.querySelector('[data-verdict-icon]')?.dataset.verdictIcon ?? null, mark: node.querySelector('svg[data-provider-mark]')?.dataset.providerMark ?? null }));

test('the single Limits button shows each provider\'s pooled units with a verdict glyph only when the week runs short or wastes quota', async () => {
  const now = Date.now() / 1000;
  mock.control.usageLimits = { generated_at: now, sampler: null, providers: [
    { provider: 'xai', label: 'xAI', auth: 'logged_out', accounts: [], history: [] },
    served(verdictProvider(now, { left: 20, perHour: 2 })),
    served(verdictProvider(now, { provider: 'anthropic', label: 'Anthropic', plans: ['pro', 'max_5x'] })),
    served(verdictProvider(now, { provider: 'nous', label: 'Nous', plans: [null, null], left: 13 }))] };
  plugin.register(mock.ctx); await render(mock.control.contributions[0]);
  assert.equal(restPaths().filter(path => path.startsWith('/usage/limits?')).length, 1, 'one limits request, keyed like the Limits page');
  assert.equal(restPaths().find(path => path.startsWith('/usage/limits?')), '/usage/limits?hours=168');
  assert.deepEqual(footerItems().map(item => [item.provider, item.status, item.value, item.icon, item.mark]), [
    ['openai-codex', 'short', '20', 'short', 'openai-codex'], ['anthropic', 'waste', '60', 'waste', 'anthropic'], ['nous', 'ok', '2.6', null, 'nous']], 'the logged-out provider is left out');
  // Codex is blocked for 98 hours (red), Anthropic loses 48 of 120 units (40%: orange); an ok pool has no glyph and no severity.
  assert.deepEqual($$('.sf-footer .sf-limit').map(node => [node.dataset.severity ?? null, node.querySelector('[data-verdict-icon]')?.dataset.severity ?? null, node.querySelector('[data-verdict-icon] svg')?.getAttribute('data-icon') ?? null]),
    [['high', 'high', 'ArrowBarToDownTouching'], ['medium', 'medium', 'ClockX'], [null, null, null]]);
  const limits = $('.sf-footer .sf-limits');
  assert.deepEqual([$$('.sf-footer button').length, limits.querySelectorAll('button').length, limits.dataset.empty, limits.getAttribute('title')], [2, 0, 'false', null], 'one button holds every item; its tooltip is the SDK Tip, not a title');
  // The accessible name repeats the tooltip: one factual line per provider, no advice.
  const name = limits.getAttribute('aria-label');
  assert.match(name, /^Limits\. OpenAI Codex: 20 \/ 120 units · Runs out [A-Z][a-z]{2} \d{1,2}:\d{2} (AM|PM), (14h 0m|13h 59m) before the next reset · missing ~196 units\. Anthropic: 60 \/ 120 units · 48 units will expire unused by [A-Z][a-z]{2}\. Nous: 2\.6 \/ 40 units · On track for the next 7 days: nothing runs out and little expires unused\.$/);
  assert.equal(ADVICE.test(name), false);
  const codex = usage.validUsageLimits(mock.control.usageLimits).providers[1];
  assert.equal(usage.limitsFooterLine(codex, usage.limitsVerdict(codex, usage.USAGE_DEFAULTS, now), now).startsWith('OpenAI Codex: 20 / 120 units · Runs out '), true);
  await click(limits);
  assert.deepEqual(mock.calls.filter(call => call[0] === 'navigate').map(call => call[1]), ['/t3sidebar-limits']);
  assert.equal(mock.ctx.storage.get('usage-preferences', null), null, 'clicking only opens the page');
});

test('a provider whose verdict cannot be computed shows a muted warning glyph in the footer and on the Limits page', async () => {
  const now = Date.now() / 1000;
  const flat = verdictProvider(now, { provider: 'anthropic', label: 'Anthropic' }); flat.history = [];
  mock.control.usageLimits = { generated_at: now, sampler: null, providers: [served(verdictProvider(now, { stale: true })), served(flat)] };
  plugin.register(mock.ctx); await render(mock.control.contributions[0]);
  // Stale readings and no drain data both leave the verdict unknown: a warning instead of no glyph, so no glyph always means on track.
  assert.deepEqual(footerItems().map(item => [item.provider, item.status, item.icon]), [['openai-codex', 'unknown', 'unknown'], ['anthropic', 'unknown', 'unknown']]);
  assert.deepEqual($$('.sf-footer .sf-limit [data-verdict-icon]').map(node => [node.dataset.severity ?? null, node.querySelector('svg')?.getAttribute('data-icon')]), [[null, 'AlertTriangle'], [null, 'AlertTriangle']]);
  await act(async () => { root.unmount(); }); root = null;
  plugin.register(mock.ctx); await render(limitsPage());
  assert.deepEqual($$('.su-verdict').map(node => [node.dataset.status, node.querySelector('[data-verdict-icon] svg')?.getAttribute('data-icon'), node.querySelector('[data-verdict-icon]')?.dataset.severity ?? null]),
    [['unknown', 'AlertTriangle', null], ['unknown', 'AlertTriangle', null]]);
});

test('the Limits button shares the page cache, follows its preferences and falls back to the gauge without data', async () => {
  plugin.register(mock.ctx);
  mock.control.usageError = 'fixture limits unavailable';
  await render(mock.control.contributions[0]);
  const gauge = () => { const node = $('.sf-footer .sf-limits'); return node && [node.dataset.empty, node.getAttribute('aria-label'), node.getAttribute('title'), node.querySelector('svg')?.getAttribute('data-icon'), node.querySelectorAll('.sf-limit').length, node.textContent]; };
  assert.deepEqual(gauge(), ['true', 'Limits', 'Subscription limits', 'Gauge', 0, ''], 'a failed read leaves the gauge, never an error');
  assert.equal($$('.sf-footer button').length, 2);
  await click($('.sf-footer .sf-limits'));
  assert.deepEqual(mock.calls.filter(call => call[0] === 'navigate').map(call => call[1]), ['/t3sidebar-limits'], 'the page stays reachable');
  await act(async () => root.unmount()); root = null; mock.queryClient.clear(); mock.calls.length = 0;
  mock.control.usageError = null; mock.control.backendMissing = true;
  await render(mock.control.contributions[0]);
  assert.equal(restPaths().some(path => path.startsWith('/usage/')), false, 'without the companion the footer does not ask for limits');
  assert.deepEqual(gauge(), ['true', 'Limits', 'Subscription limits', 'Gauge', 0, '']);
  await act(async () => root.unmount()); root = null; mock.queryClient.clear(); mock.calls.length = 0;
  mock.control.backendMissing = false;
  mock.ctx.storage.set('usage-preferences', { lookback: 360 });
  await render(mock.control.contributions[0]);
  assert.deepEqual(restPaths().filter(path => path.startsWith('/usage/')), ['/usage/limits?hours=360'], 'the saved lookback sizes the request like the Limits page');
  assert.deepEqual(footerItems().map(item => item.provider), ['openai-codex', 'anthropic'], 'both synthetic pools show');
  await act(async () => root.unmount()); root = null; mock.queryClient.clear();
  mock.control.limitsScenario = 'logged-out';
  await render(mock.control.contributions[0]);
  assert.deepEqual(footerItems().map(item => item.provider), ['openai-codex'], 'logged-out Anthropic is left out');
});

test('the lookback slider moves between stops, changes the drain rate and widens the history request', async () => {
  const now = Date.now() / 1000;
  // Four points per hour for the last two hours, one per hour for the eight hours before.
  const history = [[-10 * H + 30, 90], [-2 * H + 30, 82], [-H + 30, 78], [-30, 74]].map(([offset, value]) => ({ t: now + offset, account: 'a', window: 'weekly', remaining_percent: value, resets_at: now + 5 * D }));
  mock.control.usageLimits = { generated_at: now, sampler: null, providers: [{ provider: 'openai-codex', label: 'OpenAI Codex', history: mock.limitSeries(history),
    accounts: [{ id: 'a', label: 'a', priority: 0, plan: 'prolite', fetched_at: now - 60, windows: [{ key: 'weekly', label: 'Weekly', window_seconds: 604800, remaining_percent: 74, resets_at: now + 5 * D }] }] }] };
  mock.ctx.storage.set('usage-preferences', { lookback: 2 });
  plugin.register(mock.ctx); await render(limitsPage());
  const slider = await lookbackSlider();
  // Reversed: position 0 is 30d on the left, 9 is 1h on the right, so 2h sits at position 8.
  assert.deepEqual([slider.min, slider.max, slider.step, slider.value, slider.getAttribute('aria-valuetext'), slider.style.getPropertyValue('--su-share')], ['0', '9', '1', '8', '2h', String(8 / 9)]);
  assert.equal($('.su-measure[data-kind="average"]').textContent.split(' · ')[1], '~4.0 units / h', 'a Pro 100 account: one percent is one plan unit');
  assert.equal(document.querySelectorAll('.su-coverage').length, 0, 'the headline never carries a coverage note');
  assert.match($('.su-measure[data-kind="empty"]').textContent, /^Empty in 18h \d+m · /, '74 points at about 4 per hour');
  assert.equal($('.su-measure[data-kind="average"]').textContent, 'Average over 2h · ~4.0 units / h');
  // The trendline, read back in chart time and units: it ends on the units left at Now and rises backwards at the averaged rate over the averaged span.
  const trend = () => {
    const plot = $('.su-pooled .su-plot'), path = $('.su-pooled .su-trend').getAttribute('d'), [x0, y0, x1, y1] = path.match(/-?\d+(\.\d+)?/g).map(Number);
    const start = Number(plot.dataset.start), end = Number(plot.dataset.end), cap = Number(plot.dataset.cap), at = xv => start + xv / 1000 * (end - start), value = yv => (100 - yv) / 100 * cap;
    return { hours: (at(x1) - at(x0)) / H, toNow: Math.abs(at(x1) - now), left: value(y1), rate: (value(y0) - value(y1)) / ((at(x1) - at(x0)) / H) };
  };
  let line = trend();
  assert.ok(Math.abs(line.hours - 2) < 0.02 && line.toNow < 60 && Math.abs(line.left - 74) < 0.2 && Math.abs(line.rate - 4.03) < 0.05, `the 2h trendline rises ~4 units/h back from 74 units at Now (${JSON.stringify(line)})`);
  await slide(slider, 6);
  assert.equal($('.su-lookback input[type=range]').getAttribute('aria-valuetext'), '12h');
  assert.deepEqual([$('.su-lookback input[type=range]').getAttribute('aria-valuetext'), $('.su-lookback-value').textContent, document.querySelectorAll('.su-coverage').length], ['12h', '12h', 0], 'the slider shows the chosen 12h while the label names the 10h it covers');
  // Only ten of the requested twelve hours are covered: the arrow and its label span those ten hours, and the title names the requested lookback.
  const averaged = $('.su-measure[data-kind="average"]');
  assert.deepEqual([averaged.textContent, averaged.getAttribute('aria-label'), averaged.dataset.seconds], ['Average over 10h · ~1.6 units / h', 'Average over 10h · ~1.6 units / h (all the data in the last 12h)', String(10 * H - 60)]);
  assert.equal(mock.ctx.storage.get('usage-preferences').lookback, 12);
  line = trend();
  assert.ok(Math.abs(line.hours - (10 - 1 / 60)) < 0.02 && line.toNow < 60 && Math.abs(line.left - 74) < 0.2 && Math.abs(line.rate - 16 / (10 - 1 / 60)) < 0.05, `the trendline follows the lookback over the ten covered hours (${JSON.stringify(line)})`);
  assert.equal(restPaths().at(-1), '/usage/limits?hours=168');
  await slide(await lookbackSlider(), 1);
  assert.equal($('.su-lookback input[type=range]').getAttribute('aria-valuetext'), '15d');
  assert.equal(restPaths().at(-1), '/usage/limits?hours=360', 'a lookback beyond a week asks for that much history');
  await slide(await lookbackSlider(), 9);
  assert.equal(mock.ctx.storage.get('usage-preferences').lookback, 1, 'the rightmost stop is the shortest lookback');
  await slide(await lookbackSlider(), 0);
  assert.equal(mock.ctx.storage.get('usage-preferences').lookback, 720, 'the leftmost stop is the longest lookback');
});

test('unfold arrows beside each end of the x axis set four page-wide ranges that survive a remount', async () => {
  // A horizon saved by the retired 7d | 30d control is dropped: the chart opens at the weekly defaults.
  mock.ctx.storage.set('usage-preferences', { horizon: 30 });
  plugin.register(mock.ctx); await render(limitsPage());
  const chart = () => $('.su-pooled'), group = side => chart().querySelector(`.su-axis-range[data-side=${side}]`);
  const arrows = side => [...group(side).querySelectorAll('button')].map(node => `${node.dataset.direction}:${node.getAttribute('aria-label')}:${node.disabled}`);
  const days = () => { const node = chart().querySelector('.su-plot'); return Math.round((Number(node.dataset.end) - Number(node.dataset.start)) / D * 1000) / 1000; };
  const stored = () => mock.ctx.storage.get('usage-preferences').range;
  // Each control is a left arrow, a decorative dashed crease and a right arrow: on the past side ← reaches further back, on the future side → projects further ahead.
  assert.deepEqual([group('past').getAttribute('role'), group('past').getAttribute('aria-label'), group('future').getAttribute('aria-label')], ['group', 'Past shown: 7d', 'Projection: 7d']);
  assert.deepEqual([...group('past').children].map(node => `${node.tagName}:${node.getAttribute('aria-hidden') ?? ''}:${node.querySelector('svg')?.dataset.icon}`), ['BUTTON::UnfoldLeft', 'SPAN:true:UnfoldCrease', 'BUTTON::UnfoldRight']);
  assert.deepEqual([arrows('past'), arrows('future')], [['left:Show 30d before Now:false', 'right:Show 1d before Now:false'], ['left:Project 1d ahead:false', 'right:Project 30d ahead:false']]);
  assert.deepEqual([chart().dataset.past, chart().dataset.future, days()], ['168', '168', 14]);
  assert.equal(restPaths().at(-1), '/usage/limits?hours=168');
  await click(group('past').querySelector('[data-direction=right]'));
  assert.deepEqual([arrows('past'), days()], [['left:Show 7d before Now:false', 'right:Shortest past shown:true'], 8], 'one day back, the first weekly stop');
  await click(group('past').querySelector('[data-direction=left]'));
  await click(group('past').querySelector('[data-direction=left]'));
  assert.deepEqual([arrows('past'), days()], [['left:Longest past shown:true', 'right:Show 7d before Now:false'], 37], 'thirty days back, the last weekly stop');
  assert.equal(restPaths().at(-1), '/usage/limits?hours=720', 'thirty days of past need 720 hours of history');
  await click(group('future').querySelector('[data-direction=left]'));
  assert.deepEqual([arrows('future'), days()], [['left:Shortest projection shown:true', 'right:Project 7d ahead:false'], 31]);
  assert.deepEqual(stored(), { weekly: { past: 720, future: 24 }, session: { past: 5, future: 24 } });
  // The five-hour window has its own past and future stops (5h, 1d, 7d); setting them leaves the weekly ones alone.
  await click(button('5-hour'));
  assert.deepEqual([chart().dataset.past, chart().dataset.future, group('past').getAttribute('aria-label'), group('future').getAttribute('aria-label'), days()], ['5', '24', 'Past shown: 5h', 'Projection: 1d', 1.208]);
  assert.deepEqual([arrows('past'), arrows('future')], [['left:Show 1d before Now:false', 'right:Shortest past shown:true'], ['left:Project 5h ahead:false', 'right:Project 7d ahead:false']]);
  await click(group('future').querySelector('[data-direction=right]'));
  await click(group('past').querySelector('[data-direction=left]'));
  assert.deepEqual([chart().dataset.past, chart().dataset.future, days()], ['24', '168', 8]);
  assert.deepEqual(stored(), { weekly: { past: 720, future: 24 }, session: { past: 24, future: 168 } });
  // Saved in client storage: a remount restores all four.
  await act(async () => root.unmount()); root = null; mock.queryClient.clear();
  await render(limitsPage());
  assert.deepEqual([chart().dataset.window, chart().dataset.past, chart().dataset.future], ['five_hour', '24', '168']);
  await click(button('Weekly'));
  assert.deepEqual([chart().dataset.past, chart().dataset.future], ['720', '24']);
});

test('a range change glides through the viewBox and translates, then settles; polls, window switches and reduced motion do not glide', async t => {
  let reduce = false;
  const { frames, run } = fakeFrames(t, () => reduce);
  plugin.register(mock.ctx); await render(limitsPage());
  const grid = () => $('.su-limits-grid'), viewBox = () => grid().querySelector('.su-plot > svg').getAttribute('viewBox');
  const translated = () => $$('.su-limits-grid .su-xaxis > span, .su-limits-grid .su-marks > *, .su-limits-grid .su-now').filter(node => node.style.translate !== '').length;
  assert.deepEqual([grid().dataset.gliding, viewBox()], [undefined, '0 0 1000 100'], 'nothing glides on the first render');
  const spans = () => $$('.su-limits-grid .su-measure-span').map(node => `${node.style.left}|${node.style.width}`).join(), sevenDays = spans();
  // Glide frames compute positions through the time mapping, so an identity frame can differ from React's percentages in the last float digits.
  const near = (a, b) => { const x = a.split(/[|,]/).map(parseFloat), y = b.split(/[|,]/).map(parseFloat); return x.length === y.length && x.every((value, index) => Math.abs(value - y[index]) < 1e-9); };
  // 7d → 30d ahead with 7d of past is drawn on the click: the old 14 days are 14/37 of the new span, so the glide opens on that slice of the viewBox.
  await click($('.su-axis-range[data-side=future] [data-direction=right]'));
  assert.deepEqual($$('.su-limits-grid').map(node => node.dataset.gliding), ['true', 'true'], 'both charts glide, since the range is page-wide');
  assert.equal(viewBox(), `0.000 0 ${(14 / 37 * 1000).toFixed(3)} 100`);
  assert.ok(translated() > 0, 'marks, the Now line and axis labels carry a translate');
  // The measurement arrows glide too: their spans start at the old mapping and end exactly where React placed them.
  const gliding = spans();
  await run(1000); await run(1110);
  const middle = Number(viewBox().split(' ')[2]);
  assert.ok(middle > 14 / 37 * 1000 && middle < 1000, `half way the window is between the ranges (${viewBox()})`);
  await run(1300);
  assert.deepEqual([grid().dataset.gliding, viewBox(), translated(), frames.size], [undefined, '0 0 1000 100', 0, 0], 'settled: the React viewBox is back and every translate is cleared');
  const settled = spans();
  assert.ok(settled !== gliding && settled.split(',').every(item => /^[\d.]+%\|[\d.]+%$/.test(item)), `measurement spans moved (${gliding}) and settled on React's percentages (${settled})`);
  // Shrinking 30d → 7d keeps the 37-day drawing on the click and opens on all of it, zooms in on its first 14 days, then draws the 7-day range once, at the end. The drawn range shows in the plot's data-end.
  const plotEnd = () => $('.su-pooled .su-plot').dataset.end, ends = [];
  const observer = new window.MutationObserver(records => records.forEach(() => ends.push(plotEnd())));
  observer.observe($('.su-pooled .su-plot'), { attributes: true, attributeFilter: ['data-end'] });
  await click($('.su-axis-range[data-side=future] [data-direction=left]'));
  const gridline = () => grid().querySelector('.su-plot > svg > line.su-grid');
  assert.deepEqual([grid().dataset.gliding, viewBox(), gridline().getAttribute('x2'), near(spans(), settled), ends.length], ['true', '0.000 0 1000.000 100', '1000.000', true, 0], 'the click keeps the wide drawing');
  await run(1500); await run(1610);
  const zoom = Number(viewBox().split(' ')[2]);
  assert.ok(zoom < 1000 && zoom > 14 / 37 * 1000 && ends.length === 0, `half way it zooms inside the same drawing (${viewBox()})`);
  await run(1800);
  assert.deepEqual([grid().dataset.gliding, viewBox(), translated(), gridline().getAttribute('x2'), spans(), ends.length], [undefined, '0 0 1000 100', 0, '1000', sevenDays, 1], 'the 7-day range is drawn once, at the end, with React\'s spans');
  // Growing again draws once, on the click.
  ends.length = 0;
  await click($('.su-axis-range[data-side=future] [data-direction=right]'));
  assert.equal(ends.length, 1);
  await run(1900); await run(2200);
  assert.deepEqual([ends.length, spans(), grid().dataset.gliding], [1, settled, undefined]);
  observer.disconnect();
  // A change while gliding restarts from the window being shown: shrink the future, then the past half way through.
  await click($('.su-axis-range[data-side=future] [data-direction=left]'));
  await run(3000); await run(3050);
  const shown = viewBox();
  await click($('.su-axis-range[data-side=past] [data-direction=right]'));
  assert.equal(grid().dataset.gliding, 'true');
  assert.equal(frames.size, $$('.su-limits-grid[data-gliding]').length, 'the interrupted glides cancelled the frames they had requested after their last step; only the new ones are pending');
  await run(4000); await run(4300);
  const plot = $('.su-pooled .su-plot');
  assert.deepEqual([grid().dataset.gliding, viewBox(), translated(), gridline().getAttribute('x1'), gridline().getAttribute('x2'), (Number(plot.dataset.end) - Number(plot.dataset.start)) / D],
    [undefined, '0 0 1000 100', 0, '0', '1000', 8], `the interrupted glide (at ${shown}) settles on one day back and seven ahead`);
  // A poll moves Now and both ends of the axis but keeps the range: no glide. The clock jumps an hour before it, so the move cannot be missed.
  const before = Number($('.su-pooled .su-plot').dataset.start), realNow = Date.now;
  Date.now = () => realNow() + 3600_000;
  try { await act(async () => { await mock.queryClient.refetchQueries(); }); await tick(); } finally { Date.now = realNow; }
  const moved = Number($('.su-pooled .su-plot').dataset.start) - before;
  assert.deepEqual([moved >= 3600 && moved <= 3602, grid().dataset.gliding, viewBox()], [true, undefined, '0 0 1000 100'], `the axis start moved by ${moved}s`);
  // Switching the window redraws at once: a different series, not the same one at another range.
  await click(button('5-hour'));
  assert.deepEqual([grid().dataset.gliding, viewBox()], [undefined, '0 0 1000 100']);
  // Reduced motion: the range changes instantly.
  reduce = true;
  await click($('.su-axis-range[data-side=future] [data-direction=right]'));
  assert.deepEqual([grid().dataset.gliding, viewBox(), grid().closest('.su-pooled').dataset.future], [undefined, '0 0 1000 100', '168']);
});

test('the averaging period is measured left of Now and cut at the plot edge without a left arrowhead', async () => {
  plugin.register(mock.ctx); await render(limitsPage());
  const shape = () => {
    const span = $('.su-measure[data-kind="average"] .su-measure-span');
    return { cap: span.dataset.startCap, startArrows: span.querySelectorAll('[data-end="start"]').length, endArrows: span.querySelectorAll('.su-arrow[data-end="end"]').length,
      endTicks: span.querySelectorAll('.su-measure-tick[data-end="end"]').length, left: parseFloat(span.style.left), right: parseFloat(span.style.left) + parseFloat(span.style.width) };
  };
  const nowPct = () => parseFloat($('.su-now').style.left);
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  // Default weekly range: seven days of past, so 12 hours start 156 hours into it.
  let geometry = shape();
  assert.deepEqual([geometry.cap, geometry.startArrows, geometry.endArrows, geometry.endTicks], ['true', 2, 1, 1], 'inside the plot both ends get an arrowhead and a tick');
  assert.ok(near(geometry.left, 156 / 336 * 100) && near(geometry.right, nowPct()), `12h spans its lookback up to Now (${JSON.stringify(geometry)})`);
  const label = $('.su-measure[data-kind="average"] .su-measure-label');
  assert.deepEqual([label.dataset.side, Number(label.dataset.low), near(Number(label.dataset.high), nowPct())], ['left', 0, true], 'the averaging label stays left of Now');
  await slide(await lookbackSlider(), 1);
  geometry = shape();
  assert.deepEqual([geometry.cap, geometry.startArrows, geometry.endArrows, geometry.left, near(geometry.right, nowPct())], ['false', 0, 1, 0, true], '15d reaches past the plot: cut at the edge, no left arrowhead or tick');
  assert.match($('.su-measure[data-kind="average"]').textContent, /^Average over 10d · (~\d+(\.\d)? units \/ h|no drain data)$/, 'ten days of history: the span and label cover those, still past the plot edge');
  await click($('.su-axis-range[data-side=past] [data-direction=right]'));
  assert.equal(shape().cap, 'false', 'one day of past still starts after 15 days back');
  await slide(await lookbackSlider(), 6);
  geometry = shape();
  assert.ok(geometry.cap === 'true' && near(geometry.left, (24 - 12) / 192 * 100), '12h sits inside one day of past too');
});

test('stale, failing and unread accounts keep the normal view', async () => {
  const now = Date.now() / 1000;
  mock.control.usageLimits = { generated_at: now, sampler: null, providers: [{ provider: 'anthropic', label: 'Anthropic', auth: 'ok', history: [], accounts: [
    { id: 'acct-b1', label: 'claude-max', priority: 1, plan: 'max', fetched_at: now - 3 * H, stale: true, error: null, windows: [{ key: 'weekly', label: 'Weekly', window_seconds: 604800, remaining_percent: 39, resets_at: now + D }] },
    { id: 'acct-b2', label: 'claude-team', priority: 2, fetched_at: null, stale: false, error: 'HTTP 401 from usage endpoint', windows: [{ key: 'weekly', label: 'Weekly', window_seconds: 604800, remaining_percent: null, resets_at: null }] }] }] };
  plugin.register(mock.ctx); await render(limitsPage());
  assert.equal($('.su-disclosure').getAttribute('aria-label'), 'Accounts (2)');
  await click($('.su-disclosure'));
  assert.equal($('.su-capacity').textContent, '/ 20 units', 'the account without a reading is left out of the pool');
  // "max" alone does not say 5x or 20x: counted as one base plan, flagged on the row and in a footnote.
  assert.deepEqual([$('.su-account[data-account="acct-b1"] .su-badge[data-badge=plan]').textContent, $('.su-account[data-account="acct-b1"] .su-assumed').textContent], ['max20 units', 'capacity unknown, counted as 20*']);
  assert.match($('.su-assumption').textContent, /^\* Capacity unknown for claude-max \(max\), claude-team \(no plan reported\): counted as 20 units, one \$20 plan\.$/);
  assert.equal($('.su-verdict').dataset.status, 'unknown', 'a stale pool without drain data gets no verdict');
  assert.match($('.su-chart-notes').textContent, /1 account without a reading left out of the pool/);
  // Compare text, never a DOM node: a failing assertion on a jsdom element tries to diff the whole DOM.
  assert.match($('.su-measure[data-kind="average"]')?.textContent ?? '', /· no drain data$/, 'the averaging label says there is no drain data');
  assert.equal($('.su-measure[data-kind="empty"]') === null, true, 'a flat projection never empties');
  const unknown = $('.su-account[data-account="acct-b2"]');
  assert.equal(unknown.querySelector('.su-window-value').textContent, '—', 'unknown stays a dash, never 0%');
  assert.equal(unknown.querySelector('.su-bar-fill') === null, true);
  assert.equal(unknown.querySelector('[role=alert]').textContent, 'HTTP 401 from usage endpoint');
  assert.equal($('.su-account[data-account="acct-b1"] .su-badge[data-tone=warn]').textContent, 'Stale');
});

test('a pool with no account readings shows a dash instead of 0%', async () => {
  mock.control.usageLimits = { generated_at: 1, sampler: null, providers: [{ provider: 'anthropic', label: 'Anthropic', history: [], accounts: [
    { id: 'x', label: 'x', priority: 1, fetched_at: null, stale: false, error: 'timeout', windows: [{ key: 'weekly', label: 'Weekly', window_seconds: 604800, remaining_percent: null, resets_at: null }] }] }] };
  plugin.register(mock.ctx); await render(limitsPage());
  assert.deepEqual([$('.su-pool').textContent, $('.su-capacity').textContent], ['—', 'no account readings yet']);
  await click($('.su-disclosure'));
  assert.equal($('.su-window-value').textContent, '—');
});

test('the Limits page reports a missing backend and an empty sampler', async () => {
  mock.control.usageError = 'fixture limits unavailable';
  plugin.register(mock.ctx); await render(limitsPage());
  assert.equal($('.su-state[role=alert]').textContent, 'Limits unavailable: fixture limits unavailable Retry');
  mock.control.usageError = null; mock.control.usageLimits = { generated_at: 1, sampler: null, providers: [] };
  await click(button('Retry'));
  assert.equal($('.su-state').textContent, 'No subscription limits recorded yet.');
  assert.equal($('.su-footnote').textContent, 'The limits sampler has not reported yet.');
});

// A Codex pool built by hand: one account whose weekly allowance is at `left` percent, holding `credits` banked resets.
const redeemPool = (now, accounts) => ({ generated_at: now, sampler: null, providers: [{ provider: 'openai-codex', label: 'OpenAI Codex', auth: 'ok', history: [], accounts: accounts.map(({ id, plan = 'prolite', left, five = null, credits = 2 }) => ({
  id, label: id, priority: 0, plan, fetched_at: now - 60, stale: false, error: null, banked_resets: credits,
  banked_credits: { fetched_at: now - 60, applicable_count: 0, credits: Array.from({ length: credits }, (_, index) => ({ status: 'available', granted_at: now - 7 * D, expires_at: now + (index + 1) * D })) },
  windows: [...(five === null ? [] : [{ key: 'five_hour', label: '5-hour', window_seconds: 18000, remaining_percent: five, resets_at: now + H }]), { key: 'weekly', label: 'Weekly', window_seconds: 604800, remaining_percent: left, resets_at: now + 3 * D }] })) }] });
const openCodexAccounts = async () => { plugin.register(mock.ctx); await render(limitsPage()); await click($('.su-disclosure')); };
const dialog = () => $('[role=dialog]');

test('a refused reset keeps its button but locks it, naming that every bar is at 80% or more', async () => {
  const now = Date.now() / 1000;
  mock.control.usageLimits = redeemPool(now, [{ id: 'spare', plan: 'plus', left: 85, five: 92 }, { id: 'edge', left: 79.9 }]);
  await openCodexAccounts();
  const locked = $('.su-account[data-account="spare"] .su-redeem-use');
  assert.deepEqual([locked.dataset.state, locked.getAttribute('aria-disabled'), locked.querySelector('small').textContent, locked.querySelector('svg')?.dataset.icon], ['locked', 'true', 'all ≥80% left', 'TicketLocked']);
  assert.match(tipText(locked), /less than 80% left; every one here has 80% or more/);
  await click(locked);
  assert.equal(dialog() === null, true, 'a locked reset opens no confirmation');
  const usable = $('.su-account[data-account="edge"] .su-redeem-use');
  assert.deepEqual([usable.dataset.state, usable.getAttribute('aria-disabled'), usable.querySelector('small') === null, usable.querySelector('svg')?.dataset.icon], ['usable', null, true, 'Ticket']);
  assert.equal(restPaths().includes('/usage/limits/redeem'), false);
});

test('hovering or focusing a usable reset shows in green what it would give back on each account-wide bar', async () => {
  const now = Date.now() / 1000;
  const pool = redeemPool(now, [{ id: 'spare', plan: 'plus', left: 85, five: 92 }, { id: 'edge', plan: 'plus', left: 40, five: 70 }]);
  // A model-scoped window is not refilled by a Codex reset.
  pool.providers[0].accounts[1].windows.push({ key: 'weekly:gpt', label: 'Weekly gpt', scope: 'model', window_seconds: 604800, remaining_percent: 10, resets_at: now + D });
  mock.control.usageLimits = pool;
  await openCodexAccounts();
  const gains = id => [...$$(`.su-account[data-account="${id}"] .su-window`)].map(row => `${row.dataset.window}=${row.querySelector('.su-bar-gain')?.dataset.gain ?? '-'}`).join();
  const pointer = async (node, type) => { await act(async () => node.dispatchEvent(new window.MouseEvent(type, { bubbles: true, relatedTarget: document.body }))); await tick(); };
  const usable = $('.su-account[data-account="edge"] .su-redeem-use');
  assert.equal(gains('edge'), 'five_hour=-,weekly=-,weekly:gpt=-', 'nothing is shown before the button is pointed at');
  await pointer(usable, 'pointerover');
  assert.equal(gains('edge'), 'five_hour=30,weekly=60,weekly:gpt=-');
  assert.equal(gains('spare'), 'five_hour=-,weekly=-', 'only the hovered account previews');
  await pointer(usable, 'pointerout');
  assert.equal(gains('edge'), 'five_hour=-,weekly=-,weekly:gpt=-');
  await act(async () => usable.focus()); await tick();
  assert.equal(gains('edge'), 'five_hour=30,weekly=60,weekly:gpt=-', 'keyboard focus previews too');
  await act(async () => usable.blur()); await tick();
  await pointer($('.su-account[data-account="spare"] .su-redeem-use'), 'pointerover');
  assert.equal(gains('spare'), 'five_hour=-,weekly=-', 'a locked reset gives nothing back, so it previews nothing');
});

// An Anthropic account built by hand: Claude Code's login at `week` percent weekly left, Fable's own window at `fable`, holding the given limit resets.
const resetsPool = (now, { week = 40, five = 70, fable = 30, share = 12, grants }) => ({ generated_at: now, sampler: null, providers: [{ provider: 'anthropic', label: 'Anthropic', auth: 'ok', history: [], accounts: [{
  id: 'claude-code', label: 'Claude Code', priority: 0, plan: 'default_claude_max_5x', fetched_at: now - 60, stale: false, error: null,
  reset_grants: { fetched_at: now - 60, weekly_share_used: share, grants },
  windows: [{ key: 'five_hour', label: 'Current session', window_seconds: 18000, remaining_percent: five, resets_at: now + H }, { key: 'weekly', label: 'Current week', window_seconds: 604800, remaining_percent: week, resets_at: now + 3 * D },
    { key: 'weekly:fable', label: 'Fable week', scope: 'model', model: 'fable', window_seconds: 604800, remaining_percent: fable, resets_at: now + 3 * D }] }] }] });
const resetGrant = (now, fields) => ({ id: 'grant_fable_1', kind: 'fable', resets_left: 1, ends_at: now + 6 * D, usable: true, reason: null, clears: [], ...fields });

test('each Anthropic limit reset gets a line and its own button, previewing on hover what it gives back', async () => {
  const now = Date.now() / 1000;
  mock.control.usageLimits = resetsPool(now, { grants: [resetGrant(now), resetGrant(now, { id: 'grant_session', kind: 'session', ends_at: now + 2 * H, usable: false, reason: 'needs_limit' }), resetGrant(now, { id: 'grant_gone', kind: 'weekly', ends_at: now - 60 })] });
  plugin.register(mock.ctx); await render(limitsPage()); await click($('.su-disclosure'));
  const lines = $$('.su-reset-line');
  assert.deepEqual(lines.map(line => `${line.dataset.reset}|${line.dataset.soon}`), ['session|true', 'fable|false'], 'soonest expiry first; an expired reset is not offered');
  assert.match(lines[1].querySelector('.su-reset-label').textContent, /^Fable reset · expires .+ in 5d 23h$/);
  const [locked, usable] = lines.map(line => line.querySelector('.su-redeem-use'));
  assert.deepEqual([locked.dataset.state, locked.getAttribute('aria-disabled'), usable.dataset.state, usable.querySelector('svg')?.dataset.icon], ['locked', 'true', 'usable', 'Ticket']);
  // Padlocked like Codex's refused button, with the reason on its second line.
  assert.deepEqual([locked.querySelector('svg')?.dataset.icon, locked.querySelector('small')?.textContent, locked.dataset.size], ['TicketLocked', 'at a limit only', undefined]);
  assert.match(locked.title || locked.dataset.sfTip, /only once you reach a limit it refills/);
  const gains = () => $$('.su-account .su-window').map(row => `${row.dataset.window}=${row.querySelector('.su-bar-gain')?.dataset.gain ?? '-'}`).join();
  const pointer = async (node, type) => { await act(async () => node.dispatchEvent(new window.MouseEvent(type, { bubbles: true, relatedTarget: document.body }))); await tick(); };
  await pointer(usable, 'pointerover');
  // Fable's own window refills; the weekly one gets back only the 12% Fable took of it.
  assert.equal(gains(), 'five_hour=-,weekly=12,weekly:fable=70');
  await pointer(usable, 'pointerout');
  await pointer(locked, 'pointerover');
  assert.equal(gains(), 'five_hour=-,weekly=-,weekly:fable=-', 'a reset Anthropic would refuse previews nothing');
  await click(locked);
  assert.equal(dialog() === null, true);
});

test('using an Anthropic reset confirms the loss on the window it refills and posts that reset', async () => {
  const now = Date.now() / 1000;
  mock.control.usageLimits = resetsPool(now, { fable: 30, grants: [resetGrant(now)] });
  mock.control.redeemResult = { status: 'reset', resets_left: 0 };
  plugin.register(mock.ctx); await render(limitsPage()); await click($('.su-disclosure'));
  await click($('.su-reset-line .su-redeem-use'));
  assert.equal(dialog().getAttribute('aria-label'), 'Use one fable reset on Claude Code?');
  assert.deepEqual([dialog().querySelector('.su-redeem-lost').textContent, dialog().querySelector('.su-redeem-gain').textContent], ['30%of the fable week allowance lost · 30 units', '+70%']);
  await click([...dialog().querySelectorAll('button')].find(node => node.textContent === 'Use reset')); await tick();
  assert.deepEqual(mock.calls.filter(call => call[0] === 'rest' && call[1] === '/usage/limits/redeem').map(call => call[2].body), [{ provider: 'anthropic', account: 'claude-code', grant: 'grant_fable_1' }]);
  assert.equal(dialog() === null, true);
  // A refusal keeps the dialog open with Anthropic's reason; an unconfirmed claim locks the account's resets until a newer reading.
  mock.control.redeemResult = { status: 'not_limited', resets_left: 1 };
  await click($('.su-reset-line .su-redeem-use'));
  await click([...dialog().querySelectorAll('button')].find(node => node.textContent === 'Use reset')); await tick();
  assert.match(dialog().textContent, /only works once you reach a limit it refills\. It was not used\./);
  assert.deepEqual([usage.redeemFailure({ status: 'already_used' }, 'anthropic'), usage.redeemFailure({ status: 'signed_out' }, 'anthropic') !== null, usage.redeemFailure({ status: 'unknown' }, 'anthropic')],
    [null, true, 'Anthropic could not confirm the reset. Refresh to check whether it was used.']);
});

test('reset previews follow what each Anthropic reset kind clears', () => {
  const win = (key, remaining, extra = {}) => ({ key, remaining_percent: remaining, ...extra });
  const five = win('five_hour', 70), week = win('weekly', 40), fable = win('weekly:fable', 30, { scope: 'model', model: 'fable' }), opus = win('weekly:opus', 10, { scope: 'model', model: 'opus' });
  const gains = (grant, share = 12) => [five, week, fable, opus].map(item => usage.anthropicResetGain({ clears: [], ...grant }, item, share));
  assert.deepEqual(gains({ kind: 'session' }), [30, 0, 0, 0]);
  assert.deepEqual(gains({ kind: 'weekly' }), [0, 60, 0, 0]);
  assert.deepEqual(gains({ kind: 'full' }), [30, 60, 0, 0]);
  assert.deepEqual(gains({ kind: 'fable' }), [0, 12, 70, 0]);
  assert.deepEqual(gains({ kind: 'fable' }, null), [0, 0, 70, 0], 'without Fable\'s weekly share the weekly gain is not guessed');
  assert.deepEqual(gains({ kind: 'weekly', clears: ['seven_day_opus'] }), [0, 0, 0, 90], 'a reset naming what it clears refills exactly that');
  assert.deepEqual(usage.validResetGrants({ fetched_at: 1, weekly_share_used: 140, grants: [{ id: 'g1', kind: 'fable', resets_left: 1, ends_at: null }, { id: 'g2', kind: 'monthly', resets_left: 1 }, { id: 'Bad!', kind: 'fable', resets_left: 1 }, { id: 'g3', kind: 'session', resets_left: 0 }] }),
    { fetched_at: 1, weekly_share_used: 100, grants: [{ id: 'g1', kind: 'fable', resets_left: 1, ends_at: null, usable: false, reason: null, clears: [] }] });
  assert.equal(usage.validResetGrants(undefined), null);
});

test('using a reset confirms the weekly loss, posts the account and reloads the limits', async () => {
  const now = Date.now() / 1000;
  mock.control.usageLimits = redeemPool(now, [{ id: 'codex-pro', left: 59 }, { id: 'codex-team', plan: 'team', left: 0, five: 100, credits: 1 }]);
  await openCodexAccounts();
  await click($('.su-account[data-account="codex-pro"] .su-redeem-use'));
  assert.equal(dialog().getAttribute('aria-label'), 'Use one banked reset on codex-pro?');
  assert.deepEqual([dialog().querySelector('.su-redeem-lost').textContent, dialog().querySelector('.su-redeem-bar').getAttribute('aria-label'), dialog().querySelector('.su-redeem-lose').style.width, dialog().querySelector('.su-redeem-gain').textContent],
    ['59%of the weekly allowance lost · 59 units', '59% lost, 41% restored', '59%', '+41%']);
  assert.equal(dialog().querySelector('p:not(.su-redeem-lost)') === null, true, 'no description or explanation besides the loss');
  const confirm = [...dialog().querySelectorAll('button')].find(node => node.textContent === 'Use reset');
  assert.equal(confirm.dataset.destructive, 'true', 'a reset that loses weekly allowance confirms in the destructive style');
  const reads = () => restPaths().filter(path => path.startsWith('/usage/limits?')).length, before = reads();
  await click(confirm); await tick();
  assert.deepEqual(mock.calls.filter(call => call[0] === 'rest' && call[1] === '/usage/limits/redeem').map(call => call[2]), [{ method: 'POST', body: { provider: 'openai-codex', account: 'codex-pro' } }]);
  assert.equal(dialog() === null, true, 'the confirmation closes once the reset is used');
  assert.ok(reads() > before, 'the limits are read again to show the restored allowance');
  // Weekly already empty: nothing is lost, whatever the full 5-hour window holds.
  await click($('.su-account[data-account="codex-team"] .su-redeem-use'));
  assert.deepEqual([dialog().querySelector('.su-redeem-lost').textContent, dialog().querySelector('.su-redeem-lost b').dataset.zero, dialog().querySelector('.su-redeem-gain').textContent], ['0%of the weekly allowance lost', 'true', '+100%']);
  assert.equal([...dialog().querySelectorAll('button')].find(node => node.textContent === 'Use reset').dataset.destructive, 'false');
});

test('a reset Codex refuses or that cannot be confirmed keeps the confirmation open with the reason', async () => {
  const now = Date.now() / 1000;
  mock.control.usageLimits = redeemPool(now, [{ id: 'codex-pro', left: 59 }]);
  await openCodexAccounts();
  const attempt = async () => { await click([...dialog().querySelectorAll('button')].find(node => node.textContent === 'Use reset')); await tick(); return dialog()?.querySelector('[role=alert]')?.textContent ?? null; };
  await click($('.su-redeem-use'));
  mock.control.redeemResult = { status: 'nothing_to_reset', available_count: 2, windows_reset: 0 };
  assert.equal(await attempt(), 'Codex refused: no allowance is below 80% left yet. The banked reset was not spent.');
  mock.control.redeemResult = () => { throw new Error('409 redeem_in_progress'); };
  assert.equal(await attempt(), 'The reset could not be used: 409 redeem_in_progress. Refresh to check whether it was spent.');
  mock.control.redeemResult = { status: 'unavailable' };
  assert.match(await attempt(), /^Codex could not confirm the reset\./);
});
