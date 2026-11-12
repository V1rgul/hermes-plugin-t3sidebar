import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './child-fixture.mjs';

const node = (source, options) => startFixture(process.execPath, ['-e', source], options);

test('a fixture that exits before printing its port fails at once with its stderr', { timeout: 10000 }, async () => {
  const fixture = node('process.stderr.write("ModuleNotFoundError: no fastapi\\n"); process.exit(3)', { readyMs: 8000 });
  try {
    await assert.rejects(fixture.ready, error => {
      assert.match(error.message, /exited \(code 3\) before printing its port/);
      assert.match(error.message, /ModuleNotFoundError: no fastapi/);
      return true;
    });
    assert.equal(fixture.child.exitCode, 3);
  } finally { await fixture.stop(); }
});

test('a silent fixture fails at its deadline and is terminated', { timeout: 10000 }, async () => {
  const fixture = node('process.stderr.write("still importing\\n"); setInterval(() => {}, 1000)', { readyMs: 300 });
  try {
    await assert.rejects(fixture.ready, /printed no port within 300 ms\nstill importing/);
  } finally { await fixture.stop(); }
  assert.equal(fixture.child.signalCode, 'SIGTERM');
});

test('stopping a fixture that ignores SIGTERM falls back to SIGKILL', { timeout: 10000 }, async () => {
  const fixture = node('process.on("SIGTERM", () => {}); console.log(4321); setInterval(() => {}, 1000)', { stopMs: 300 });
  try {
    assert.equal(await fixture.ready, 4321);
  } finally { await fixture.stop(); }
  assert.equal(fixture.child.signalCode, 'SIGKILL');
  await fixture.stop();
});

test('a fixture that cannot be spawned or prints no port is reported', { timeout: 10000 }, async () => {
  const missing = startFixture('/nonexistent/t3sidebar-python', [], { readyMs: 5000 });
  try { await assert.rejects(missing.ready, /failed to start: spawn \/nonexistent\/t3sidebar-python ENOENT/); } finally { await missing.stop(); }
  const chatty = node('console.log("Traceback (most recent call last):"); setInterval(() => {}, 1000)', { readyMs: 5000 });
  try { await assert.rejects(chatty.ready, /printed "Traceback \(most recent call last\):" instead of a port/); } finally { await chatty.stop(); }
  assert.equal(chatty.child.signalCode, 'SIGTERM');
});
