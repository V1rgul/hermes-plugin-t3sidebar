# Desktop profile query and standalone runtime fix

## Reproduction and cause

Desktop's `src/api/plugins.ts:profileScoped` passes the current route profile to
`electron/connection-config.ts:pathWithProfileScope`. Consequently, calls the
plugin makes to `/runtime` and `/sessions?offset=0&limit=500` arrive under
`/api/plugins/hermes-t3sidebar` with an additional `profile` query parameter.
The companion rejected that key before invoking either native reader.

The original local regression returned **422** with
`Only current-profile listing parameters are accepted` for
`/runtime?profile=exact-profile`; the no-query request succeeded. The loopback
HTTP/controller regression also failed once the transport injected `profile`.
The supplied live investigation reported the equivalent **200 without profile /
422 with profile=default** on both endpoints; this change was not deployed to
that backend.

A separate topology issue remains after removing the 422: a standalone
`dashboard` can have no `app.state.session_authority` while its chats live in
that same process's loaded `tui_gateway.server`. Requiring an authority in every
case made this topology return 503 despite having a native scoped read seam.

## Changes and boundaries

- Accept optional transport `profile` only when **every** value exactly equals
  the profile established by the host. Matching repeats work; foreign, mixed,
  empty, `current` alias and unknown parameters remain 422. No query value is
  independently used to choose a home or store. The production mount's
  `_plugin_route_secret_scope` still establishes that context first.
- Authority-backed runtime keeps native authenticated `_session_mutation_context`
  and `gateway.session_active_list.active_list` with a read-only-capability actor.
- With no authority, first retain the native authenticated actor/home boundary
  and `session:read` capability; also check a native HTTP grant's home, because
  the installed resolver checks that grant only in its authority-backed branch.
  Then use **only** `sys.modules['tui_gateway.server']` and native
  `tui_gateway.ws_legacy_fallback._own_profile_read`. That helper locks/snapshots
  the native registry, filters exact resolved homes (including launch-home
  defaults), excludes finalized sessions, and uses native `_session_live_item`
  waiting/working detection. No imported replacement server, handwritten
  registry scan, unqualified RPC or private-loopback credential bridge is used.
- A small native-server adapter converts the native `_profile_home()` launch sentinel (`None`) into `server._launch_home()` before the helper performs its unchanged exact-home comparison. The adapter delegates native row mapping and captures source provenance only for rows that the native helper already admitted; it never walks a separate registry or modifies the native server.
- Native legacy rows lack source. Persisted source facts are read through `_open_session_db_for_profile(..., read_only=True).get_session`. Empty drafts intentionally have no database row: only those rows may use the source captured from that exact-home native mapping. Internal sources are excluded in both cases; genuinely unknown provenance stays 503. Return only allowlisted native fields with an empty preview. Native title projection retains its own native DB-read seam; tests replace it with scratch read-only handles.
- Missing native helper/server/storage or unresolved native scope stays 503.
  Foreign actor/grant stays 403; unauthenticated in-process requests stay 401.
  Hosted plugin admission is not a native actor: runtime explicitly returns 503
  instead of inventing authority or interpreting an empty host registry as idle.
- SDK fallback text reports loaded/available counts for numeric totals up to
  500 (including 270), and an actual cap only for totals above 500. It still
  discloses unavailable organized-history recovery and remains read-only.

Production source changes: **`dashboard/plugin_api.py` and `desktop/plugin.js`**.
State/mutation routes, metadata schema and native execution/history operations
are unchanged. Earlier remediation/review documents remain historical records.

## Verification

Regressions were run red before the implementation. Final local execution:

| Check | Result |
|---|---|
| `npm test` | 33 tests passed, including real loopback FastAPI/controller requests with Desktop-style injected profile |
| `npm run test:backend` | 38 tests passed with ResourceWarning promoted to errors |
| Final parent verification | 33 Node tests and 38 Python tests passed from the checkout; 13 Chromium checks passed in an identical scratch harness copy; no browser page errors |
| `node --check desktop/plugin.js` | Passed |
| `PYTHONDONTWRITEBYTECODE=1 hermes plugins doctor --ci .` | Discovery, manifest, import and registration passed; 0 tools/hooks |
| `git diff --check` | Passed |

Standalone regressions exercise the **installed real** `_session_mutation_context`,
`_own_profile_read`, `_session_live_item` and pending-request waiting detection,
with synthetic authenticated grants/registries/profile resolution and scratch
native DBs. Two profiles share a stored ID but retain distinct waiting/working
runtime IDs; internal sources disappear, exact loaded-module identity is checked,
and scratch native DB bytes remain unchanged. A FastAPI mount uses the production
`_plugin_route_secret_scope` dependency with a synthetic home-scope resolver and
confirms both listing handlers see the established home, including repeated-query
refusal. These are native-contract fixtures, not a live authenticated mount or
Electron-on-Windows verification.

No live DB, upstream test suite, credential, deployment, configuration change,
service restart, commit or push was used. Browser build/screenshots stayed in
scratch, preserving checked-in artifacts. Backend activation and the Windows
Desktop UI update remain separate authorized follow-up work.
