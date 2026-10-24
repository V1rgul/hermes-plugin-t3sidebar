# Sidebar interaction performance

## Measurement boundaries

The starting revision is `54fd7eed431308f961f001f471a0281686a631c1`. Browser measurements render the real plugin React tree with production React and synthetic SDK/session data in Chromium, with reduced motion enabled. They measure event-to-observed-DOM latency, not Windows Electron, IPC or network latency. Controlled controller tests delay only an unrelated refresh; native operations and readbacks use explicit synthetic fixtures. Backend probes use read-only native storage or isolated scratch stores, never live mutations.

## Confirmed bottlenecks

- History merge rescanned all previous lineage aliases for each incoming card. At 500 unique rows, a deterministic regression counted 125,250 lineage-array visits. A seven-sample Node merge-plus-classification benchmark with 50 runtime rows measured median 42.50 ms at 500 cards and 168.15 ms at 1,000 cards.
- Action promises awaited full-list invalidation after their operation and exact readback had already finished. A real-controller/React Query fixture with a 250 ms refresh measured Pin 252.0 ms, Archive 251.7 ms and Open 251.6 ms.
- Local toolbar, fold and filter state rebuilt and rendered every loaded card. Production Chromium at 1,000 cards measured median/p95 334.7/400.2 ms for search retaining all matches, 349.1/413.9 ms for Working fold/unfold, 338.5/374.3 ms for the toolbar filter, and 338.0/375.6 ms for session focus. Twenty samples were collected per interaction. Row-local context menus were already much cheaper, at 5.8/11.8 ms.
- Each card render constructed `Intl.NumberFormat` twice; measured formatting accounted for about 50 ms per 1,000-card full render. Broad session/subagent events also invalidated archives, metadata and older pages alongside runtime status. Streamed `message.delta` was already excluded and must remain so.
- Native organized-session backfill checked root keys rather than all covered aliases and repeated rich listing for each missing key. Scratch 10,000-session probes measured 109 ms with no backfill, 676 ms with ten old organized IDs and 3,044 ms with fifty. Metadata GETs took an immediate writer transaction even with no due snooze. Standalone subagent projection performed native DB reads under the process-wide session lock and synchronously on the async request path.

## Implemented and verified

The indexed merge retains direct-key priority, first matching lineage, archive/rich precedence and insertion order. Differential tests compare 120 deterministic randomized cases against the frozen original implementation. The 500-card regression now visits lineages linearly. In the same Node benchmark, merge-plus-classification fell to 3.83 ms at 500 cards and 7.40 ms at 1,000.

Action completion still waits for its exact native readback, but full-list reconciliation is background work. Verified archive/unarchive, rename and deletion update only existing scope-qualified rich cache rows; they do not fabricate history from runtime records. Concurrent profile-route discovery shares only in-flight work, not settled authority. Replaying the controller fixture independently measured Pin 1.5 ms, Archive 1.5 ms and Open 0.5 ms while the 250 ms refresh still completed separately.

Memoized data derivation, stable row callbacks and card comparisons keep unrelated toolbar changes out of the card tree. Token counts reuse one formatter and one formatted value per card. Search/filtering is separate from classification, while successful polling still refreshes ages and snooze deadlines even when React Query structurally shares unchanged data. Runtime/input/subagent lifecycle events invalidate runtime only; history changes also refresh stored lists and organization. Same-turn bursts coalesce, ongoing requests are not cancelled/restarted, and draft/project queries remain independent.

### Production Chromium, 1,000 synthetic cards

Each cell is median / p95 event-to-observed-DOM latency in milliseconds, from twenty samples. These are not network or Windows/Electron measurements.

| Interaction | Baseline | Optimized |
| --- | ---: | ---: |
| Search retaining all matches | 334.65 / 400.2 | 4.10 / 6.0 |
| Working fold/unfold | 349.10 / 413.9 | 10.80 / 13.3 |
| Toolbar filter open/close | 338.45 / 374.3 | 0.70 / 0.9 |
| Open/focus | 337.95 / 375.6 | 7.05 / 9.6 |
| Narrow search and clear | 403.35 / 619.0 | 187.50 / 381.3 |
| Project filter and clear | 426.60 / 568.0 | 146.30 / 281.1 |

