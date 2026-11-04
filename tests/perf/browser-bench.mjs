// Chromium interaction benchmark for the real plugin React tree, built with production React on the synthetic SDK harness.
// Deterministic work (card renders, mounted cards, component renders) is gated strictly because it does not depend on the machine; latency is gated against generous absolute budgets and, with a baseline git ref, against that ref measured interleaved on the same machine so load and CPU speed cancel out.
// Usage: node tests/perf/browser-bench.mjs [--baseline <ref>|none] [--rounds N] [--warmup N] [--only suite,suite] [--cpu N] [--update-budgets]
// These are synthetic fixtures in headless Chromium on Linux, not the Windows Electron client, its IPC or the network.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const budgetsPath = join(repo, 'tests/perf/browser-budgets.json');
const work = join(process.env.TMPDIR || join(homedir(), '.hermes/cache/scratch'), 't3sidebar-perf');
const { values: args } = parseArgs({ options: {
  baseline: { type: 'string' }, rounds: { type: 'string', default: '15' }, warmup: { type: 'string', default: '3' },
  only: { type: 'string' }, cpu: { type: 'string', default: '1' }, 'update-budgets': { type: 'boolean', default: false }
} });
const rounds = Number(args.rounds), warmup = Number(args.warmup), cpu = Number(args.cpu);
assert.ok(rounds >= 3 && warmup >= 0 && cpu >= 1, 'rounds >= 3, warmup >= 0 and cpu >= 1');

const git = (...argv) => execFileSync('git', argv, { cwd: repo, encoding: 'utf8' }).trim();
// Without an explicit ref, a feature branch compares against its merge base with main and uncommitted work on main against HEAD; a clean main has nothing to compare and relies on the absolute budgets.
function defaultBaseline() {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') { try { return git('merge-base', 'HEAD', 'main'); } catch (_) { return null; } }
  return git('status', '--porcelain', '--', 'desktop', 'harness', 'tests/sdk.mock.mjs') ? 'HEAD' : null;
}
const baselineRef = args.baseline === 'none' ? null : args.baseline || defaultBaseline();
const baselineSha = baselineRef ? git('rev-parse', '--verify', `${baselineRef}^{commit}`) : null;

// Production React: the development build's checks distort script timing by several times.
async function bundle(source, out) {
  await mkdir(out, { recursive: true });
  await build({ absWorkingDir: source, entryPoints: [join(source, 'harness/app.mjs')], outfile: join(out, 'app.bundle.js'), bundle: true, format: 'esm', platform: 'browser',
    nodePaths: [join(repo, 'node_modules')], alias: { '@hermes/plugin-sdk': join(source, 'tests/sdk.mock.mjs') }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' });
  await copyFile(join(source, 'harness/index.html'), join(out, 'index.html'));
}
const variants = { candidate: join(work, 'variants/candidate') };
await rm(join(work, 'variants'), { recursive: true, force: true });
await bundle(repo, variants.candidate);
if (baselineSha) {
  // The baseline is the committed tree of the ref, extracted outside the checkout so the working tree is never touched.
  const source = join(work, `src-${baselineSha.slice(0, 12)}`);
  await rm(source, { recursive: true, force: true }); await mkdir(source, { recursive: true });
  execFileSync('sh', ['-c', `git archive ${baselineSha} desktop harness tests | tar -x -C "${source}"`], { cwd: repo });
  variants.baseline = join(work, 'variants/baseline');
  await bundle(source, variants.baseline);
}

const server = createServer(async (request, response) => {
  const root = join(work, 'variants');
  try {
    const path = resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!path.startsWith(root + sep)) throw new Error('Invalid path');
    const body = await readFile(path);
    response.writeHead(200, { 'Content-Type': extname(path) === '.html' ? 'text/html' : 'text/javascript', 'Cache-Control': 'no-store' }); response.end(body);
  } catch (_) { response.writeHead(404); response.end('Not found'); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));

async function executable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  try { await access(chromium.executablePath()); return chromium.executablePath(); } catch (_) { /* inspect existing cache without downloading */ }
  const cache = join(homedir(), '.cache', 'ms-playwright');
  try { for (const name of (await readdir(cache)).filter(name => name.startsWith('chromium-')).sort().reverse()) {
    for (const subdir of ['chrome-linux64', 'chrome-linux']) { const path = join(cache, name, subdir, 'chrome'); try { await access(path); return path; } catch (_) {} }
  } } catch (_) {}
  throw new Error('No Chromium executable. Install the pinned Playwright browser or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.');
}

// ---- Browser side: injected with Function#toString, so these functions must not close over anything in this module. ----

// A minimal DevTools hook counts function components that actually ran in each commit, as React DevTools does: a subtree whose child pointer is unchanged was bailed out and is skipped, and a cloned fiber only carries PerformedWork when its function executed.
function installProbe() {
  const P = window.__perf = { counting: false, renders: {}, componentRenders: 0, longTasks: [] };
  const walk = root => {
    const stack = [root];
    while (stack.length) {
      const fiber = stack.pop();
      if (typeof fiber.type === 'function' && (fiber.flags & 1)) {
        const name = fiber.type.displayName || fiber.type.name || 'anonymous';
        P.renders[name] = (P.renders[name] || 0) + 1; P.componentRenders++;
      }
      if (fiber.child && (!fiber.alternate || fiber.child !== fiber.alternate.child)) for (let child = fiber.child; child; child = child.sibling) stack.push(child);
    }
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, isDisabled: false, renderers: new Map(), inject() { return 1; }, checkDCE() {},
    onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onCommitFiberRoot(_id, root) { if (P.counting) walk(root.current); } };
  try { new PerformanceObserver(list => P.longTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })))).observe({ type: 'longtask', buffered: true }); } catch (_) {}
}

