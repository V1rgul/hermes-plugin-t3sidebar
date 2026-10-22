# Review remediation

## Closed findings

- Await `host.profileRoutes()` and fence asynchronous discovery with connection/profile/activation-epoch checks. List, open and new-chat reject both ordinary switches and ABA switches before dispatching anything into a changed scope.
- Open saved sessions with the exact route descriptor, `profile: route.profile` and `intent: 'in-place'`; new-chat receives that route too. Duplicate profile names or stored IDs on another source do not discard ownership.
- Select rows using `focusedStoredSessionId` and matching `focusedSessionOwner`, including compression aliases and focused tiles. Runtime IDs no longer drive selection.
- Search temporarily expands shelves to reveal matches without overwriting their saved collapsed preference. Clearing search restores the prior collapsed state.
- Replace legacy unqualified runtime RPC with companion `GET /runtime`. The companion derives the current profile from `get_hermes_home()`, resolves the authenticated native authority/principal with `_session_mutation_context`, reduces capabilities to `session:read`, and delegates to native `gateway.session_active_list.active_list`. Native pending-control waiting detection is preserved. No native mutation, history claim, execution control or legacy registry scanning is introduced.
- Add companion `GET /sessions?offset=…&limit=…` (maximum page size 500). It uses a native read-only SessionDB and native rich listing/projection, strips responses to an explicit picker-field allowlist, and automatically backfills plugin metadata references outside the recent page. Compression roots remain stable, and recovered rows retain project/branch fields. Substring ID-query results are exact-checked and paginated until the target is found or results end.
- Older browsing uses bounded rich pages through the host query cache, loaded on demand, without an older-history polling interval. The periodic recent snapshot includes metadata-reference backfill rather than retrieving an ever-growing unfiltered history snapshot.
- Both companion listings reject arbitrary query-profile selection and return an exact current-profile marker. The frontend checks that marker against the selected route's target profile. Missing/incompatible runtime becomes explicitly unknown, without an unqualified RPC fallback. Missing session listing retains the SDK's rich 500-row read-only browser with an explicit cap/recovery warning.

## Files changed in this remediation

Production:

- `desktop/plugin.js`
- `dashboard/plugin_api.py`

Tests:

- `tests/sdk.mock.mjs` — asynchronous route contract, stored focus/owner atoms, companion fixture responses and explicit route recording.
- `tests/frontend.test.mjs` — discovery switches/ABA, route ownership collisions, foreign runtime matching-ID rejection, stored versus runtime focus, collapsed-search recovery, rich older pagination, 501st-row remount/due-wake/project filtering, and capped SDK fallback.
- `tests/test_backend.py` — distinguish native read-only listing from forbidden native history/execution writes, and update route/HTTP rejection expectations.
- `tests/test_native_contracts.py` (new) — native active-list waiting implementation with injected authority resolution; current-profile/no-profile-query/503 contracts; native rich pagination, compression-root backfill, project/branch preservation, response allowlisting, unchanged scratch native DB bytes; exact-ID recovery beyond 500 substring matches.
- `tests/backend_fixture.py` — real loopback HTTP fixture with temporary native SessionDB history and injected runtime reader.
- `tests/integration.test.mjs` — actual controller + real FastAPI + native read-only scratch SessionDB listing + persistent metadata; 501st organized row recovery across a fresh controller and due wake.

Report: `docs/remediation.md` (new). Browser verification regenerated `artifacts/frontend.png`, `artifacts/actions.png` and the ignored `harness/app.bundle.js`. No dependency or manifest changes were needed. `requirements-dev.txt` and the parent's test scripts remain intact.

## Verification

Initial async-mock reproduction: `npm test` failed 9 tests, including `routes.find is not a function`; this demonstrated the actual SDK mismatch rather than preserving the old synchronous mock assumption.

Final commands, all exit status 0:

```text
npm run test:all
  Node: 32 tests, 32 pass, 0 fail
  Python unittest: Ran 22 tests in 2.964s — OK
  Browser smoke: 13 checks passed
  Browser: no page errors

hermes plugins doctor --ci .
  manifest: session-flow 0.1.0 (standalone)
  OK: runtime discovery, manifest parsing, import, and registration passed
  registrations: 0 tool(s), 0 hook(s)

node --check desktop/plugin.js
node --check tests/sdk.mock.mjs
node --check tests/frontend.test.mjs
node --check tests/integration.test.mjs
  All passed without diagnostics.
```

## Compatibility and remaining limits

- The Python companion deliberately has a narrow **version-sensitive native boundary**, not a promise of a stable public runtime API: `_session_mutation_context`, `_open_session_db_for_profile`, `Principal`, native `active_list`, and the rich-list signature/projection must exist on the target Hermes version. Imports are lazy. Compatibility/storage failures become HTTP 503; native authentication/profile refusals remain refusals. A standalone dashboard without a native session authority cannot supply authoritative runtime status.
- Production routes depend on the host's authenticated plugin mount. Tests do not claim to exercise a deployed remote authentication stack: authority/principal resolution and HTTP runtime rows are injected fixtures. The installed native active-list waiting code and rich SessionDB implementation are separately exercised against explicit doubles and scratch databases. No test reads a live profile DB.
- Archived/hidden native history is not added to browsing. Backfill follows native rich-list visibility rules. Search covers loaded rows plus automatically recovered organized references, not all unrequested history. Offset pagination can shift as native history changes; stable-root merging deduplicates overlaps. An exact-full final page may offer one additional empty page because `has_more` is based on native page fullness rather than a separate, differently filtered count.
- Each missing organized reference requires native ID-filtered lookup(s); very large organization sets or short IDs with many substring matches can increase recent-snapshot cost. There is no repeated full-history frontend fetch and no plugin-owned timer.
- No install, enablement/configuration change, restart, upstream/core edit, commit or push was performed. This is checkout verification, not live deployment verification.
- Reusable routing/listing regression lessons were saved in the default profile's `desktop-plugin-session-contracts` skill; no other profile was modified.
