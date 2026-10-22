// Reusable ephemeral static server, used by harness and browser smoke.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function serveHarness(port = 0) {
  const root = fileURLToPath(new URL('./', import.meta.url));
  const server = createServer(async (request, response) => {
    try {
      const path = resolve(root, '.' + new URL(request.url, 'http://localhost').pathname.replace(/\/$/, '/index.html'));
      if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error('Invalid path');
      const body = await readFile(path);
      response.writeHead(200, { 'Content-Type': extname(path) === '.html' ? 'text/html' : 'text/javascript', 'Cache-Control': 'no-store' }); response.end(body);
    } catch (_) { response.writeHead(404); response.end('Not found'); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await serveHarness(Number(process.env.PORT || 4173));
  console.log(`Synthetic hermes-t3sidebar harness: http://127.0.0.1:${server.address().port}`);
}
