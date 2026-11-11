// tools/test-webapp/t3webapp.sh against a stub container runtime: a copy of the script runs in a scratch Git checkout, with HOME, the data directories and the runtime redirected into one scratch directory, so no real container, demo directory or browser profile can be reached.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
