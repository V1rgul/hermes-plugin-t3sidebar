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
  // a: 80→70 (10) and 100→90 (10); the rise is a reset. b: 50→49 straddles a new reset time, so it counts as none.
  assert.equal(Math.round(usage.drainRate(samples, now, 6 * H) * 1000) / 1000, Math.round(20 / 3 * 1000) / 1000);
  // Twelve hours reach back to the 99% reading: 99→80 adds 19 points over the 8 hours the readings cover.
  const wide = usage.drainStats(samples, now, 12 * H);
  assert.deepEqual([wide.rate, wide.coveredS, wide.consumed, wide.partial], [39 / 8, 8 * H, 39, true], 'less history than the lookback uses what exists and says so');
  assert.equal(usage.drainStats(samples, now, 8 * H).partial, false);
  assert.equal(usage.drainStats(samples, now, H).rate, 10, 'one hour sees only the 100→90 drop after the reset');
  assert.equal(usage.drainRate(samples.slice(-1), now), null, 'a single reading has no rate');
  assert.equal(usage.drainRate([{ t: now - 300, account: 'a', value: 50, resets_at: null }, { t: now, account: 'a', value: 49, resets_at: null }], now), 12, 'two readings five minutes apart are enough: the rate uses whatever history exists');
  assert.equal(usage.drainRate([{ t: now, account: 'a', value: 50, resets_at: null }], now), null, 'a single reading has no rate');
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
  // The 30-day horizon shows nine days of past, which needs more than the default week of history.
  assert.deepEqual([usage.limitsHistoryHours(12, 7), usage.limitsHistoryHours(12, 30), usage.limitsHistoryHours(360, 30)], [168, 216, 360]);
  assert.deepEqual([usage.limitsPastSeconds(7 * D) / H, usage.limitsPastSeconds(30 * D) / D, usage.limitsPastSeconds(H) / H], [50.4, 9, 6]);
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
test('plan units follow Virgile\'s table: Codex is linear in price in every window, Anthropic differs per window', () => {
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
function verdictProvider(now, { provider = 'openai-codex', label = 'OpenAI Codex', plans = ['team', 'prolite'], left = 60, perHour = 0.5, stale = false, auth = 'ok' } = {}) {
  const history = [];
  for (let hour = 12; hour >= 0; hour--) history.push(
    { t: now - hour * H, account: 'second', window: 'weekly', remaining_percent: left + hour * perHour, resets_at: now + D },
    { t: now - hour * H, account: 'first', window: 'weekly', remaining_percent: 0, resets_at: now + 4 * D });
  const win = (remaining, resets) => [{ key: 'weekly', label: 'Weekly', window_seconds: 7 * D, remaining_percent: remaining, resets_at: resets }];
  return { provider, label, auth, history, accounts: [
    { id: 'first', label: 'chatgptvitibot', priority: 0, plan: plans[0], fetched_at: now, stale, windows: win(0, now + 4 * D) },
    { id: 'second', label: 'chatgpt1', priority: 1, plan: plans[1], fetched_at: now, stale, windows: win(left, now + D) }] };
}

test('the verdict says waste when resets discard at least 5% of capacity and the pool never runs dry', () => {
  const now = 1_000_000, prefs = usage.USAGE_DEFAULTS;
  const verdict = usage.limitsVerdict(verdictProvider(now), prefs, now);
  // 0.5 units an hour for a day leaves 48 of Pro 100's 60 units to expire at its reset; afterwards 120 units outlast the week.
  assert.deepEqual([verdict.status, verdict.window, verdict.remaining, verdict.capacity, verdict.remaining_pct, verdict.empty_at, verdict.last_loss_at - now], ['waste', 'weekly', 60, 120, 50, null, D]);
  assert.equal(Math.round(verdict.lost * 1000) / 1000, 48); assert.equal(Math.round(verdict.lost_pct * 10) / 10, 40);
  assert.match(usage.verdictText(verdict, now), /^48 units will expire unused by [A-Z][a-z]{2}$/, 'the fact only, no advice');
  assert.deepEqual([verdict.severity, verdict.missing], ['medium', 0], '48 of 120 units lost is over a third of the capacity');
  const marks = usage.wasteMarks(usage.projectPool(verdictProvider(now).accounts, verdictProvider(now).history, 'weekly', now, 7 * D, { lookbackS: 12 * H, provider: 'openai-codex' }));
  assert.deepEqual(marks.map(mark => [mark.t - now, Math.round(mark.before), Math.round(mark.lost), mark.accounts.map(item => `${item.label} ${item.plan_label}`).join()]), [[D, 48, 48, 'chatgpt1 Pro 100']]);
  // A loss under 5% of capacity is noise: 13% of Pro 100 at 0.5 units an hour leaves 1 unit at the reset.
  const ok = usage.limitsVerdict(verdictProvider(now, { left: 13 }), prefs, now);
  assert.deepEqual([ok.status, Math.round(ok.lost), ok.severity], ['ok', 1, null]);
  assert.match(usage.verdictText(ok, now), /^On track for the next 7 days/);
});

test('the verdict says short when the projection hits zero before a reset, using the saved lookback', () => {
  const now = 1_000_000;
  // Two units an hour: 12 units still expire at Pro 100's reset after a day, then its fresh 100 run out 50 hours later, 22 hours before the Business seat resets.
  const verdict = usage.limitsVerdict(verdictProvider(now, { perHour: 2 }), usage.USAGE_DEFAULTS, now);
  assert.deepEqual([verdict.status, Math.round(verdict.empty_at - now), verdict.next_reset_at - now], ['short', 74 * H, 4 * D]);
  assert.match(usage.verdictText(verdict, now), /^Runs out [A-Z][a-z]{2} \d{1,2}:\d{2} (AM|PM), 22h 0m before the next reset · missing ~168 units$/, 'the facts only, no advice');
  // Missing units are the drain over every empty stretch in the week: 22 hours until the Business seat refills, then 62 hours from when its 20 units run out to the end of the week, at 2 units an hour.
  assert.deepEqual([Math.round(verdict.missing * 1000) / 1000, verdict.severity, Math.round(verdict.lost)], [168, 'high', 12]);
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

test('verdict severity compares missing or lost units with the pool capacity at exactly one and two thirds', () => {
  assert.deepEqual([[39.99, 120], [40, 120], [79.99, 120], [80, 120], [120, 120], [0, 120]].map(([amount, capacity]) => usage.verdictSeverity(amount, capacity)), ['low', 'medium', 'medium', 'high', 'high', 'low']);
  assert.deepEqual([usage.verdictSeverity(10, 0), usage.verdictSeverity(NaN, 120)], [null, null]);
  // Pro 100 holding 52 units at half a unit an hour has exactly 40 of the pool's 120 left at its reset: one third. 92 units leave exactly 80: two thirds.
  const now = 1_000_000;
  const third = usage.limitsVerdict(verdictProvider(now, { left: 52 }), usage.USAGE_DEFAULTS, now), twoThirds = usage.limitsVerdict(verdictProvider(now, { left: 92 }), usage.USAGE_DEFAULTS, now), below = usage.limitsVerdict(verdictProvider(now, { left: 51 }), usage.USAGE_DEFAULTS, now);
  assert.deepEqual([third.status, third.lost, third.severity], ['waste', 40, 'medium']);
  assert.deepEqual([twoThirds.status, twoThirds.lost, twoThirds.severity], ['waste', 80, 'high']);
  assert.deepEqual([below.status, below.lost, below.severity], ['waste', 39, 'low']);
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
  const parsed = usage.validUsageLimits({ providers: [{ provider: 'openai-codex', accounts: [{ id: 'a', banked_credits: { credits: [{ status: 'available', expires_at: 10 }] } }, { id: 'b', banked_credits: 'broken' }] }] });
  assert.deepEqual(parsed.providers[0].accounts.map(account => account.banked_credits?.credits.length ?? null), [1, null]);
  const now = 1000, accounts = [{ id: 'a', label: 'chatgpt1', banked_credits: { credits: [{ expires_at: now + 5 * H }, { expires_at: now + 9 * D }] } }, { id: 'b', label: 'chatgptvitibot', banked_credits: { credits: [{ expires_at: now + 5 * H + 600 }, { expires_at: null }] } }];
  const flags = usage.bankedFlags(accounts, now, now + 7 * D);
  assert.deepEqual(flags.map(flag => [flag.t - now, flag.credits.map(item => item.label).join()]), [[5 * H, 'chatgpt1'], [5 * H + 600, 'chatgptvitibot']], 'one flag per expiry, even ten minutes apart; ones outside the range or without a time get none');
  const minute = 60 * 1000;
  const same = usage.bankedFlags([{ id: 'a', label: 'a', banked_credits: { credits: [{ expires_at: minute + 10 }] } }, { id: 'b', label: 'b', banked_credits: { credits: [{ expires_at: minute + 40 }, { expires_at: minute + 70 }] } }], 0, minute + D);
  assert.deepEqual(same.map(flag => flag.credits.length), [2, 1], 'credits expiring in the same minute share one flag; the next minute gets its own');
  const lines = usage.bankedFlagLines(flags[0], now);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^chatgpt1 · banked reset expires [A-Z][a-z]{2} \d{1,2}:\d{2} (AM|PM)$/);
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
  assert.deepEqual(usage.validUsagePreferences({ days: 30, split: 'model', mode: 'independent', horizon: 30, lookback: 72, window: 'five_hour', accounts: { 'openai-codex': true, anthropic: false } }),
    { days: 30, split: 'model', mode: 'independent', horizon: 30, lookback: 72, window: 'five_hour', accounts: { 'openai-codex': true, anthropic: false } });
  assert.deepEqual(usage.validUsagePreferences({ days: '7', split: 1, mode: 'stack', horizon: 14, lookback: 6, window: '', accounts: 'open' }), usage.USAGE_DEFAULTS);
  // Saved before the overview: the Usage|Limits tab and the provider picked by the retired Limits tabs are dropped.
  const legacy = usage.validUsagePreferences({ tab: 'limits', provider: 'anthropic' });
  assert.deepEqual([Object.hasOwn(legacy, 'tab'), Object.hasOwn(legacy, 'provider')], [false, false]);
  assert.deepEqual([1, 3, 7, 30].map(horizon => usage.validUsagePreferences({ horizon }).horizon), [7, 7, 7, 30]);
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
});

// Sidebar footer and registration -----------------------------------------------------------------------------------
const ADVICE = /cut optional|background work|room for|optional work/i;
const adviceFree = () => !ADVICE.test(document.body.textContent) && $$('[aria-label]').every(node => !ADVICE.test(node.getAttribute('aria-label'))) && $$('[title]').every(node => !ADVICE.test(node.getAttribute('title')));
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
  assert.deepEqual([buttons[1].getAttribute('aria-label'), buttons[1].textContent, buttons[1].getAttribute('title'), buttons[1].querySelector('svg')?.getAttribute('data-icon')], ['Usage', '', 'Token usage', 'BarChart3']);
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
  // Saved before the pages were split: the old tab key must not matter.
  mock.ctx.storage.set('usage-preferences', { tab: 'limits', days: 30, split: 'model', mode: 'independent', horizon: 7 });
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
  assert.deepEqual($$('.su-composition').map(node => node.textContent), ['(Business: 20, Pro 100: 100)', '(Max 20x: 200)']);
  assert.equal($$('.su-pool').every(node => /^\d+(\.\d)?$/.test(node.textContent)), true);
  assert.equal($$('.su-rate').every(node => /^~\d+(\.\d)? units per hour$/.test(node.textContent)), true);
  assert.deepEqual($$('.su-pooled').map(chart => [...chart.querySelectorAll('.su-yaxis span')].map(node => node.textContent).join()), ['units,0,25,50,75,100,120', 'units,0,50,100,150,200']);
  assert.deepEqual($$('.su-verdict').map(node => node.closest('.su-provider-limits').dataset.provider), ['openai-codex', 'anthropic']);
  assert.equal($$('.su-pooled .su-line.su-past').length + $$('.su-pooled .su-line.su-projected').length + $$('.su-now').length, 6);
  assert.ok($$('.su-pooled')[1].querySelectorAll('.su-day-grid').length >= 9, 'a week of history plus a week ahead crosses at least nine midnights');
  assert.equal($('.su-legend'), null, 'the Remaining/Projected legend is gone');
  // Reset times are markers in the charts now, never a Next reset line; no wording anywhere still says plan units.
  assert.deepEqual([/Next reset/.test(document.body.textContent), /plan units/i.test(document.body.textContent), $$('[title]').some(node => /plan units/i.test(node.title))], [false, false, false]);
  // One controls bar at the top: lookback, window, horizon and refresh, none of them repeated per chart.
  const bar = $('.su-limits-controls');
  assert.equal(bar.parentElement.className, 'su', 'the controls head the page');
  assert.equal(bar.compareDocumentPosition($('.su-provider-limits')) & 4, 4, 'the controls come before the first section');
  assert.deepEqual([$$('.su-lookback').length, $$('.su-horizon').length, $$('.su [role=group][aria-label=Window]').length, $$('.su [role=group][aria-label=Horizon]').length], [1, 1, 1, 1]);
  assert.deepEqual([bar.querySelector('.su-lookback') !== null, bar.querySelector('.su-horizon') !== null, bar.querySelector('[aria-label=Window]') !== null, bar.querySelector('[aria-label=Refresh]') !== null], [true, true, true, true]);
  assert.deepEqual([$('.su-lookback-label').textContent, $('.su-lookback-value').textContent], ['Projections based on', '12h']);
  assert.deepEqual([...bar.querySelectorAll('[aria-label=Window] button')].map(node => node.textContent), ['5-hour', 'Weekly']);
  // Account details are folded under each chart; the shared footnote appears once at the bottom.
  assert.equal($$('.su-account').length, 0, 'accounts are folded by default');
  assert.deepEqual($$('.su-disclosure').map(node => [node.textContent, node.getAttribute('aria-expanded')]), [['Accounts (2)', 'false'], ['Accounts (1)', 'false']]);
  assert.equal($$('.su-footnote').length, 1);
  assert.match($('.su-footnote').textContent, /^Sampled every 5m · last sample .*averaged over the selected period.*20 units = one \$20 plan's allowance/);
  assert.equal($('.su-overview').lastElementChild.className, 'su-footnotes', 'the footnotes close the page');
  assert.equal(button('3d'), undefined, 'the 1d/3d/7d horizon control is gone');
  await click(button('5-hour'));
  assert.deepEqual($$('.su-pooled').map(node => node.dataset.window), ['five_hour', 'five_hour'], 'the window choice applies to every chart');
  // Codex plans weigh the same in every window; Max 20x is 400 units in five hours. The verdicts keep judging the weekly pools.
  assert.deepEqual($$('.su-capacity').map(node => node.textContent), ['/ 120 units', '/ 400 units']);
  assert.deepEqual($$('.su-verdict').map(node => [node.dataset.window, node.textContent.startsWith('Weekly: ')]), [['weekly', true], ['weekly', true]]);
  assert.equal(mock.ctx.storage.get('usage-preferences').window, 'five_hour');
  assert.equal(adviceFree(), true, 'no verdict, label or title gives advice');
});

test('the shared lookback and horizon controls change every chart at once', async () => {
  // The synthetic drain follows office hours, so at some times of day the 12h and 15d averages coincide; pin the same weekday afternoon as the browser smoke.
  const realNow = Date.now, fixed = Date.parse('2026-10-28T15:00:00+01:00');
  Date.now = () => fixed;
  try {
    plugin.register(mock.ctx); await render(limitsPage());
    const rates = () => $$('.su-rate').map(node => node.textContent);
    const before = rates();
    await slide($('.su-lookback input[type=range]'), 1);
    assert.equal($('.su-lookback-value').textContent, '15d');
    const after = rates();
    assert.deepEqual(after.map((text, index) => text !== before[index] && /^(~\d+(\.\d)? units per hour|no drain data)$/.test(text)), [true, true], `every provider's rate follows the slider (${before} → ${after})`);
    // The fixtures hold ten days of history, so a 15d lookback averages over those ten days.
    assert.deepEqual($$('.su-measure[data-kind="average"]').map(node => node.textContent.split(' · ')[0]), ['Average over 10d', 'Average over 10d']);
    const spans = () => $$('.su-pooled .su-plot').map(node => Math.round((Number(node.dataset.end) - Number(node.dataset.start)) / D * 100) / 100);
    assert.deepEqual(spans(), [9.1, 9.1]);
    await click(button('30d'));
    assert.deepEqual([spans(), $$('.su-pooled').map(node => node.dataset.horizon)], [[39, 39], ['30', '30']], 'one horizon choice extends every chart');
    await click(button('7d'));
    assert.deepEqual(spans(), [9.1, 9.1]);
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
  const first = $('.su-account[data-account="acct-team"]');
  assert.match(first.querySelector('.su-account-head').textContent, /^chatgptvitibotBusiness · 20 unitspriority 0.*2 banked resets/);
  assert.equal($('.su-account[data-account="acct-prolite"] .su-badge').textContent, 'Pro 100 · 100 units');
  assert.equal($('.su-assumed'), null, 'every plan is in the capacity table');
  assert.equal(first.querySelectorAll('.su-window').length, 2);
  assert.equal(first.querySelectorAll('.su-pace').length, 2, 'every window with a length and reset time has a pace tick');
  // In the mixed fixture both Codex accounts reset together tomorrow.
  assert.match(first.querySelector('.su-window[data-window="weekly"] .su-window-reset').textContent, /^resets in (23h \d+m|1d 0h)$/);
  await act(async () => root.unmount()); root = null; mock.queryClient.clear();
  await render(limitsPage());
  assert.deepEqual([toggle('openai-codex').getAttribute('aria-expanded'), toggle('anthropic').getAttribute('aria-expanded'), $$('.su-account').length], ['true', 'false', 2], 'the fold survives a remount');
  await click(toggle('anthropic'));
  assert.equal($('.su-account[data-account="acct-claude"] .su-badge').textContent, 'Max 20x · 200 units');
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
    const marks = [...stacked.querySelectorAll('.su-reset-mark')].map(node => ({ id: node.dataset.account, base: Number(node.dataset.base), top: Number(node.dataset.top), gain: Number(node.dataset.gain), label: node.querySelector('.su-reset-text').textContent }));
    assert.deepEqual(marks.map(item => item.id), ['acct-team', 'acct-prolite'], 'stacked in pool priority order');
    assert.deepEqual([Math.abs(marks[1].base - marks[0].top) < 1e-9, Math.abs(marks[1].top - 120) < 1e-9], [true, true], 'the Pro 100 segment starts where the Business one ends and refills the pool');
    assert.deepEqual(marks.map(item => item.label), marks.map(item => `+${usage.unitsText(item.gain)}`));
    assert.deepEqual([Number(stacked.dataset.t), codexSection.querySelector('.su-waste').dataset.t], [Math.round(fixed / 1000 + D), stacked.dataset.t], 'the waste arrow sits at the same x');
    // Two credits expiring ten minutes apart, five hours from now, get one flag each; the nine-day ones are beyond the 7-day chart.
    const flags = () => [...codexSection.querySelectorAll('.su-flag')].map(node => [node.dataset.account, node.getAttribute('aria-label').replace(/expires \w{3} \d{1,2}:\d{2} (AM|PM)/g, 'expires <time>')]);
    assert.deepEqual(flags(), [['acct-team', 'chatgptvitibot · banked reset expires <time>'], ['acct-prolite', 'chatgpt1 · banked reset expires <time>']]);
    assert.equal(codexSection.querySelectorAll('.su-flag-count').length, 0, 'different expiries are never counted together');
    assert.equal($$('.su-provider-limits[data-provider="anthropic"] .su-flag').length, 0, 'never-read credits draw no flag');
    await click(button('30d'));
    assert.deepEqual([flags().length, [...codexSection.querySelectorAll('.su-flag-count')].map(node => node.textContent).join()], [3, '×2'], 'the 30-day chart adds one ×2 flag for the two credits expiring at the same instant');
    // The weekly resets six days ago are within the 30-day chart's nine days of past: a quieter stacked marker without labels.
    const past = [...codexSection.querySelectorAll('.su-reset[data-kind=past]')].find(node => node.querySelectorAll('.su-reset-mark').length === 2);
    assert.deepEqual([past !== undefined, past?.querySelectorAll('.su-reset-text').length], [true, 0]);
    await click(button('7d'));
    await click(codexSection.querySelector('.su-disclosure'));
    const lines = id => [...$(`.su-account[data-account="${id}"]`).querySelectorAll('.su-banked-credit')].map(node => `${node.dataset.soon}|${node.textContent}`);
    const team = lines('acct-team'), prolite = lines('acct-prolite');
    assert.equal(team.length, 2); assert.equal(prolite.length, 2);
    assert.match(team[0], /^true\|Banked reset · expires [A-Z][a-z]{2} \d{1,2}:\d{2} (AM|PM) \(in 5h 0m\)$/, 'within a day: orange');
    assert.match(team[1], /^false\|Banked reset · expires [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM) \(in 9d 0h\)$/);
    assert.match(prolite[0], /^true\|Banked reset · expires .* \(in 5h 10m\) · not usable now$/, 'applicable 0: the credits exist but cannot be used now');
    assert.match(prolite[1], /^false\|Banked reset · expires .* \(in 9d 0h\) · not usable now$/);
    assert.equal($$('.su-account[data-account="acct-team"] .su-banked-unusable').length, 0);
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
  mock.control.usageLimits = { generated_at: now, sampler: null, providers: [verdictProvider(now)] };
  plugin.register(mock.ctx); await render(limitsPage());
  assert.deepEqual([$('.su-pool').textContent, $('.su-capacity').textContent], ['60', '/ 120 units']);
  assert.equal($('.su-capacity').getAttribute('title'), '20 units = one $20 plan\'s allowance (ChatGPT Plus, Claude Pro); units measure capacity, not price.');
  const verdict = $('.su-verdict');
  assert.equal(verdict.dataset.status, 'waste');
  assert.match(verdict.textContent, /^48 units will expire unused by [A-Z][a-z]{2}$/);
  // 48 of 120 units is over a third of the capacity: an orange clock-x, the verdict text itself neutral.
  assert.deepEqual([verdict.dataset.severity, verdict.querySelector('[data-verdict-icon]')?.dataset.verdictIcon, verdict.querySelector('[data-verdict-icon]')?.dataset.severity, verdict.querySelector('svg')?.getAttribute('data-icon')], ['medium', 'waste', 'medium', 'ClockX']);
  const marks = $$('.su-pooled .su-waste');
  assert.equal(marks.length, 1);
  const mark = marks[0], near = (a, b, tolerance = 0.01) => Math.abs(a - b) < tolerance;
  // 7-day chart: 50.4 hours of past, so the reset one day ahead sits (50.4 + 24) / 218.4 of the way along; the pool holds 48 of its 120 units just before the reset, all of which expire.
  assert.ok(near(parseFloat(mark.style.left), 74.4 / 218.4 * 100), `x ${mark.style.left}`);
  assert.ok(near(parseFloat(mark.style.top), 60) && near(parseFloat(mark.style.height), 40), `span ${mark.style.top} + ${mark.style.height}`);
  assert.deepEqual([mark.querySelector('.su-waste-text').textContent, mark.querySelectorAll('.su-waste-arrow').length, mark.querySelectorAll('.su-waste-tick').length], ['48 lost', 2, 2]);
  assert.match(mark.getAttribute('title'), /^chatgpt1 · Pro 100 · 48 units unused at reset [A-Z][a-z]{2} \d{1,2}:\d{2} (AM|PM)$/);
  // Each reset is a marker on its step: Pro 100 rises from the 48 units left by the 52 it restores; three days of half a unit an hour later the Business seat rises from 64 by its 20.
  const resets = $$('.su-pooled .su-reset[data-kind=projected] .su-reset-mark').map(node => [node.dataset.account, Math.round(Number(node.dataset.base)), Math.round(Number(node.dataset.top)), node.querySelector('.su-reset-text')?.textContent]);
  assert.deepEqual(resets, [['second', 48, 100, '+52'], ['first', 64, 84, '+20']]);
  const dot = $('.su-reset-mark[data-account=second] .su-reset-dot');
  assert.deepEqual([dot.getAttribute('role'), dot.getAttribute('aria-label').replace(/Resets \w{3} \d{1,2}:\d{2} (AM|PM)/, 'Resets <time>')], ['img', 'chatgpt1 · Pro 100. Resets <time>. +52 units restored. 48 units lost at this reset']);
  assert.equal($('.su-reset-mark[data-account=first] .su-reset-dot').getAttribute('aria-label').endsWith('+20 units restored'), true, 'an empty account loses nothing at its reset');
  assert.equal($('.su-measure[data-kind="empty"]'), null, 'this pool never runs dry');
});

test('a pool that runs dry before its next reset gets the short verdict alongside its waste and time-to-empty measurements', async () => {
  const now = Date.now() / 1000;
  mock.control.usageLimits = { generated_at: now, sampler: null, providers: [verdictProvider(now, { perHour: 2 })] };
  plugin.register(mock.ctx); await render(limitsPage());
  assert.equal($('.su-verdict').dataset.status, 'short');
  assert.match($('.su-verdict').textContent, /^Runs out [A-Z][a-z]{2} \d{1,2}:\d{2} (AM|PM), 22h 0m before the next reset · missing ~168 units$/);
  assert.deepEqual([$('.su-verdict [data-verdict-icon]').dataset.verdictIcon, $('.su-verdict [data-verdict-icon]').dataset.severity, $('.su-verdict svg')?.getAttribute('data-icon')], ['short', 'high', 'ArrowBarToDownTouching']);
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
    verdictProvider(now, { perHour: 2 }),
    verdictProvider(now, { provider: 'anthropic', label: 'Anthropic', plans: ['pro', 'max_5x'] }),
    verdictProvider(now, { provider: 'nous', label: 'Nous', plans: [null, null], left: 13 })] };
  plugin.register(mock.ctx); await render(mock.control.contributions[0]);
  assert.equal(restPaths().filter(path => path.startsWith('/usage/limits?')).length, 1, 'one limits request, keyed like the Limits page');
  assert.equal(restPaths().find(path => path.startsWith('/usage/limits?')), '/usage/limits?hours=168');
  assert.deepEqual(footerItems().map(item => [item.provider, item.status, item.value, item.icon, item.mark]), [
    ['openai-codex', 'short', '60', 'short', 'openai-codex'], ['anthropic', 'waste', '60', 'waste', 'anthropic'], ['nous', 'ok', '2.6', null, 'nous']], 'the logged-out provider is left out');
  // Codex misses 168 of 120 units (red), Anthropic loses 48 of 120 (orange); an ok pool has no glyph and no severity.
  assert.deepEqual($$('.sf-footer .sf-limit').map(node => [node.dataset.severity ?? null, node.querySelector('[data-verdict-icon]')?.dataset.severity ?? null, node.querySelector('[data-verdict-icon] svg')?.getAttribute('data-icon') ?? null]),
    [['high', 'high', 'ArrowBarToDownTouching'], ['medium', 'medium', 'ClockX'], [null, null, null]]);
  const limits = $('.sf-footer .sf-limits');
  assert.deepEqual([$$('.sf-footer button').length, limits.querySelectorAll('button').length, limits.dataset.empty, limits.getAttribute('title')], [2, 0, 'false', null], 'one button holds every item; its tooltip is the SDK Tip, not a title');
  // The accessible name repeats the tooltip: one factual line per provider, no advice.
  const name = limits.getAttribute('aria-label');
  assert.match(name, /^Limits\. OpenAI Codex: 60 \/ 120 units · Runs out [A-Z][a-z]{2} \d{1,2}:\d{2} (AM|PM), 22h 0m before the next reset · missing ~168 units\. Anthropic: 60 \/ 120 units · 48 units will expire unused by [A-Z][a-z]{2}\. Nous: 2\.6 \/ 40 units · On track for the next 7 days: nothing runs out and little expires unused\.$/);
  assert.equal(ADVICE.test(name), false);
  const codex = mock.control.usageLimits.providers[1];
  assert.equal(usage.limitsFooterLine(codex, usage.limitsVerdict(codex, usage.USAGE_DEFAULTS, now), now).startsWith('OpenAI Codex: 60 / 120 units · Runs out '), true);
  await click(limits);
  assert.deepEqual(mock.calls.filter(call => call[0] === 'navigate').map(call => call[1]), ['/t3sidebar-limits']);
  assert.equal(mock.ctx.storage.get('usage-preferences', null), null, 'clicking only opens the page');
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
  mock.control.usageLimits = { generated_at: now, sampler: null, providers: [{ provider: 'openai-codex', label: 'OpenAI Codex', history,
    accounts: [{ id: 'a', label: 'a', priority: 0, plan: 'prolite', fetched_at: now - 60, windows: [{ key: 'weekly', label: 'Weekly', window_seconds: 604800, remaining_percent: 74, resets_at: now + 5 * D }] }] }] };
  mock.ctx.storage.set('usage-preferences', { lookback: 2 });
  plugin.register(mock.ctx); await render(limitsPage());
  const slider = $('.su-lookback input[type=range]');
  // Reversed: position 0 is 30d on the left, 9 is 1h on the right, so 2h sits at position 8.
  assert.deepEqual([slider.min, slider.max, slider.step, slider.value, slider.getAttribute('aria-valuetext'), slider.style.getPropertyValue('--su-share')], ['0', '9', '1', '8', '2h', String(8 / 9)]);
  assert.equal($('.su-rate').textContent, '~4.0 units per hour', 'a Pro 100 account: one percent is one plan unit');
  assert.equal(document.querySelectorAll('.su-coverage').length, 0, 'the headline never carries a coverage note');
  assert.match($('.su-measure[data-kind="empty"]').textContent, /^Empty in 18h \d+m · /, '74 points at about 4 per hour');
  assert.equal($('.su-measure[data-kind="average"]').textContent, 'Average over 2h · ~4.0 units/h');
  await slide(slider, 6);
  assert.equal($('.su-lookback input[type=range]').getAttribute('aria-valuetext'), '12h');
  assert.deepEqual([$('.su-lookback-value').textContent, $('.su-rate').textContent, document.querySelectorAll('.su-coverage').length], ['12h', '~1.6 units per hour', 0]);
  // Only ten of the requested twelve hours are covered: the arrow and its label span those ten hours, and the title names the requested lookback.
  const averaged = $('.su-measure[data-kind="average"]');
  assert.deepEqual([averaged.textContent, averaged.getAttribute('aria-label'), averaged.dataset.seconds], ['Average over 10h · ~1.6 units/h', 'Average over 10h · ~1.6 units/h (all the data in the last 12h)', String(10 * H - 60)]);
  assert.equal(mock.ctx.storage.get('usage-preferences').lookback, 12);
  assert.equal(restPaths().at(-1), '/usage/limits?hours=168');
  await slide($('.su-lookback input[type=range]'), 1);
  assert.equal($('.su-lookback-value').textContent, '15d');
  assert.equal(restPaths().at(-1), '/usage/limits?hours=360', 'a lookback beyond a week asks for that much history');
  await slide($('.su-lookback input[type=range]'), 9);
  assert.equal(mock.ctx.storage.get('usage-preferences').lookback, 1, 'the rightmost stop is the shortest lookback');
  await slide($('.su-lookback input[type=range]'), 0);
  assert.equal(mock.ctx.storage.get('usage-preferences').lookback, 720, 'the leftmost stop is the longest lookback');
});

test('a 7d | 30d segmented control in the controls bar switches the projection horizon', async () => {
  // A horizon saved by the retired 1d/3d/7d control opens at the 7-day default.
  mock.ctx.storage.set('usage-preferences', { horizon: 3 });
  plugin.register(mock.ctx); await render(limitsPage());
  const group = () => $('.su-horizon');
  const state = () => [...group().querySelectorAll('button')].map(node => `${node.textContent}:${node.getAttribute('aria-pressed')}`).join() + `|${$('.su-pooled').dataset.horizon}`;
  const days = () => { const node = $('.su-pooled .su-plot'); return Math.round((Number(node.dataset.end) - Number(node.dataset.start)) / D * 100) / 100; };
  assert.deepEqual([group().getAttribute('role'), group().getAttribute('aria-label'), group().closest('.su-limits-controls') !== null, group().querySelector('.su-control-label')?.textContent], ['group', 'Horizon', true, 'Horizon'], 'a labelled group in the shared controls bar');
  assert.equal(state(), '7d:true,30d:false|7');
  assert.equal(group().querySelectorAll('svg').length, 0, 'text choices, no arrow icon');
  assert.equal(days(), 9.1, 'seven days ahead plus 30% of that before Now');
  await click(button('30d'));
  assert.equal(state(), '7d:false,30d:true|30');
  assert.equal(days(), 39);
  assert.equal(mock.ctx.storage.get('usage-preferences').horizon, 30);
  assert.equal(restPaths().at(-1), '/usage/limits?hours=216', 'nine days of past need more than a week of history');
  await click(button('7d'));
  assert.deepEqual([state(), mock.ctx.storage.get('usage-preferences').horizon], ['7d:true,30d:false|7', 7]);
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
  // 7-day horizon: 50.4 hours of past, so 12 hours start 38.4 hours into it.
  let geometry = shape();
  assert.deepEqual([geometry.cap, geometry.startArrows, geometry.endArrows, geometry.endTicks], ['true', 2, 1, 1], 'inside the plot both ends get an arrowhead and a tick');
  assert.ok(near(geometry.left, 38.4 / 218.4 * 100) && near(geometry.right, nowPct()), `12h spans its lookback up to Now (${JSON.stringify(geometry)})`);
  const label = $('.su-measure[data-kind="average"] .su-measure-text');
  assert.deepEqual([label.dataset.side, Number(label.dataset.low), near(Number(label.dataset.high), nowPct())], ['left', 0, true], 'the averaging label stays left of Now');
  await slide($('.su-lookback input[type=range]'), 1);
  geometry = shape();
  assert.deepEqual([geometry.cap, geometry.startArrows, geometry.endArrows, geometry.left, near(geometry.right, nowPct())], ['false', 0, 1, 0, true], '15d reaches past the plot: cut at the edge, no left arrowhead or tick');
  assert.match($('.su-measure[data-kind="average"]').textContent, /^Average over 10d · (~\d+(\.\d)? units\/h|no drain data)$/, 'ten days of history: the span and label cover those, still past the plot edge');
  await click(button('30d'));
  assert.equal(shape().cap, 'false', 'nine days of past still start after 15 days back');
  await slide($('.su-lookback input[type=range]'), 6);
  geometry = shape();
  assert.ok(geometry.cap === 'true' && near(geometry.left, (216 - 12) / 936 * 100), '12h sits inside the 30-day chart too');
});

test('stale, failing and unread accounts keep the normal view', async () => {
  const now = Date.now() / 1000;
  mock.control.usageLimits = { generated_at: now, sampler: null, providers: [{ provider: 'anthropic', label: 'Anthropic', auth: 'ok', history: [], accounts: [
    { id: 'acct-b1', label: 'claude-max', priority: 1, plan: 'max', fetched_at: now - 3 * H, stale: true, error: null, windows: [{ key: 'weekly', label: 'Weekly', window_seconds: 604800, remaining_percent: 39, resets_at: now + D }] },
    { id: 'acct-b2', label: 'claude-team', priority: 2, fetched_at: null, stale: false, error: 'HTTP 401 from usage endpoint', windows: [{ key: 'weekly', label: 'Weekly', window_seconds: 604800, remaining_percent: null, resets_at: null }] }] }] };
  plugin.register(mock.ctx); await render(limitsPage());
  assert.equal($('.su-disclosure').textContent, 'Accounts (2)');
  await click($('.su-disclosure'));
  assert.equal($('.su-capacity').textContent, '/ 20 units', 'the account without a reading is left out of the pool');
  // "max" alone does not say 5x or 20x: counted as one base plan, flagged on the row and in a footnote.
  assert.deepEqual([$('.su-account[data-account="acct-b1"] .su-badge').textContent, $('.su-account[data-account="acct-b1"] .su-assumed').textContent], ['max · 20 units', 'capacity unknown, counted as 20*']);
  assert.match($('.su-assumption').textContent, /^\* Capacity unknown for claude-max \(max\), claude-team \(no plan reported\): counted as 20 units, one \$20 plan\.$/);
  assert.equal($('.su-verdict').dataset.status, 'unknown', 'a stale pool without drain data gets no verdict');
  assert.match($('.su-chart-notes').textContent, /1 account without a reading left out of the pool/);
  assert.equal($('.su-rate').textContent, 'no drain data');
  assert.equal($('.su-measure[data-kind="empty"]'), null, 'a flat projection never empties');
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
