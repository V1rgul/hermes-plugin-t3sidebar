# Local verification evidence

## Executed final suite

From the repository root:

```sh
npm run test:all && node --check desktop/plugin.js && hermes plugins doctor --ci . && git diff --check && git ls-remote origin refs/heads/main
```

The command completed with exit status 0 after the internal-source exclusion fix:

| Gate | Actual result |
| --- | --- |
| Node/React/controller integration | 32 tests passed, 0 failed |
| Python metadata/native-contract tests | 23 tests passed |
| Chromium interaction smoke | 13 checks passed; no page errors |
| JavaScript syntax | Passed |
| Hermes Plugin Doctor | `session-flow 0.1.0`; discovery, manifest parsing, import and registration passed; no tools/hooks |
| Remote main ref | Empty response: the repository’s main branch has not been published |

`git diff --check` alone does not inspect the intentionally untracked files of an unborn branch; syntax tests, exercised imports and explicit archive manifests complement that check. No commit or push was made to manufacture a review baseline.

## Last regression

A new scratch-native-DB test first failed against the preceding candidate because `internal-oneshot` displaced an interactive history row. Both native rich-list calls now receive Hermes’s `INTERNAL_LISTING_SOURCES` exclusion: the main paginated list and organized-ID backfill. The regression checks recent/older pages, backfill and unchanged native scratch DB bytes. It passed in the final 23-test backend suite.

## What the tests establish

- Actual React rendering and interaction of the shipped plugin, using a development-only SDK adapter.
- Profile-qualified runtime responses and exact owner-route handling, including async discovery and ABA switches.
- Distinct stored/runtime selection identities, focused-tile ownership and compression lineage aliases.
- Waiting precedence, separate Working, reversible settlement, snooze eligibility, custom timestamps, pins, Undo, search and project filtering.
- A real loopback HTTP connection between the frontend controller and the Python FastAPI companion, with temporary SQLite storage and scratch native session history.
- Rich older pagination and automatic recovery of an organized 501st session after remount and due wake.
- Read-only native listing and non-mutation of synthetic/native scratch history.

## Not established by local verification

The Chromium harness uses explicitly synthetic SDK/session fixtures; it is not Electron. The real remote authentication/enablement stack, installation on the user’s Windows computer and live native conversation navigation have not been exercised. Native companion helpers are version-sensitive and reject unavailable/incompatible runtime rather than supplying unqualified legacy data. No production profile history was used as test input or mutated.

Independent review history is in `review.md` and `verification-review.md`; the final bounded recheck is recorded separately in `verification-final.md`.