function installOps() {
  const P = window.__perf;
  const $ = selector => document.querySelector(selector), $$ = selector => [...document.querySelectorAll(selector)];
  const frame = () => new Promise(done => requestAnimationFrame(() => done()));
  const channel = new MessageChannel(), queue = [];
  channel.port1.onmessage = () => queue.shift()?.();
  // A macrotask yield without setTimeout's nesting clamp, so asynchronous completions are observed within a fraction of a millisecond.
  const yieldTask = () => new Promise(done => { queue.push(done); channel.port2.postMessage(0); });
  const until = async (condition, what, ms = 5000) => { const end = performance.now() + ms; while (!condition()) { if (performance.now() > end) throw new Error(`timed out waiting for ${what}`); await yieldTask(); } };
  const setValue = (input, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); };
  const click = selector => { const element = $(selector); if (!element) throw new Error(`missing ${selector}`); element.click(); };
  const search = () => $('.sf-search input');
  const toggle = section => $(`[data-section="${section}"] .sf-section-toggle`);
  const firstMounted = () => $('[data-section="active"] .sf-section-body .sf-row')?.dataset.sessionId;
  const segment = text => $$('.mock-segmented button').find(button => button.textContent === text);
  const tokensLine = () => $('.su-chart[data-metric="tokens"] svg g[data-series] .su-line')?.getAttribute('d');
  const usageReady = () => !!$('.su[data-view="usage"]') && $$('.su-chart[data-metric="user_messages"] .su-day-grid').length > 0 && !$('.su-header [role=status]');
  const limitsReady = () => !!$('.su-pooled .su-line.su-projected');
  const hover = (plotSelector, state) => {
    const plot = $(plotSelector), box = plot.getBoundingClientRect();
    state.flip = !state.flip;
    plot.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: box.left + box.width * (state.flip ? 0.3 : 0.7), clientY: box.top + box.height / 2, pointerType: 'mouse' }));
  };
  const hoverState = {};
  const crossMoved = before => { const cross = $('.su-cross'); return !!cross && cross.getAttribute('style') !== before; };
  const openPicker = async () => { if (!$('[aria-label="Choose project filter"]')) { click('[aria-label="Filter sessions"]'); await until(() => $('[aria-label="Choose project filter"]'), 'project picker'); } };
  const fold = section => ({ before: () => toggle(section).getAttribute('aria-expanded'), act: () => toggle(section).click(), done: before => toggle(section).getAttribute('aria-expanded') !== before,
    label: () => toggle(section).getAttribute('aria-expanded') === 'true' ? 'open' : 'close' });
  const OPS = {
    'search-all:type': { act: () => setValue(search(), 'perf'), done: () => !!$('.sf-search .sf-clear') },
    'search-all:clear': { act: () => click('.sf-search .sf-clear'), done: () => !$('.sf-search .sf-clear') },
    'search-narrow:type': { act: () => setValue(search(), 'zz-no-such-session-zz'), done: () => !$('.sf-row') },
    'search-narrow:clear': { act: () => click('.sf-search .sf-clear'), done: () => !$('.sf-search .sf-clear') && !!$('[data-session-id="perf-active-1"]') },
    'fold:archived': fold('archived'), 'fold:working': fold('working'), 'fold:snoozed': fold('snoozed'),
    'filter:open': { act: () => click('[aria-label="Filter sessions"]'), done: () => !!$('[aria-label="Choose project filter"]') },
    'filter:close': { act: () => click('[aria-label="Filter sessions"]'), done: () => !$('[aria-label="Choose project filter"]') },
    'project:side': { setup: openPicker, act: () => click('[aria-label="Filter by Perf side"]'), done: () => !$('[data-session-id="perf-active-1"]') && !!$('[data-session-id="perf-active-0"]') },
    'project:all': { setup: openPicker, act: () => click('[aria-label="All projects"]'), done: () => !!$('[data-session-id="perf-active-1"]') },
    focus: { before: () => $('[data-session-id="perf-active-2"] .sf-open[aria-current=page]') ? 'perf-active-4' : 'perf-active-2',
      act: id => click(`[data-session-id="${id}"] .sf-open`), done: id => !!$(`[data-session-id="${id}"] .sf-open[aria-current=page]`) },
    // An unchanged refetch of every sidebar query, as the five-second poll does; the notify manager publishes on a later task, hence the two yields.
    poll: { act: async () => { await window.hermesT3SidebarHarness.queryClient.invalidateQueries(); await new Promise(done => setTimeout(done)); await new Promise(done => setTimeout(done)); }, done: () => true },
    'scroll:down': { before: firstMounted, act: () => { $('[data-section="active"] .sf-section-body').scrollTop = 1500; }, done: before => firstMounted() !== before },
    'scroll:up': { before: firstMounted, act: () => { $('[data-section="active"] .sf-section-body').scrollTop = 0; }, done: before => firstMounted() !== before },
    'usage:open': { act: () => click('.sf-footer button[aria-label="Usage"]'), done: usageReady },
    'usage:period-right': { setup: () => until(usageReady, 'usage page'), before: tokensLine, act: () => $('.su-axis-range[data-side=past] [data-direction=right]').click(), done: before => tokensLine() !== before && usageReady() },
    'usage:period-left': { before: tokensLine, act: () => $('.su-axis-range[data-side=past] [data-direction=left]').click(), done: before => tokensLine() !== before && usageReady() },
    'usage:mode': { before: () => segment('Independent').getAttribute('aria-pressed') === 'true' ? 'Stacked' : 'Independent', act: text => segment(text).click(), done: text => segment(text).getAttribute('aria-pressed') === 'true', label: text => text.toLowerCase() },
    'usage:split': { before: () => segment('Model').getAttribute('aria-pressed') === 'true' ? 'Provider' : 'Model', act: text => segment(text).click(), done: text => segment(text).getAttribute('aria-pressed') === 'true', label: text => text.toLowerCase() },
    'usage:hover': { before: () => $('.su-cross')?.getAttribute('style') ?? null, act: () => hover('.su-chart[data-metric="tokens"] .su-plot', hoverState), done: crossMoved },
    'page:close': { act: () => click('.harness-back'), done: () => !$('.su') },
    'limits:open': { act: () => click('.sf-footer .sf-limits'), done: limitsReady },
    'limits:hover': { setup: () => until(limitsReady, 'limits page'), before: () => $('.su-pooled .su-cross')?.getAttribute('style') ?? null, act: () => hover('.su-pooled .su-plot', hoverState), done: before => { const cross = $('.su-pooled .su-cross'); return !!cross && cross.getAttribute('style') !== before; } },
    'limits:lookback': {
      setup: async () => { await until(limitsReady, 'limits page'); if (!$('.su-lookback input[type=range]')) { click('.su-provider-limits[data-provider="openai-codex"] .su-measure[data-kind="average"] .su-lookback-edit'); await until(() => $('.su-lookback input[type=range]'), 'lookback slider'); } },
      before: () => ({ value: $('.su-lookback input[type=range]').value === '6' ? '5' : '6', text: $$('.su-measure[data-kind="average"] .su-measure-text').map(node => node.textContent).join('|') }),
      act: ({ value }) => setValue($('.su-lookback input[type=range]'), value),
      done: ({ value, text }) => $('.su-lookback input[type=range]').value === value && $$('.su-measure[data-kind="average"] .su-measure-text').map(node => node.textContent).join('|') !== text }
  };
  P.ops = Object.keys(OPS);
  P.run = async (name, { count = false, observeMs = 0 } = {}) => {
    const op = OPS[name];
    if (!op) throw new Error(`unknown op ${name}`);
    if (op.setup) await op.setup();
    await frame(); await frame();
    const state = op.before?.();
    let mounted = 0, observer;
    if (count) {
      P.renders = {}; P.componentRenders = 0; P.counting = true;
      const note = records => { for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) mounted += (node.matches('.sf-row') ? 1 : 0) + node.querySelectorAll('.sf-row').length; };
      observer = new MutationObserver(note); observer.observe(document.body, { childList: true, subtree: true }); observer.note = note;
    }
    const tasks = P.longTasks.length, start = performance.now();
    await op.act(state);
    await until(() => op.done(state), `${name} to complete`);
    // Reading layout forces the pending style and layout work into the measurement instead of leaving it to the next frame.
    void document.body.offsetHeight;
    const ms = performance.now() - start;
    let last = performance.now(), maxGap = 0;
    const end = last + observeMs;
    for (let frames = 0; frames < 2 || performance.now() < end; frames++) { await frame(); const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }
    const result = { ms, maxGap, label: op.label?.(state) };
    if (count) { observer.note(observer.takeRecords()); observer.disconnect(); P.counting = false; Object.assign(result, { mounted, componentRenders: P.componentRenders, cardRenders: P.renders.SessionRow || 0, renders: P.renders }); }
    const long = P.longTasks.slice(tasks).filter(task => task.start + task.duration >= start);
    return Object.assign(result, { longTasks: long.length, longTaskMs: long.reduce((sum, task) => sum + task.duration, 0) });
  };
}

