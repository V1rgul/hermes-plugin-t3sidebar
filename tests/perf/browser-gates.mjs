// Gate decisions of browser-bench.mjs, free of browser, server and file work so that `npm test` can check them without measuring anything.

// An unknown or empty selection would measure nothing and still pass, so it is refused before any work starts.
export function selectSuites(suites, only) {
  if (only === undefined) return suites;
  const names = only.split(',').map(name => name.trim()).filter(Boolean);
  const unknown = names.filter(name => !suites.some(suite => suite.name === name));
  if (unknown.length) throw new Error(`unknown suite ${unknown.join(', ')} (known: ${suites.map(suite => suite.name).join(', ')})`);
  if (!names.length) throw new Error('--only selects no suite');
  return suites.filter(suite => names.includes(suite.name));
}

// A missing budget file would otherwise gate nothing; only a recording run may start without one. `text` is null when the file does not exist.
export function parseBudgets(text, { path, recording }) {
  if (text === null) {
    if (recording) return { ops: {}, steady: {} };
    throw new Error(`no budget file at ${path}; record one with --update-budgets`);
  }
  let budgets;
  try { budgets = JSON.parse(text); } catch (error) { throw new Error(`unreadable budget file ${path}: ${error.message}`); }
  if (!budgets || typeof budgets !== 'object' || typeof budgets.ops !== 'object' || typeof budgets.steady !== 'object' || !budgets.ops || !budgets.steady) throw new Error(`budget file ${path} lacks its ops and steady sections`);
  return budgets;
}

// Every measured operation and every measured suite's resting card count must have a budget, otherwise a new operation would never be gated.
export function missingBudgets(budgets, operations, suites) {
  const missing = operations.filter(key => !budgets.ops?.[key]).map(key => `${key}: no budget; record it with --update-budgets`);
  for (const suite of suites) if (budgets.steady?.[suite]?.mountedRows === undefined) missing.push(`${suite}: no budget for cards mounted at rest; record it with --update-budgets`);
  return missing;
}

// A partial recording replaces only the suites it measured, in suite order, and keeps the others' budgets as they were.
export function mergeBudgets(existing, measured, suites, measuredSuites) {
  const ops = {}, steady = {};
  for (const suite of suites) {
    const source = measuredSuites.includes(suite) ? measured : existing;
    for (const [key, entry] of Object.entries(source.ops || {})) if (key.slice(0, key.indexOf('/')) === suite) ops[key] = entry;
    if (source.steady?.[suite] !== undefined) steady[suite] = source.steady[suite];
  }
  return { tolerance: measured.tolerance, ops, steady };
}
