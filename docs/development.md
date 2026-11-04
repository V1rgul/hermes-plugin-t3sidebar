# Development

[Back to the README](../README.md) · [Architecture](architecture.md)

Frontend tests use Node’s test runner and render the actual React tree. Backend tests use Python’s `unittest` and a real FastAPI test client. The HTTP integration test connects the frontend controller to the real Python API and SQLite store. Browser tests render the real plugin in Chromium with explicitly synthetic SDK/session fixtures; they do **not** establish live Electron compatibility.

```sh
npm ci --ignore-scripts --no-audit --no-fund && npm run test:all
```

Python test dependencies are listed in `requirements-dev.txt`; Hermes already provides the production FastAPI/Pydantic environment. The backend test entry point initializes Hermes's committed dependency environment before discovery and scratch-profile overrides. Set `HERMES_DISABLE_LAZY_INSTALLS=1` for verification without automatic dependency installation. The browser smoke uses an installed Chromium from the Playwright cache or `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. If neither exists, install the matching development browser with `npx playwright install chromium`; the tests never silently download one.

To inspect the rendered sidebar with synthetic data:

```sh
npm run harness
```

Open `http://127.0.0.1:4173`. The right-hand panel is a labeled test workspace, not an alternative chat implementation. Browser tests write screenshots to `t3-sidebar-ui-verification/` under `TMPDIR` (or the Hermes scratch directory when unset). The README's maintained screenshots live in `docs/images/`.

README screenshots render the current plugin with sample sessions and a development SDK adapter, using the Midnight dark palette and native Codicon font. Usage captures use the maintainer's real usage history (per-model totals for each period, read from a Hermes `state.db` on Mon 2026-11-02 23:48 Paris, no session content), kept outside the repository and served through `control.usageHistory`; tests use the synthetic `syntheticUsageHistory`. Limits captures use the synthetic `syntheticUsageLimits` fixture. The clock is fixed on Wed 2026-11-04 15:00 Paris. They are not captures of a live Desktop connection.

## Performance regression benchmarks

Run these before merging a feature, so it cannot silently undo the optimizations recorded in [`performance.md`](performance.md) and [`large-history-performance.md`](large-history-performance.md). The deterministic work-bound tests in `npm test` and `npm run test:backend` already catch specific regressions. The benchmarks also measure interactions end to end.

```sh
npm run perf                      # Chromium: sidebar, Usage and Limits pages
npm run perf:backend              # Python: native listings, metadata, usage history and limits
npm run perf:all                  # both
npm run perf -- --baseline main   # explicit baseline ref; `none` skips the comparison (same flag and default for perf:backend)
```

`tests/perf/browser-bench.mjs` builds the real plugin tree with **production** React twice: once from the working tree and once from the baseline ref, extracted with `git archive` outside the checkout. It then drives identical synthetic fixtures in headless Chromium. The sidebar fixture holds 500 Ready, 500 Archived and 20 each of Pinned, Working and Snoozed cards across two projects. Search, folds, project filter, focus, poll refresh, shelf scrolling, Usage period/mode/split/hover and the Limits hover/lookback each run in both variants. Rounds are interleaved and their order alternates, so machine load affects both variants alike. The default baseline is the merge base with `main` on a feature branch, `HEAD` for uncommitted work on `main`, and none on a clean `main`.

Each operation records:
- Latency from dispatching the event until the expected DOM state is reached and layout is complete.
- Its p95 frame gap. The ordinary-motion suite observes the whole fold transition.
- Long tasks.
- Three work counts taken from a React DevTools commit hook and a MutationObserver: card (`SessionRow`) renders, mounted cards and total component renders.

Gates, in [`tests/perf/browser-budgets.json`](../tests/perf/browser-budgets.json):
- **Work counts are the primary gate**, because they do not depend on the machine. Card renders and mounts may not exceed the baseline's or the budget. Component renders get 25% slack against the baseline.
- **Latency** fails when the candidate's median is more than 25% *and* more than 3 ms slower than the baseline's. It also fails when the median exceeds a generous absolute budget, about three times the recorded median.

After an intentional change of cost, run `npm run perf -- --update-budgets` and commit the new budget file along with the reason. Raw JSON goes to `t3sidebar-perf/` under `TMPDIR`. Add `--cpu 4` to approximate a slower laptop, and `--only sidebar,usage` to select suites. When run against identical code, medians vary by about ±25% and up to ±40% on operations under 10 ms, which the 3 ms floor absorbs. An injected card-memo break and a 15 ms input handler both fail the gate. These are synthetic Linux Chromium measurements; they do not measure the Windows Electron client, IPC or network.

`tests/perf/backend_bench.py` builds a scratch native store with 2,200 sessions, including 500 archived, compression chains and 1,000 delegated children. It also builds about 1,000 organized metadata IDs and a six-account limits store holding ten days of samples. It times the plugin's metadata read, its recent and archived native listings, cold and cached usage history for 1, 7 and 30 days, and the 168 h and 840 h limits payloads. SQLite statement counts are strict upper bounds in [`tests/perf/backend-budgets.json`](../tests/perf/backend-budgets.json). Timing budgets are four times the median. With `--baseline <ref>`, the baseline modules run interleaved on the same fixtures. That run fails on any increase in statement count, or when the median is more than 25% *and* more than 2 ms slower. The run fails if the scratch native database changes. When run against identical code, medians vary by about ±5%. Against the revision before the bounded archive lookahead, the benchmark reproduces the documented query storm: 1,108 statements and 2.3 s, against 115 statements and about 70 ms now.

Strict comparison against a baseline also flags work that a feature adds on purpose. Review it, then compare with `--baseline none` against freshly recorded budgets.

The production plugin itself needs none of these Node development dependencies or generated bundles.

SDK reference: https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk

Current rename verification is in [`docs/rename-verification.md`](rename-verification.md). Earlier review/remediation/verification reports under `docs/` are historical evidence for the original Session Flow candidates; their names, outputs and hashes do not validate the renamed bytes.
