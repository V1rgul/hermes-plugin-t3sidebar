import test from 'node:test';
import assert from 'node:assert/strict';
import { missingBudgets, mergeBudgets, parseBudgets, selectSuites } from './perf/browser-gates.mjs';

const suites = [{ name: 'sidebar' }, { name: 'sidebar-motion' }, { name: 'usage' }, { name: 'limits' }];
const names = selected => selected.map(suite => suite.name).join(',');

test('browser benchmark selection refuses unknown and empty selectors instead of measuring nothing', () => {
  assert.equal(names(selectSuites(suites, undefined)), 'sidebar,sidebar-motion,usage,limits');
  assert.equal(names(selectSuites(suites, 'usage,sidebar')), 'sidebar,usage');
  assert.equal(names(selectSuites(suites, ' limits ,')), 'limits');
  assert.throws(() => selectSuites(suites, 'usgae'), /unknown suite usgae \(known: sidebar, sidebar-motion, usage, limits\)/);
  assert.throws(() => selectSuites(suites, 'usage,bogus'), /unknown suite bogus/);
  assert.throws(() => selectSuites(suites, ''), /selects no suite/);
  assert.throws(() => selectSuites(suites, ','), /selects no suite/);
});

test('browser budgets fail closed outside a recording run', () => {
  const path = '/scratch/browser-budgets.json';
  assert.throws(() => parseBudgets(null, { path, recording: false }), /no budget file at \/scratch\/browser-budgets.json/);
  assert.deepEqual(parseBudgets(null, { path, recording: true }), { ops: {}, steady: {} });
  assert.throws(() => parseBudgets('{"ops":', { path, recording: false }), /unreadable budget file/);
  assert.throws(() => parseBudgets('{"ops":', { path, recording: true }), /unreadable budget file/);
  assert.throws(() => parseBudgets('{"ops":{}}', { path, recording: false }), /lacks its ops and steady sections/);
  assert.throws(() => parseBudgets('null', { path, recording: false }), /lacks its ops and steady sections/);
  assert.deepEqual(parseBudgets('{"ops":{"usage/usage:open":{"ms":40}},"steady":{}}', { path, recording: false }).ops, { 'usage/usage:open': { ms: 40 } });
});

test('an operation or suite without a budget is a gate failure', () => {
  const budgets = { ops: { 'usage/usage:open': { ms: 40 } }, steady: { usage: { mountedRows: 11 } } };
  assert.deepEqual(missingBudgets(budgets, ['usage/usage:open'], ['usage']), []);
  assert.deepEqual(missingBudgets(budgets, ['usage/usage:open', 'usage/usage:new'], ['usage', 'limits']), [
    'usage/usage:new: no budget; record it with --update-budgets',
    'limits: no budget for cards mounted at rest; record it with --update-budgets'
  ]);
  assert.deepEqual(missingBudgets({ ops: {}, steady: {} }, [], []), []);
});

test('a partial budget recording keeps the budgets of suites it did not measure', () => {
  const existing = { tolerance: { ratio: 1.25 }, ops: {
    'sidebar/poll': { ms: 30, cardRenders: 2 }, 'sidebar-motion/fold:archived:open': { ms: 50, maxGap: 60 },
    'usage/usage:open': { ms: 40 }, 'usage/usage:removed': { ms: 9 }, 'limits/limits:open': { ms: 35 }
  }, steady: { sidebar: { mountedRows: 83 }, 'sidebar-motion': { mountedRows: 83 }, usage: { mountedRows: 11 }, limits: { mountedRows: 11 } } };
  const measured = { tolerance: { ratio: 1.3 }, ops: { 'usage/usage:open': { ms: 45 }, 'usage/usage:hover': { ms: 20 } }, steady: { usage: { mountedRows: 12 } } };
  const merged = mergeBudgets(existing, measured, suites.map(suite => suite.name), ['usage']);
  assert.deepEqual(Object.keys(merged.ops), ['sidebar/poll', 'sidebar-motion/fold:archived:open', 'usage/usage:open', 'usage/usage:hover', 'limits/limits:open']);
  assert.deepEqual(merged.ops['usage/usage:open'], { ms: 45 });
  assert.deepEqual(merged.ops['sidebar/poll'], { ms: 30, cardRenders: 2 });
  assert.deepEqual(merged.ops['limits/limits:open'], { ms: 35 });
  assert.deepEqual(merged.steady, { sidebar: { mountedRows: 83 }, 'sidebar-motion': { mountedRows: 83 }, usage: { mountedRows: 12 }, limits: { mountedRows: 11 } });
  assert.deepEqual(merged.tolerance, { ratio: 1.3 });
  const full = mergeBudgets({ ops: {}, steady: {} }, measured, suites.map(suite => suite.name), ['usage']);
  assert.deepEqual(Object.keys(full.ops), ['usage/usage:open', 'usage/usage:hover']);
  assert.deepEqual(full.steady, { usage: { mountedRows: 12 } });
});
