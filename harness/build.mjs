import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
// The Codicon stylesheet lands in app.bundle.css with its font inlined, so the static server needs no font route.
await build({ absWorkingDir: root, entryPoints: ['harness/app.mjs'], outfile: 'harness/app.bundle.js', bundle: true, format: 'esm', platform: 'browser', loader: { '.ttf': 'dataurl' },
  alias: { '@hermes/plugin-sdk': fileURLToPath(new URL('./sdk.mjs', import.meta.url)) }, define: { 'process.env.NODE_ENV': '"development"' } });
console.log('Built synthetic harness: harness/index.html');
