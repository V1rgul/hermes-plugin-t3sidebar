import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await build({ absWorkingDir: root, entryPoints: ['harness/app.mjs'], outfile: 'harness/app.bundle.js', bundle: true, format: 'esm', platform: 'browser',
  alias: { '@hermes/plugin-sdk': fileURLToPath(new URL('../tests/sdk.mock.mjs', import.meta.url)) }, define: { 'process.env.NODE_ENV': '"development"' } });
console.log('Built synthetic harness: harness/index.html');
