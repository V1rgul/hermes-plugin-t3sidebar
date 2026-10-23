# Native archive UI — local verification

## Result

The production React sidebar uses **Archive**, **Archived**, and **Unarchive**. The Archived shelf reads the owning profile's native archive feed, including sessions archived in another client with no plugin metadata. Legacy plugin `settled` metadata does not classify a session as natively archived and is not bulk-migrated.

Native changes call the public profile-routed `session.archive` RPC with the durable lineage root and an explicit `archived: true` or `false`. Exact persisted profile, ID, and boolean readback is required both before and after the RPC. A failed or unsupported exact reader prevents mutation. Dropped writes and malformed confirmations do not become successful actions or create Undo.

Unarchive restores the plugin organization state to Ready while preserving pin state. An explicit per-session `restore` is also recorded when an external archive had no plugin metadata: this allows the companion's existing organized-row backfill to retain that conversation beyond the first 500 active rows and after remount. Undo restores the native flag and the previous future snooze when applicable. If the native flag is confirmed but organization restoration fails, the UI reports that partial state explicitly rather than claiming success.

## Stabilization findings

- The previously interrupted frontend run was not a controller deadlock: its keyboard-navigation assertion still expected a Snoozed row immediately after the last old Ready fixture. The newly visible legacy-completion row is now correctly Ready and is the next focus target. Comparing differing jsdom elements directly caused an expensive assertion diff that appeared hung. The test now asserts the focused session ID.
- Browser coverage still clicked a removed `Restore session` hover control and expected native archives to move to Ready during runtime failure. It now exercises `Restore to Ready` through the existing context menu and verifies native archives remain Archived.
- The new 501st-external-archive browser regression failed before the Unarchive organization-restore fix: the unarchived row vanished outside the first active page. The regression now passes, including Unarchive/Undo and an independent frontend remount check.

## Executed gate

From the local repository:

```sh
npm run test:all
```

Verified results for the current source candidate:

| Slice | Result |
| --- | --- |
| `npm test` — frontend/controller plus real companion/native-database integration fixture | 55 passed, 0 failed, 0 cancelled |
| `npm run test:backend` | 56 passed |
| `npm run test:browser` — Chromium, production React entry, labeled synthetic SDK adapter | 65 checks passed; no browser page errors |
| Full command | Exit 0; 31.13 seconds |

The five frontend/harness source files listed below had identical SHA-256 hashes before and after that combined gate. Logs and the machine-readable hash report are scratch artifacts, not production state:

- `/home/hermes/.hermes/cache/scratch/archive-final-gate.log`
- `/home/hermes/.hermes/cache/scratch/archive-final-gate.json`

## Coverage retained and added

- Native archives created elsewhere, rich project/provider/token cards, and legacy-completion Ready/pin/Working classification without automatic writes.
- Exact routed RPC method, durable root, explicit true/false flags, backend target-profile aliases, and persisted before/after readback.
- Rejection of wrong profile, wrong ID, missing flag, missing stored ID, unsupported reader, and dropped writes; source switch and ABA epoch changes across RPC; stale archive-read generations.
- Single-writer/read-generation behavior, independent active/archive pagination, scoped invalidation of active/expanded/archive queries, and eviction/re-read of cached active pages at offsets 500 and 1000 without deleting another source's cache.
- Unarchive/Undo, pin and future-snooze preservation, partial metadata-restore failure, and old external Unarchive retention after remount.
- Runtime-unknown native archives remain Archived; new Archive is disabled unless idle is confirmed. Waiting attention takes precedence and stays Ready. Snooze is disabled for native archived rows until Unarchive.
- Search, project filtering/grouping, stored-identity selection, route fencing, archive-and-advance, existing Home/folder-plus limitations, and no prompt submission.
- Hover-only clock plus archive icon/label; no focus-only reveal; controls overlay top metadata without moving the title; two-line 56px cards; project-icon → pin → project-name order.
- Headerless Ready/Pinned, conditional Pinned above Ready, fixed secondary headers and separate wheel/keyboard scroll bodies in dense 400px/650px fixtures. All secondary headers and positive constrained bodies fit at 300px/350px/400px, also with Undo and with Undo plus an error banner.

## Visual artifacts

Scratch directory: `/home/hermes/.hermes/cache/scratch/t3-sidebar-ui-verification/`

- `frontend.png`, `hovered.png`, `actions.png`
- `dense-400.png`, `dense-650.png`
- `short-300-undo-error.png`

The hovered, dense-400, and short-300-with-notices screenshots were visually inspected in addition to geometry checks. Hover controls leave the title readable; normal dense cards retain both lines. In the extreme 300px pane with both notices, category bodies deliberately shrink to partial-card scroll viewports while all secondary headings remain visible.

## Candidate hashes

```text
2fc625de074e8d0b8e144789400bf8243145b41d7d4c974be743ce417e56fc66  desktop/plugin.js
27e2032062d6032fe6a2e955309a60033af4fc57c6ba93ad8b82d465c44c050d  tests/frontend.test.mjs
8eaa791ba4f101d8f57d34597bdb6abe20cc9a7bb208e1f0afd3253960ff4c50  tests/sdk.mock.mjs
3a3c94fd78a3286fa88af749fa14dc6098ed8c8066bf195df500269a9b9ac668  tests/browser-smoke.mjs
fbc697ac63e78afde5d132b74672518b81f1736baf8b27ea7ee658304d307579  harness/app.mjs
```

## Boundaries

This is a verified **local** implementation, not deployment or live Electron validation. Browser data is synthetic; the separate integration/backend fixtures use scratch databases. No live native database was written, no dependency/configuration/service/credential changes were made, and nothing was committed, pushed, published, or deployed. Existing public project-Home and folder-plus limitations remain unchanged.
