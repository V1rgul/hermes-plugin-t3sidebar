// Runs a test fixture process that announces its port on its first stdout line, without any unbounded wait on its start or its end.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// `ready` resolves with the port, or rejects with the captured stderr as soon as the process fails to start, exits or stays silent past `readyMs`. `stop` sends SIGTERM, then SIGKILL after `stopMs`, and is safe to call more than once and before `ready` settles.
export function startFixture(command, args, { readyMs = 10000, stopMs = 3000 } = {}) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', finished = false;
  child.stderr.on('data', bytes => { stderr += bytes; });
  const ended = new Promise(resolve => {
    child.once('exit', () => { finished = true; resolve(); });
    child.once('error', () => { finished = true; resolve(); });
  });
  const lines = createInterface({ input: child.stdout });
  const detail = () => (stderr.trim() ? `\n${stderr.trim()}` : '');
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture printed no port within ${readyMs} ms${detail()}`)), readyMs);
    const fail = message => { clearTimeout(timer); reject(new Error(message + detail())); };
    lines.once('line', line => {
      clearTimeout(timer);
      const port = Number(line);
      if (Number.isInteger(port) && port > 0) resolve(port); else fail(`fixture printed ${JSON.stringify(line)} instead of a port`);
    });
    child.once('error', error => fail(`fixture failed to start: ${error.message}`));
    // 'close' follows the end of stderr, so the message carries everything the process wrote.
    child.once('close', (code, signal) => fail(`fixture exited (${signal || `code ${code}`}) before printing its port`));
  });
  // A rejection nobody awaits yet, because the caller is still in its own setup, must not crash the runner.
  ready.catch(() => {});
  let stopping;
  const stop = () => stopping ||= (async () => {
    if (!finished) {
      child.kill('SIGTERM');
      let timer;
      await Promise.race([ended, new Promise(resolve => { timer = setTimeout(resolve, stopMs); })]);
      clearTimeout(timer);
      if (!finished) { child.kill('SIGKILL'); await ended; }
    }
    lines.close();
  })();
  return { child, ready, stop, stderr: () => stderr };
}
