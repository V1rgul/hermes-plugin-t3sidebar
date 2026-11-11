// tools/test-webapp/t3webapp.sh against a stub container runtime: a copy of the script runs in a scratch Git checkout, with HOME, the data directories and the runtime redirected into one scratch directory, so no real container, demo directory or browser profile can be reached.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../tools/test-webapp/', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 't3webapp-rig-'));
after(() => rmSync(root, { recursive: true, force: true }));

// wait_ready polls the Webapp port; this loopback server answers it instead of any real container.
const server = createServer((request, response) => { response.writeHead(200); response.end('ok'); });
await new Promise(done => server.listen(0, '127.0.0.1', done));
server.unref();
const port = String(server.address().port);

const stub = join(root, 'runtime.sh');
writeFileSync(stub, `#!/bin/sh
{ printf '%s\\037' "$@"; printf '\\n'; } >> "$STUB_LOG"
case "$1 $2" in
'container inspect')
	if [ "$3" = -f ]; then
		case "$4" in
		*State.Running*) case " $STUB_RUNNING " in *" $5 "*) echo true;; *) echo false;; esac;;
		*t3webapp.worktree*) printf '%s\\n' "$STUB_LABEL_WORKTREE";;
		*t3webapp.dir*) printf '%s\\n' "$STUB_LABEL_DIR";;
		*t3webapp.login*) echo none;;
		*) exit 1;;
		esac
		exit 0
	fi
	case " $STUB_EXISTING " in *" $3 "*) exit 0;; esac
	exit 1;;
'ps -a') [ -z "$STUB_PS" ] || printf '%s\\n' "$STUB_PS"; exit 0;;
esac
case "$*" in
*'tar -C /opt/data/plugins/hermes-t3sidebar -xf -'*) cat > "$STUB_TAR";;
*' test '*) exit 1;;
*'cp -a /src/.'*) [ -z "$STUB_INTERRUPT" ] || kill -TERM "$PPID";;
esac
exit 0
`);
chmodSync(stub, 0o755);

