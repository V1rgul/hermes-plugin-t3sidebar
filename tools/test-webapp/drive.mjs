// Runs one step in the worktree's test browser (t3webapp.sh browser) over its CDP port, like a call to an interactive browser tool: the browser, its page and its profile outlive every call, and each worktree's browser has its own port, so worktrees are driven in parallel.
// Usage: t3webapp.sh drive '<async function body>'. The body gets page, context and shot(name), which saves a screenshot and returns its path; a returned value is printed (strings as is, anything else as JSON). `node drive.mjs --chromium` prints the Chromium t3webapp.sh browser starts.
import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

// The browser smoke test's rule: the explicit path, the pinned Playwright Chromium, else the newest one already in the cache, never a download.
async function executable() {
	if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
	try { await access(chromium.executablePath()); return chromium.executablePath(); } catch (_) { /* inspect the existing cache */ }
	const cache = join(homedir(), '.cache', 'ms-playwright');
	try {
		for (const name of (await readdir(cache)).filter(name => name.startsWith('chromium-')).sort().reverse()) {
			for (const subdir of ['chrome-linux64', 'chrome-linux']) { const path = join(cache, name, subdir, 'chrome'); try { await access(path); return path; } catch (_) {} }
		}
	} catch (_) {}
	throw new Error('No Chromium executable. Install the pinned Playwright browser or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.');
}
if (process.argv[2] === '--chromium') {
	try { process.stdout.write(await executable()); process.exit(0); } catch (error) { console.error(error.message); process.exit(1); }
}

const port = process.env.T3WEBAPP_CDP_PORT, shots = process.env.T3WEBAPP_SHOTS, body = process.argv[2];
if (!port || !shots || !body) {
	console.error('Run through t3webapp.sh drive \'<async function body>\'.');
	process.exit(2);
}
let browser;
try {
	browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
} catch (_) {
	console.error(`No test browser on CDP port ${port}: start it with t3webapp.sh browser.`);
	process.exit(1);
}
const context = browser.contexts()[0];
const page = context.pages().find(candidate => !candidate.url().startsWith('devtools:')) ?? await context.newPage();
const shot = async (name = 'shot') => {
	const path = `${shots}/${name}.png`;
	await page.screenshot({ path });
	return path;
};
const AsyncFunction = (async () => {}).constructor;
let code = 0;
try {
	const value = await new AsyncFunction('page', 'context', 'shot', body)(page, context, shot);
	if (value !== undefined) console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 1));
} catch (error) {
	console.error(error?.stack || String(error));
	code = 1;
} finally {
	// A browser reached over CDP is only disconnected: its default context, pages and process stay.
	await browser.close();
}
process.exit(code);
