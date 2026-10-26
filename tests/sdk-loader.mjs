export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@hermes/plugin-sdk') return { url: new URL('./sdk.mock.mjs', import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
}

// Expose private components only to the focused work-count tests, not the shipped entry.
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url === new URL('../desktop/plugin.js?performance-test', import.meta.url).href) {
    return { ...result, source: `${result.source}\nexport { SessionWindow, WorkingDuration };` };
  }
  return result;
}