Toolbar changes render no cards; focus typically renders two. Working folding renders its hundred affected cards instead of the full thousand. Clearing a narrow filter still remounts removed cards and rereads their drafts; this residual cost is not hidden by stale draft caching or private native-store access.

### Backend contention and redundant reads

Established, current-schema metadata with no due snooze now uses a read-only transaction. Due/migrating stores enter the existing writer path and recheck under its lock. Native session listing tracks every covered root/tip/lineage alias before organized backfill. Standalone runtime projection is offloaded with context-variable propagation, and its native lineage reads occur outside the global registry lock, with exact identity/profile/DB revalidation before publication.

| Controlled scratch measurement | Baseline | Optimized |
| --- | ---: | ---: |
| Metadata GET while a writer holds 250 ms | 329.488 ms | 0.285 ms |
| Maximum global-lock hold during native token wait | 247.986 ms | 0.179 ms |
| Maximum asyncio heartbeat gap | 251.845 ms | 10.237 ms |
| 500 compressed conversations plus 10 already-loaded aliases | 230.650 ms; 11 rich listings | 109.511 ms; 1 rich listing |

The runtime request itself still waits for a blocked native token read; the optimization frees the event loop and registry lock during that wait. Truly missing organized IDs retain the existing exact-match, paged per-ID recovery because the inspected native rich API offers no safe exact-ID batch filter. Authority-backed async ancillary projection is unchanged; no unsupported cross-loop/private adaptation was introduced.

## Verification

The integrated `npm run test:all` gate passed 144 frontend/integration tests, 94 backend tests and 137 Chromium checks. Added deterministic tests cover linear lineage visits, differential merge parity, verified completion before gated background refresh, scoped route coalescing, card render isolation/freshness, event-domain/burst behavior, read-only metadata under contention, alias-covered backfill, runtime replacement during blocked projection and profile context propagation.

## Frontend follow-up

The follow-up starts at `f37acfb335b27d66e6dd544928f1874ae5c2303f`. These changes eliminate deterministic work and duplicate reads; they do not establish new browser, Windows/Electron or network latency measurements:

- Unchanged polls without snoozes no longer rebuild/sort classification, while ages keep advancing; adding a snooze restores deadline-driven classification.
- Query tokens normalize once, and each searchable row's lowercase text is prepared on demand and reused across keystrokes until the classified snapshot changes. Whitespace, AND-token semantics, lineage search, changed titles and project visibility remain unchanged.
- Toolbar/dialog state reuses the logical visible-row list; membership/order changes still drive owned-focus recovery across virtualized sections.
- Project-picker grouping, sorting, display paths and search fields are prepared per catalog/home snapshot rather than per keystroke. Multi-folder identity, exact raw selection paths and context-menu ownership are preserved.
- Verified non-native metadata actions keep the independent readback but omit their immediate duplicate state-query invalidation. Active and mutation-disabled/re-enabled observers consume the published snapshot; failures, ambiguous writes, native operations, later events and ordinary polling retain recovery.
- Identical cached archive-tail references bypass order serialization; head changes, changed tails, shifted offsets and bounded recovery still reconcile normally.
- A workspace move discovers its route once and reuses it for project validation, without retaining authority across operations.

Regressions in `tests/frontend-derivation.test.mjs`, `tests/project-picker.test.mjs`, `tests/controller-optimization.test.mjs`, `tests/pagination-cache.test.mjs` and `tests/session-card-fixes.test.mjs` exercise the real React/controller code with synthetic SDK data. The new render-work tests were observed failing on the starting implementation before the production changes. Existing age/snooze-menu, empty-draft, classification-parity, menu/focus and viewport-bound tests remain applicable.

The follow-up's complete `npm run test:all` gate passed 274 frontend/integration tests, 185 backend tests and 291 Chromium checks; syntax checks and `git diff --check` also passed. Browser data remains explicitly synthetic, not live Electron or a deployed backend. No dependency, backend/core, installation or service changes are part of this follow-up.

## Preserved contracts

Optimizations must retain profile/source/activation-epoch fences, native archive/delete/title verification, exact deletion retry identity, rich older-history recovery, native archive membership, Waiting precedence, running-subagent ownership, atomic snooze wake materialization and exact wake acknowledgments. Composer text remains read-only and immediately reduced to boolean presence; draft text must not enter plugin caches, logs, storage or backend requests. Polling remains a recovery mechanism rather than relying on event replay.