// Five hundred Ready and five hundred Archived cards reproduce the large-history reports; one card in twenty-five belongs to a second project so the project filter narrows the list.
function seedLarge() {
  const harness = window.hermesT3SidebarHarness, control = harness.control, now = Date.now() / 1000;
  const projects = [{ id: 'perf-main', name: 'Perf main', cwd: '/synthetic/perf-main' }, { id: 'perf-side', name: 'Perf side', cwd: '/synthetic/perf-side' }];
  Object.assign(control, { rows: [], extra: [], live: [], metadata: { version: 1, sessions: {} }, runtimeError: false, backendMissing: false });
  for (const [section, count] of [['active', 500], ['pinned', 20], ['working', 20], ['snoozed', 20], ['archived', 500]]) for (let i = 0; i < count; i++) {
    const id = `perf-${section}-${i}`, project = projects[i % 25 === 0 ? 1 : 0];
    control.rows.push({ id, archived: section === 'archived', title: `PERF ${section} ${i}: synthetic session with a title long enough to ellipsize in the card`, source: 'desktop',
      last_active: now - i * 60 - (section === 'archived' ? 86400 : 0), cwd: project.cwd, project: { id: project.id, name: project.name, icon: '◇', color: null, cwd: project.cwd, is_home: false },
      provider: i % 2 ? 'anthropic' : 'openai-codex', input_tokens: 1000 + i, output_tokens: 250, total_tokens: 1250 + i });
    if (section === 'working') control.live.push({ id: `runtime-${id}`, session_key: id, status: 'working', source: 'desktop', running_subagents: 0, turn_started_at: now - 30 - i, last_active: now });
    if (section === 'pinned') control.metadata.sessions[id] = { state: 'active', pinned: true, settled_at: null, wake_at: null, updated_at: now };
    if (section === 'snoozed') control.metadata.sessions[id] = { state: 'snoozed', pinned: false, settled_at: null, wake_at: now + 3600 + i * 60, updated_at: now };
  }
  control.projectCatalog = projects.map(project => ({ ...project, icon: '◇', color: null, is_home: false, folders: [{ path: project.cwd }], archived: false }));
  control.projects = projects.map(project => ({ id: project.id, label: project.name, path: project.cwd, icon: '◇', color: null }));
  harness.queryClient.clear(); harness.switchScope('perf-large-source');
}

