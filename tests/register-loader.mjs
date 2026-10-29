import { register } from 'node:module';
// The synthetic limits load follows local office hours and the charts label local days, so every suite uses the browser smoke's zone instead of the machine's.
process.env.TZ = 'Europe/Paris';
register('./sdk-loader.mjs', import.meta.url);
