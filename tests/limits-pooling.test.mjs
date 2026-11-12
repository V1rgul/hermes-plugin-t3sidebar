import test from 'node:test';
import assert from 'node:assert/strict';
import { pooledHistory, pastResetMarkers, planLabel, resetGroups } from '../desktop/plugin.js';

// Test-only references: the implementations these functions had before the single-pass rewrite, kept verbatim so every output can be compared exactly.
const sampleUnits = sample => Number.isFinite(sample.units) ? sample.units : sample.value;
function referencePooledHistory(samples) {
  const last = new Map(), points = [];
  for (const sample of [...samples].sort((a, b) => a.t - b.t)) {
    last.set(sample.account, sampleUnits(sample));
    let value = 0;
    for (const item of last.values()) value += item;
    const point = { t: sample.t, value, count: last.size };
    if (points.length && points.at(-1).t === sample.t) points[points.length - 1] = point; else points.push(point);
  }
  return points;
}
function referencePastResetMarkers(accounts, samples, from, to, provider = null) {
  const info = new Map((accounts || []).map((account, index) => [account.id, { label: account.label || account.id, plan_label: planLabel(provider, account.plan), priority: Number.isFinite(account.priority) ? account.priority : Infinity, index }]));
  const previous = new Map(), steps = [];
  for (const sample of [...(samples || [])].sort((a, b) => a.t - b.t)) {
    const before = previous.get(sample.account);
    previous.set(sample.account, sample);
    if (!before || sample.t <= from || sample.t > to) continue;
    const restarted = sample.value > before.value || sample.resets_at !== null && before.resets_at !== null && sample.resets_at > before.resets_at + 60;
    const gain = sampleUnits(sample) - sampleUnits(before);
    if (restarted && gain > 1e-9) steps.push({ t: sample.t, account: sample.account, gain, reset_at: before.resets_at !== null && before.resets_at <= sample.t ? before.resets_at : sample.t });
  }
  const pooled = referencePooledHistory(samples || []);
  const levelAt = t => { let value = 0; for (const point of pooled) { if (point.t > t) break; value = point.value; } return value; };
  const rank = id => info.get(id) ?? { priority: Infinity, index: Infinity };
  return resetGroups(steps, 0).map(group => {
    const ordered = [...group.items].sort((a, b) => rank(a.account).priority - rank(b.account).priority || rank(a.account).index - rank(b.account).index);
    let top = levelAt(group.t) - ordered.reduce((sum, item) => sum + item.gain, 0);
    return { t: group.t, accounts: ordered.map(item => { const base = top; top += item.gain; return { id: item.account, label: info.get(item.account)?.label ?? item.account, plan_label: info.get(item.account)?.plan_label ?? null, reset_at: item.reset_at, base, top, gain: item.gain }; }) };
  });
}

// Seeded so every run compares the same inputs.
function mulberry32(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const ACCOUNTS = ['a', 'b', 'c', 'd', 'e'];
const WEIGHTS = { a: 100, b: 20, c: 33.3, d: 7.5, e: 250 };
function randomSamples(random, size) {
  const accounts = ACCOUNTS.slice(0, 1 + Math.floor(random() * ACCOUNTS.length)), samples = [];
  for (let index = 0; index < size; index++) {
    const account = accounts[Math.floor(random() * accounts.length)];
    // Few distinct times, so equal timestamps (also for one account) are common.
    const t = 1_000_000 + Math.floor(random() * size * 0.6) * 300;
    const value = random() < 0.15 ? 0 : random() < 0.3 ? Math.round(random() * 100) : random() * 100;
    const sample = { t, account, value, resets_at: random() < 0.2 ? null : t + Math.floor(random() * 6) * 3600 };
    // Hand-built samples may lack units; their percent then stands in.
    if (random() >= 0.1) sample.units = value * WEIGHTS[account] / 100;
    samples.push(sample);
  }
  return samples;
}
const randomAccounts = random => ACCOUNTS.filter(() => random() < 0.8).map(id => ({ id, label: random() < 0.3 ? undefined : `Account ${id}`, plan: ['prolite', 'plus', 'team', undefined][Math.floor(random() * 4)], priority: random() < 0.2 ? undefined : Math.floor(random() * 3) }));

test('the pooled history summed once per distinct time equals the one re-summed per reading exactly, ties and missing units included', () => {
  assert.deepEqual(pooledHistory([]), []);
  const tie = [{ t: 5, account: 'a', value: 10 }, { t: 5, account: 'b', value: 0.1 }, { t: 5, account: 'a', value: 0.2 }, { t: 7, account: 'c', value: 0.7, units: 0.3 }];
  assert.deepEqual(pooledHistory(tie), referencePooledHistory(tie));
  const random = mulberry32(20261111);
  for (let round = 0; round < 600; round++) {
    const samples = randomSamples(random, Math.floor(random() * 80));
    const copy = structuredClone(samples);
    assert.deepEqual(pooledHistory(samples), referencePooledHistory(samples), `round ${round}`);
    assert.deepEqual(samples, copy, 'the input is left untouched');
  }
});

test('past reset markers from the caller\'s pooled series equal the ones that rebuilt it, for every range', () => {
  const random = mulberry32(4242);
  let groups = 0;
  for (let round = 0; round < 600; round++) {
    const samples = randomSamples(random, Math.floor(random() * 80)), accounts = randomAccounts(random), provider = random() < 0.5 ? 'openai-codex' : null;
    const times = samples.map(sample => sample.t);
    const from = times.length && random() < 0.8 ? times[Math.floor(random() * times.length)] - (random() < 0.5 ? 0 : 150) : -Infinity;
    const to = times.length && random() < 0.8 ? times[Math.floor(random() * times.length)] : Infinity;
    const expected = referencePastResetMarkers(accounts, samples, from, to, provider);
    groups += expected.length;
    assert.deepEqual(pastResetMarkers(accounts, samples, from, to, provider, pooledHistory(samples)), expected, `round ${round} with the caller's series`);
    assert.deepEqual(pastResetMarkers(accounts, samples, from, to, provider), expected, `round ${round} without it`);
  }
  assert.ok(groups > 300, `the inputs produce many reset groups (${groups})`);
  assert.deepEqual(pastResetMarkers([], [], 0, 10), []);
  assert.deepEqual(pastResetMarkers(undefined, undefined, 0, 10, null, []), []);
});