// ---- Node side ----

const SIDEBAR = ['search-all:type', 'search-all:clear', 'search-narrow:type', 'search-narrow:clear', 'fold:archived', 'fold:archived', 'fold:working', 'fold:working', 'fold:snoozed', 'fold:snoozed',
  'filter:open', 'filter:close', 'project:side', 'project:all', 'focus', 'focus', 'poll', 'scroll:down', 'scroll:up'];
const SUITES = [
  { name: 'sidebar', motion: 'reduce', large: true, ops: SIDEBAR },
  // Ordinary motion keeps the fold transitions; the frame gap over the transition is what a user perceives as jank.
  { name: 'sidebar-motion', motion: 'no-preference', large: true, ops: ['fold:archived', 'fold:archived', 'fold:working', 'fold:working'], observeMs: 450 },
  { name: 'usage', motion: 'reduce', ops: ['usage:open', 'usage:period-right', 'usage:period-left', 'usage:mode', 'usage:mode', 'usage:split', 'usage:split', 'usage:hover', 'usage:hover', 'page:close'] },
  { name: 'limits', motion: 'reduce', ops: ['limits:open', 'limits:hover', 'limits:hover', 'limits:lookback', 'limits:lookback', 'page:close'] }
].filter(suite => !args.only || args.only.split(',').includes(suite.name));

