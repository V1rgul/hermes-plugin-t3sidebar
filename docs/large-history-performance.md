# Large-history interaction performance

## Baseline and scope

This optimization starts at `c5b4b46a4424b16f2f0f9e34f710be62b9ccd4ee`, after shared backend Done state was introduced. The reported problem is folding/unfolding Archived with five hundred loaded sessions. Production Chromium profiling uses the actual sidebar React tree and explicitly synthetic SDK data. It does not measure the user's Windows Electron client, remote IPC or network.

The earlier report in [performance.md](performance.md) measured a Working shelf containing only a subset of the loaded history. That does not establish acceptable performance when a single shelf itself holds five hundred sessions. Measure both directions, repeated toggles and ordinary motion separately from reduced-motion DOM latency.

## Runtime classification

Each history card previously filtered the entire runtime snapshot. An independent deterministic regression measured 500,500 runtime-key reads for one thousand stored cards and five hundred runtime records. This is repeated classification work during refresh, not the archive-toggle event itself.

The replacement indexes both runtime ID and stored-session key once. Per-card joins preserve original snapshot order, repeated entries and compression aliases, while deduplicating the same entry reached through more than one alias. One hundred seeded differential cases compare complete classified rows against the previous implementation, covering Waiting/Working/unknown precedence, running children, native archive membership, snoozes, pinning, completion markers, empty-session evidence and filtering.

A pinned-baseline Node comparison collected twenty-one samples after warmup. These are classifier-only synthetic CPU measurements, not browser interaction latency:

| Stored cards | Runtime records | Baseline median / p95 | Indexed median / p95 | Runtime-key reads before → after |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 50 | 6.35 / 6.95 ms | 1.54 / 2.12 ms | 50,050 → 100 |
| 1,000 | 500 | 39.19 / 43.16 ms | 2.19 / 3.00 ms | 500,500 → 1,000 |
| 1,000 | 1,000 | 76.94 / 80.10 ms | 1.21 / 1.72 ms | 1,001,000 → 2,000 |

The deterministic linear-work bound is the regression gate; wall-clock differences between roster sizes reflect measurement variance/JIT and must not be interpreted as lower intrinsic cost for larger inputs.

## Preserved contracts

Keep profile/source/activation-epoch isolation, exact native mutation readback, independent archive pagination, recovery of older organized/completed roots, successful-open/read acknowledgments, backend-owned Done generations, boolean-only draft handling and focused composer polling. Fold/search changes must not steal input focus or silently expand Snoozed/Archived. Independent shelf scrolling, short-pane headers, menu anchors, keyboard navigation and reduced-motion behavior remain acceptance requirements.

## Viewport-bounded sections

Rendering every retained card made folds expensive even though the browser showed only a handful of rows. Sections with more than eighty cards now mount their viewport plus three rows of overscan in each direction. Small sections keep their full DOM. Logical counts/order and independent scrolling are unchanged; keyboard navigation reveals an unmounted destination before focusing it. Open-menu owners and focused cards remain mounted outside the ordinary window.

The production Chromium fixture contains five hundred Ready and five hundred Archived cards. Each operation/direction has six samples per motion mode. Values below are arithmetic medians / nearest-rank p95 of event-to-two-frame latency; they are not the full duration of the intentionally retained CSS transition:

| Interaction | Baseline reduced motion | Bounded reduced motion | Baseline ordinary motion | Bounded ordinary motion |
| --- | ---: | ---: | ---: | ---: |
| Close Archived | 71.55 / 85.40 ms | 21.30 / 21.50 ms | 68.40 / 83.80 ms | 21.70 / 21.80 ms |
| Reopen Archived | 82.15 / 100.60 ms | 21.30 / 21.60 ms | 73.65 / 78.70 ms | 21.50 / 21.70 ms |
| Clear search | 296.35 / 348.60 ms | 21.50 / 21.70 ms | 274.40 / 289.50 ms | 21.75 / 21.80 ms |
| Clear project filter | 226.65 / 249.10 ms | 21.55 / 21.80 ms | 212.45 / 240.10 ms | 21.75 / 21.90 ms |

Reopening Archives previously rendered all five hundred archived cards and read five hundred or more drafts. The candidate rendered at most thirteen cards with reduced motion or twenty-two with ordinary motion, with at most fourteen draft reads. Steady mounted cards fell from one thousand to about twenty. Search-clear worst frame gap fell from 316.6 ms to 16.8 ms; candidate measurements contained no interaction long tasks or browser errors. Focus/runtime-event samples stayed near the two-frame floor instead of introducing a new regression.

Checked browser behavior includes Home/End across section boundaries to initially unmounted cards, open-menu anchor retention while scrolling, matching search preserving menu ownership, and loading/searching/unarchiving the five-hundred-and-first archive. Focused draft polling, boolean-only draft caches and fresh reads on mount remain unchanged. Two deterministic React regressions bound mounted/rendered cards and draft reads and exercise navigation/menu continuity; the mounted-card regression fails against the pinned baseline.

## Organized-history backfill

Metadata referencing five hundred native archived sessions caused five hundred individual rich native searches during an ordinary recent-session poll. When at least thirty-two organized IDs remain uncovered behind a full recent page, the API now inspects one additional native page of at most five hundred rows. It preserves native filtering/lineage semantics, original pagination metadata and organized-ID insertion order. A short lookahead proves exhaustion of that same filtered listing; a full lookahead retains exact-ID substring paging for remaining older IDs. There is no persistent cache, native write or unbounded scan.

An isolated native database contained five hundred regular and five hundred archived conversations, one hundred compression tips and one thousand delegation rows:

| Read | Baseline median | Candidate median | Native SQL statements before → after |
| --- | ---: | ---: | ---: |
| Recent sessions with 500 retained archived IDs | 1,420.755 ms | 43.893 ms | 1,110 → 112 |
| Ordinary 500-card listing | 37.693 ms | 37.682 ms | 110 → 110 |
| 500 already-loaded organized IDs | 38.534 ms | 38.455 ms | 110 → 110 |
| Native Archived listing | 38.531 ms | 38.073 ms | 110 → 110 |
| 500 organization + 500 completion markers | 1.500 ms | 1.500 ms | 4 → 4 |

Six baseline/candidate differential scenarios returned identical complete outputs including order and paging, and measured native database bytes remained unchanged. Three new backend regressions cover the avoided query storm, native archive-root/internal-source precedence and full-lookahead exact-ID fallback. Completion hook/state changes were not justified by measurement and are not part of this optimization. Remaining older IDs beyond a full lookahead still pay the existing per-ID fallback cost.

## Verification artifacts

Raw local evidence is retained under the Hermes scratch directory as `t3-archive-baseline.json`, `t3-archive-final.json`, `t3-classification-before-after.json`, `t3sidebar-backend-perf-{baseline,after}/` and `t3sidebar-backend-differential.json`. Reproduction runners are `t3-archive-profile.mjs`, `t3-classification-comparison.mjs` and `t3sidebar-backend-perf.py`. These are synthetic benchmark artifacts, not production session data.

The integrated gate passes 159 frontend/integration tests, 137 backend tests and 172 Chromium behavior checks. Real Windows/Electron rendering and remote network latency are not measured by this Linux harness.