const run = (command, args, options = {}) => new Promise(resolve => {
  execFile(command, args, { encoding: 'utf8', ...options }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
});
const git = (cwd, ...args) => run('git', ['-c', 'user.name=Rig', '-c', 'user.email=rig@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, env: { PATH: process.env.PATH, HOME: join(root, 'home') } });
const write = (path, text = '') => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };

let checkouts = 0;
// A fresh scratch checkout holding a copy of the rig, so the script's own location makes it the repository it serves.
async function checkout(files = {}) {
  const repo = join(root, `checkout-${++checkouts}`);
  for (const name of ['t3webapp.sh', 'enable-sidebar.js']) { write(join(repo, 'tools/test-webapp', name)); copyFileSync(join(source, name), join(repo, 'tools/test-webapp', name)); }
  for (const [path, text] of Object.entries({ 'plugin.yaml': 'name: hermes-t3sidebar\n', ...files })) write(join(repo, path), text);
  assert.equal((await git(repo, 'init', '-q')).code, 0);
  assert.equal((await git(repo, 'add', '-A')).code, 0);
  assert.equal((await git(repo, 'commit', '-q', '-m', 'fixture')).code, 0);
  return repo;
}

// Runs the rig with nothing of the caller's environment but PATH; returns its exit code, output and every runtime invocation as an argument list.
async function rig(repo, args, env = {}) {
  const log = join(root, `runtime-${checkouts}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(log, '');
  const result = await run('sh', [join(repo, 'tools/test-webapp/t3webapp.sh'), ...args], { cwd: repo, env: {
    PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), T3WEBAPP_RUNTIME: stub, T3WEBAPP_PORT: port, T3WEBAPP_IMAGE: 'stub.invalid/hermes',
    STUB_LOG: log, STUB_TAR: join(root, 'sync.tar'), ...env
  } });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => line.split('\x1f').slice(0, -1));
  return { ...result, calls };
}
mkdirSync(join(root, 'tmp'), { recursive: true });
const shared = join(root, 'home/t3sidebar-demo');

// Every host path the rig hands to the runtime as a volume stays inside the scratch directory.
function assertScratchVolumes(calls) {
  for (const call of calls) for (let i = 0; i < call.length - 1; i++) if (call[i] === '-v') assert.equal(call[i + 1].startsWith(root + '/'), true, `volume outside scratch: ${call[i + 1]}`);
}

test('destroy refuses the shared data directory whatever the container name', async () => {
  const repo = await checkout();
  write(join(shared, 'data/state.db'), 'shared');
  for (const env of [{ T3WEBAPP_NAME: 't3demo-other' }, { T3WEBAPP_NAME: 't3demo-other', T3WEBAPP_DIR: `${shared}/` }, { T3WEBAPP_NAME: 't3demo-other', T3WEBAPP_DIR: join(root, 'home/./t3sidebar-demo') }, {}]) {
    const result = await rig(repo, ['destroy'], { STUB_EXISTING: 't3demo-other t3demo', ...env });
    assert.equal(result.code, 1, JSON.stringify(env));
    assert.match(result.stderr, /Refusing to destroy/);
    assert.deepEqual(result.calls.filter(call => call[0] === 'rm' || call[0] === 'run'), []);
  }
  assert.equal(readFileSync(join(shared, 'data/state.db'), 'utf8'), 'shared');
});

test('destroy removes a container and its own data directory', async () => {
  const repo = await checkout();
  const own = join(root, 'own-demo');
  write(join(own, 'data/state.db'), 'own');
  write(join(repo, '.t3webapp/shots/a.png'), 'png');
  const result = await rig(repo, ['destroy'], { STUB_EXISTING: 't3demo-own', T3WEBAPP_NAME: 't3demo-own', T3WEBAPP_DIR: own });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.calls.filter(call => call[0] === 'rm').map(call => call.join(' ')), ['rm -f t3demo-own']);
  assert.deepEqual(result.calls.filter(call => call[0] === 'run').map(call => call.join(' ')), [`run --rm --security-opt label=disable -v ${own}:/d --entrypoint rm stub.invalid/hermes -rf /d/data`]);
  assert.equal(existsSync(join(repo, '.t3webapp')), false);
  assertScratchVolumes(result.calls);
});

const gitignore = readFileSync(fileURLToPath(new URL('../.gitignore', import.meta.url)), 'utf8');
const tarList = async archive => (await run('tar', ['-tf', archive])).stdout.split('\n').filter(Boolean).sort();

test('sync copies tracked and unignored project files with their uncommitted edits, and nothing ignored or development-only', async () => {
  const repo = await checkout({ '.gitignore': gitignore, '__init__.py': '', 'desktop/plugin.js': 'committed', 'tests/a.test.mjs': '', 'docs/a.md': '', 'harness/app.mjs': '', 'AGENTS.md': '', 'artifacts/notes.txt': '', 'gone.py': '' });
  write(join(repo, 'desktop/plugin.js'), 'uncommitted edit');
  rmSync(join(repo, 'gone.py'));
  for (const path of ['new_module.py', 'name with space.py', 'odd \'"$name\n.py', '.scratch/capture.json', 'usage.sqlite3', '.venv/lib.py', '__pycache__/x.pyc', '.t3webapp/shots/a.png', 'node_modules/react/index.js', '.worktrees/other/plugin.yaml']) write(join(repo, path), 'x');
  const result = await rig(repo, ['sync'], { STUB_RUNNING: 't3demo' });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await tarList(join(root, 'sync.tar')), ['.gitignore', '__init__.py', 'desktop/plugin.js', 'name with space.py', 'new_module.py', 'odd \'"$name\\n.py', 'plugin.yaml']);
  assert.equal((await run('tar', ['-xOf', join(root, 'sync.tar'), 'desktop/plugin.js'])).stdout, 'uncommitted edit');
  assertScratchVolumes(result.calls);
});

test('sync keeps the installed plugin when the archive cannot be built, and leaves no temporary file', async () => {
  const repo = await checkout({ '__init__.py': '', 'unreadable.py': 'x' });
  chmodSync(join(repo, 'unreadable.py'), 0);
  try {
    const result = await rig(repo, ['sync'], { STUB_RUNNING: 't3demo' });
    assert.notEqual(result.code, 0);
    assert.deepEqual(result.calls.filter(call => call[0] === 'exec' || call[0] === 'restart').map(call => call.join(' ')), []);
  } finally { chmodSync(join(repo, 'unreadable.py'), 0o644); }
  assert.deepEqual(readdirSync(join(root, 'tmp')), []);
  const result = await rig(repo, ['sync'], { STUB_RUNNING: 't3demo' });
  assert.equal(result.code, 0, result.stderr);
  const plugin = result.calls.filter(call => call.includes('/opt/data/plugins/hermes-t3sidebar')).map(call => call.slice(0, 4).join(' '));
  assert.deepEqual(plugin.slice(0, 3), ['exec t3demo rm -rf', 'exec t3demo mkdir -p', 'exec -i t3demo tar']);
  assert.deepEqual(readdirSync(join(root, 'tmp')), []);
});

// A linked worktree of a fresh scratch checkout: its first setup clones the shared container's data.
async function worktree() {
  const main = await checkout({ '__init__.py': '' });
  const path = join(root, `worktree-${checkouts}`, 'feature');
  assert.equal((await git(main, 'worktree', 'add', '-q', path)).code, 0);
  write(join(shared, 'data/state.db'), 'shared');
  return path;
}
const pauses = calls => calls.filter(call => call[0] === 'pause' || call[0] === 'unpause').map(call => call.join(' '));

test('an interrupted worktree setup unpauses the shared container it paused, and only that', async () => {
  const interrupted = await rig(await worktree(), ['setup'], { STUB_RUNNING: 't3demo', STUB_INTERRUPT: '1' });
  assert.equal(interrupted.code, 143, interrupted.stderr);
  assert.deepEqual(pauses(interrupted.calls), ['pause t3demo', 'unpause t3demo']);
  const completed = await rig(await worktree(), ['setup'], { STUB_RUNNING: 't3demo' });
  assert.equal(completed.code, 0, completed.stderr);
  assert.deepEqual(pauses(completed.calls), ['pause t3demo', 'unpause t3demo']);
  const stopped = await rig(await worktree(), ['setup'], { STUB_RUNNING: '', STUB_INTERRUPT: '1' });
  // Nothing was paused, so nothing intercepts the signal: the run simply ends with it.
  assert.notEqual(stopped.code, 0);
  assert.deepEqual(pauses(stopped.calls), []);
  for (const result of [interrupted, completed, stopped]) assertScratchVolumes(result.calls);
});

test('prune stops only the browser whose profile argument is exactly the gone worktree\'s', async () => {
  const repo = await checkout();
  const gone = join(root, 'gone/wt.1'), data = join(root, 'gone-data');
  write(join(data, 'data/state.db'), 'x');
  const profiles = { target: `${gone}/.t3webapp/browser-profile`, longer: `${gone}/.t3webapp/browser-profile-other`, pattern: `${join(root, 'gone/wtx1')}/.t3webapp/browser-profile` };
  const browsers = Object.fromEntries(Object.entries(profiles).map(([name, profile]) => [name, spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', `--user-data-dir=${profile}`], { stdio: 'ignore' })]));
  const ended = Object.fromEntries(Object.entries(browsers).map(([name, child]) => [name, new Promise(resolve => child.once('exit', (code, signal) => resolve(signal)))]));
  try {
    for (const child of Object.values(browsers)) {
      for (let i = 0; i < 200 && !readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').includes('--user-data-dir='); i++) await new Promise(done => setTimeout(done, 10));
    }
    const result = await rig(repo, ['prune'], { STUB_PS: 't3demo-gone', STUB_EXISTING: 't3demo-gone', STUB_LABEL_WORKTREE: gone, STUB_LABEL_DIR: data });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Removing t3demo-gone: worktree .* is gone/);
    assert.equal(await ended.target, 'SIGTERM');
    assert.equal(browsers.longer.exitCode === null && browsers.longer.signalCode === null, true);
    assert.equal(browsers.pattern.exitCode === null && browsers.pattern.signalCode === null, true);
    assertScratchVolumes(result.calls);
  } finally {
    for (const child of Object.values(browsers)) child.kill('SIGKILL');
    await Promise.all(Object.values(ended));
  }
});