const errors = [];
const browser = await chromium.launch({ executablePath: await executable(), headless: true, args: ['--no-sandbox'] });
async function openPage(variant, suite) {
  const context = await browser.newContext({ viewport: { width: 1300, height: 1000 }, deviceScaleFactor: 1, timezoneId: 'Europe/Paris', reducedMotion: suite.motion });
  await context.addInitScript(`(${installProbe})()`);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`${variant}/${suite.name}: ${error.message}`));
  await page.goto(`http://127.0.0.1:${server.address().port}/${variant}/index.html`);
  await page.locator('[data-session-id="approval"]').waitFor({ timeout: 15000 });
  if (suite.large) {
    await page.evaluate(`(${seedLarge})()`);
    await page.locator('[data-session-id="perf-active-0"]').waitFor({ timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('[data-session-id="perf-working-0"]')?.dataset.working === 'true', null, { timeout: 15000 });
  }
  await page.waitForFunction(() => !window.hermesT3SidebarHarness.queryClient.isFetching());
  await page.waitForTimeout(300);
  await page.evaluate(`(${installOps})()`);
  if (cpu > 1) { const cdp = await context.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu }); }
  const steady = await page.evaluate(() => document.querySelectorAll('.sf-row').length);
  return { context, page, steady };
}
const quantile = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]; };
const median = values => { const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };

// results[variant][key] = { samples: [ms], gaps: [ms], longTasks, counts, error }
const results = Object.fromEntries(Object.keys(variants).map(variant => [variant, {}]));
const steady = Object.fromEntries(Object.keys(variants).map(variant => [variant, {}]));
const record = (variant, key) => results[variant][key] ||= { samples: [], gaps: [], longTasks: 0, longTaskMs: 0 };
try {
  for (const suite of SUITES) {
    const pages = {};
    for (const variant of Object.keys(variants)) { pages[variant] = await openPage(variant, suite); steady[variant][suite.name] = pages[variant].steady; }
    // Each op sequence leaves the page as it found it, so warmup, counting and timed rounds repeat the same transitions.
    const sequence = async (variant, mode) => {
      const { page } = pages[variant];
      await page.bringToFront();
      for (const name of suite.ops) {
        // Repeated unlabeled ops (focus, hover) alternate between equivalent targets and share one key, which doubles their samples.
        let key = `${suite.name}/${name}`;
        try {
          const result = await page.evaluate(([name, options]) => window.__perf.run(name, options), [name, { count: mode.startsWith('count'), observeMs: suite.observeMs || 0 }]);
          if (result.label) key += `:${result.label}`;
          if (mode === 'warmup') continue;
          const entry = record(variant, key);
          if (mode.startsWith('count')) {
            // Within a counting round repeated occurrences keep their maximum; across rounds the minimum wins, which drops incidental work such as a poll or a transition frame landing inside one sample.
            const round = entry.countRounds ||= {}, counts = round[mode] ||= { cardRenders: 0, mounted: 0, componentRenders: 0 };
            for (const metric of Object.keys(counts)) counts[metric] = Math.max(counts[metric], result[metric]);
            entry.counts = Object.fromEntries(Object.keys(counts).map(metric => [metric, Math.min(...Object.values(round).map(item => item[metric]))]));
            entry.renders = result.renders; continue;
          }
          entry.samples.push(result.ms); entry.gaps.push(result.maxGap); entry.longTasks += result.longTasks; entry.longTaskMs += result.longTaskMs;
        } catch (error) {
          // A baseline may predate an op; the candidate must run every op.
          record(variant, key).error = error.message.split('\n')[0];
          if (variant === 'candidate') throw error;
          return;
        }
      }
    };
    for (let round = 0; round < warmup; round++) for (const variant of Object.keys(variants)) await sequence(variant, 'warmup');
    for (let round = 0; round < 3; round++) for (const variant of Object.keys(variants)) await sequence(variant, `count${round}`);
    for (let round = 0; round < rounds; round++) {
      // Alternating the order cancels drift such as thermal throttling or a background job starting mid-run.
      const order = Object.keys(variants); if (round % 2) order.reverse();
      for (const variant of order) await sequence(variant, 'time');
    }
    for (const { context } of Object.values(pages)) await context.close();
  }
} finally { await browser.close(); server.close(); }

// ---- Gates ----

const budgets = JSON.parse(await readFile(budgetsPath, 'utf8').catch(() => '{"ops":{},"steady":{}}'));
const tolerance = { ratio: 1.25, floorMs: 3, renderRatio: 1.25, ...budgets.tolerance };
const failures = [], warnings = [], rows = [];
const summarize = entry => entry && entry.samples.length ? { median: median(entry.samples), p95: quantile(entry.samples, 0.95), maxGap: quantile(entry.gaps, 0.95), longTasks: entry.longTasks / entry.samples.length } : null;
for (const key of Object.keys(results.candidate)) {
  const cand = results.candidate[key], base = results.baseline?.[key], c = summarize(cand), b = summarize(base), budget = budgets.ops?.[key];
  const status = [];
  if (budget) {
    if (budget.ms !== undefined && c.median > budget.ms) status.push(`median ${c.median.toFixed(1)} ms > budget ${budget.ms} ms`);
    if (budget.maxGap !== undefined && c.maxGap > budget.maxGap) status.push(`frame gap p95 ${c.maxGap.toFixed(1)} ms > budget ${budget.maxGap} ms`);
    for (const metric of ['cardRenders', 'mounted', 'componentRenders']) if (budget[metric] !== undefined && cand.counts?.[metric] > budget[metric]) status.push(`${metric} ${cand.counts[metric]} > budget ${budget[metric]}`);
  }
  if (b && !base.error) {
    if (c.median > b.median * tolerance.ratio && c.median - b.median > tolerance.floorMs) status.push(`median ${c.median.toFixed(1)} ms vs baseline ${b.median.toFixed(1)} ms`);
    for (const metric of ['cardRenders', 'mounted']) if (cand.counts?.[metric] > base.counts?.[metric]) status.push(`${metric} ${cand.counts[metric]} vs baseline ${base.counts[metric]}`);
    if (cand.counts?.componentRenders > base.counts?.componentRenders * tolerance.renderRatio + 2) status.push(`componentRenders ${cand.counts.componentRenders} vs baseline ${base.counts.componentRenders}`);
  } else if (base?.error) warnings.push(`${key}: baseline could not run it (${base.error})`);
  if (status.length) failures.push(`${key}: ${status.join('; ')}`);
  rows.push({ key, ...c, base: b?.median, delta: b ? (c.median / b.median - 1) * 100 : null, counts: cand.counts || {}, baseCounts: base?.counts, ok: !status.length });
}
for (const [suite, count] of Object.entries(steady.candidate)) {
  const budget = budgets.steady?.[suite]?.mountedRows, base = steady.baseline?.[suite];
  if (budget !== undefined && count > budget) failures.push(`${suite}: ${count} cards mounted at rest > budget ${budget}`);
  if (base !== undefined && suite.startsWith('sidebar') && count > base) failures.push(`${suite}: ${count} cards mounted at rest vs baseline ${base}`);
}
if (errors.length) failures.push(...errors.map(error => `page error ${error}`));

const fmt = (value, digits = 1) => value === undefined || value === null ? '—' : value.toFixed(digits);
const pad = (text, width, left = false) => left ? String(text).padEnd(width) : String(text).padStart(width);
console.log(`\nhermes-t3sidebar browser benchmark · production React · synthetic fixtures · ${rounds} rounds, ${warmup} warmup, CPU ×${cpu}`);
console.log(`candidate: working tree${baselineSha ? ` · baseline: ${baselineRef} (${baselineSha.slice(0, 12)})` : ' · no baseline'}\n`);
console.log(`${pad('operation', 36, true)} ${pad('median', 8)} ${pad('p95', 8)} ${pad('base', 8)} ${pad('Δ%', 7)} ${pad('gap95', 7)} ${pad('cards', 6)} ${pad('mounts', 6)} ${pad('comps', 6)}`);
for (const row of rows) console.log(`${pad(row.key, 36, true)} ${pad(fmt(row.median), 8)} ${pad(fmt(row.p95), 8)} ${pad(fmt(row.base), 8)} ${pad(row.delta === null ? '—' : `${row.delta >= 0 ? '+' : ''}${row.delta.toFixed(0)}`, 7)} ${pad(fmt(row.maxGap, 0), 7)} ${pad(row.counts.cardRenders ?? '—', 6)} ${pad(row.counts.mounted ?? '—', 6)} ${pad(row.counts.componentRenders ?? '—', 6)}${row.ok ? '' : '  ✗'}`);
console.log(`\ncards mounted at rest: ${Object.entries(steady.candidate).map(([suite, count]) => `${suite} ${count}${steady.baseline ? ` (baseline ${steady.baseline[suite]})` : ''}`).join(', ')}`);

await mkdir(work, { recursive: true });
const output = join(work, `browser-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(output, JSON.stringify({ candidate: 'working tree', baseline: baselineSha && { ref: baselineRef, sha: baselineSha }, rounds, warmup, cpu, results, steady, failures, warnings }, null, 2));
console.log(`raw results: ${output}`);

if (args['update-budgets']) {
  // Latency budgets stay generous so only a catastrophic regression trips them on a loaded machine; the baseline comparison catches the subtle ones. Work counts get a small slack for incidental renders such as an age label crossing a minute.
  const next = { tolerance, ops: {}, steady: {} };
  for (const row of rows) {
    const entry = { ms: Math.ceil(Math.max(row.median * 3, row.median + 15)) };
    if (/^sidebar-motion\//.test(row.key)) entry.maxGap = Math.ceil(Math.max(row.maxGap * 2, 60));
    for (const metric of ['cardRenders', 'mounted', 'componentRenders']) if (row.counts[metric] !== undefined) entry[metric] = row.counts[metric] + 2 + Math.ceil(row.counts[metric] * 0.1);
    next.ops[row.key] = entry;
  }
  for (const [suite, count] of Object.entries(steady.candidate)) next.steady[suite] = { mountedRows: count + 2 + Math.ceil(count * 0.1) };
  await writeFile(budgetsPath, JSON.stringify(next, null, 2) + '\n');
  console.log(`budgets written: ${budgetsPath}`);
}
const unbudgeted = rows.filter(row => !budgets.ops?.[row.key]).map(row => row.key);
if (unbudgeted.length && !args['update-budgets']) console.log(`WARN ${unbudgeted.length} operations have no budget yet (${unbudgeted.slice(0, 3).join(', ')}${unbudgeted.length > 3 ? ', …' : ''}); record them with --update-budgets`);
for (const warning of warnings) console.log(`WARN ${warning}`);
if (failures.length) { for (const failure of failures) console.log(`FAIL ${failure}`); process.exitCode = 1; }
else console.log('PASS browser performance gates');
