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

Open `http://127.0.0.1:4173`. The right-hand panel is a labeled test workspace, not an alternative chat implementation. The harness renders Codicons with Desktop's pinned `@vscode/codicons` font (unit tests keep the SVG test adapter), and gives each synthetic project its own native icon and palette color. Browser tests write screenshots to `t3-sidebar-ui-verification/` under `TMPDIR` (or the Hermes scratch directory when unset). The README's maintained screenshots live in `docs/images/`.

README screenshots are captures of the real Webapp in a worktree's test container (see below): Midnight dark, en-GB locale, 2x (the Working shelf at 3x), with the container's invented sessions and its Usage and Limits seeds, and the settings page in Desktop's Settings dialog with default preferences. Draft, Done and Snoozed come from real turns and actions. States the container cannot produce on demand are staged for the capture only, through test-only edits of the container's plugin copy that `sync` removes: runtime fields by session title (the Input card, the running turn and the four detailed Working states), the Working shelf's past run times, and AutoTitler's availability, since AutoTitler cannot load in the image.

## Testing a change

Test changes in the real Hermes Webapp running in a container. It runs the actual Desktop renderer, gateway, plugin loader and dashboard routes, so it covers SDK and route contracts, plugin enablement, backend hooks and live turns. The web-only harness above is optional, only for quick visual checks such as icons. The container holds only invented data and a dedicated test account, never a real Hermes home, its credentials or its history, and it does not touch the host's Hermes services.

`tools/test-webapp/t3webapp.sh` drives that container with Podman when installed, otherwise Docker (`T3WEBAPP_RUNTIME` overrides the choice):

```sh
tools/test-webapp/t3webapp.sh setup   # creates the container, or reuses an existing one with its data, then installs and enables the plugin
tools/test-webapp/t3webapp.sh seed    # invented projects, 78 antedated sessions for Usage, 10 days of pooled Limits samples
tools/test-webapp/t3webapp.sh sync    # after each change: copies the plugin's files that Git tracks or does not ignore, uncommitted edits included, and restarts the container
tools/test-webapp/t3webapp.sh browser # starts the checkout's test browser if needed and signs it in
tools/test-webapp/t3webapp.sh drive 'return await shot("now")'  # one step in that browser (Playwright: page, context, shot)
tools/test-webapp/t3webapp.sh browser-reset  # only on request: stops the test browser and erases its profile
tools/test-webapp/t3webapp.sh stop    # stops the test browser and the container, keeping the profile and the data; start resumes the container
tools/test-webapp/t3webapp.sh destroy # linked worktree only: removes its test browser and profile, container and data, before git worktree remove
tools/test-webapp/t3webapp.sh prune   # removes the containers of worktrees that no longer exist; setup also does it
```

From the main checkout the script drives the shared container. From a linked worktree it drives that worktree's own container (`t3demo-<worktree>`, data in `~/t3sidebar-demo-worktrees/<worktree>`, first free port from 19121), so worktrees tested in parallel do not overwrite each other's plugin. Its first `setup` clones the shared container's data, pausing it during the copy, so it starts seeded and signed into the test account. Git has no hook on worktree removal: run `destroy` before `git worktree remove`, otherwise the next `setup` or `prune` from any checkout removes the leftover container. The shared container and its data directory are never destroyed by the script, whatever `T3WEBAPP_NAME` says.

Each checkout also has its own test browser: Playwright's Chromium, headless, with its profile in `.t3webapp/browser-profile` inside the checkout (ignored by Git) and its own CDP port, the Webapp's plus 1000 (`T3WEBAPP_CDP_PORT` overrides it). Its sign-in and site storage last across browser and container restarts until `browser-reset`, which never runs on its own, and it has no inactivity timeout. `drive` runs one async function body in its page over that port and prints what it returns; `shot(name)` saves a screenshot under `.t3webapp/shots` and returns its path. Worktrees drive their own browsers side by side. `stop` closes the browser through CDP so Chromium writes its storage to the profile first. An agent's own browser tool can open the same Webapp instead, but its profile may be thrown away between calls.

The Webapp listens on loopback only (`http://127.0.0.1:19120` by default), without a login: Hermes serves a non-loopback bind only behind one, so inside the container it listens on loopback and a small forwarder exposes it on the published port. Like any loopback Webapp, it signs a browser in through a one-use link, valid 60 seconds: `tools/test-webapp/t3webapp.sh login-url` prints it for any browser, and `browser` uses one to sign its test browser in. A container made while the script still generated a password is recreated on its data by the next `setup`. The container name, data directory, port and Hermes image are overridable through `T3WEBAPP_NAME`, `T3WEBAPP_DIR`, `T3WEBAPP_PORT` and `T3WEBAPP_IMAGE`; a second container on another port lets a test start from a clean state without losing the main one. Hermes keeps a plugin's Desktop half opt-in, and each browser keeps that choice in its own storage, so a new browser profile would start with the T3 Sidebar off: the script installs a container-only Desktop plugin, `t3webapp-enable-sidebar` ([`enable-sidebar.js`](../tools/test-webapp/enable-sidebar.js)), which turns it on in a browser that has not chosen yet and reloads once. Switching it off in Settings → Plugins is kept. Live turns need the container signed into a dedicated test account with a free model; `setup` prints the commands, and personal accounts must never be used there. `seed_limits.py follow`, started by `seed` and `start`, keeps the Limits readings fresh while the container runs. A repeated `seed` replaces only the Usage sessions it recorded in `/opt/data/demo/seed_usage_ids.json`. When other sessions hold the titles it writes, such as those seeded before it kept that record, it lists them and leaves every session unchanged until they are deleted.

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
- **Work counts are the primary gate**, because they do not depend on the machine. Card renders and mounts may not exceed the baseline's or the budget. Component renders get 25% slack against the baseline. The ordinary-motion suite reports its counts without gating them: renders during a transition depend on frame timing, and the reduced-motion suite gates the same folds.
- **Latency** fails when the candidate's median is more than 25% *and* more than 3 ms slower than the baseline's. It also fails when the median exceeds a generous absolute budget, about three times the recorded median.

After an intentional change of cost, run `npm run perf -- --update-budgets` and commit the new budget file along with the reason. Raw JSON goes to `t3sidebar-perf/` under `TMPDIR`. Add `--cpu 4` to approximate a slower laptop, and `--only sidebar,usage` to select suites; with `--only`, `--update-budgets` replaces only the selected suites' budgets. An unknown suite, a missing or unreadable budget file, or a measured operation without a budget fails the run. When run against identical code, medians vary by about ±25% and up to ±40% on operations under 10 ms, which the 3 ms floor absorbs. An injected card-memo break and a 15 ms input handler both fail the gate. These are synthetic Linux Chromium measurements; they do not measure the Windows Electron client, IPC or network.

`tests/perf/backend_bench.py` builds a scratch native store with 2,200 sessions, including 500 archived, compression chains and 1,000 delegated children. It also builds about 1,000 organized metadata IDs and a six-account limits store holding ten days of samples. It times the plugin's metadata read, its recent and archived native listings, cold and cached usage history for 1, 7 and 30 days, and the 168 h and 840 h limits payloads. SQLite statement counts are strict upper bounds in [`tests/perf/backend-budgets.json`](../tests/perf/backend-budgets.json). Timing budgets are four times the median. With `--baseline <ref>`, the baseline modules run interleaved on the same fixtures. That run fails on any increase in statement count, or when the median is more than 25% *and* more than 2 ms slower. The run fails if the scratch native database changes. It also fails when the candidate's output differs from the baseline's, naming the first differing field (`--allow-output-change` accepts an intended contract change), when the candidate skips a selected scenario, or when an `--only` substring matches no scenario; scenarios an older baseline cannot run are listed as skipped. When run against identical code, medians vary by about ±5%. Against the revision before the bounded archive lookahead, the benchmark reproduces the documented query storm: 1,108 statements and 2.3 s, against 115 statements and about 70 ms now.

Strict comparison against a baseline also flags work that a feature adds on purpose. Review it, then compare with `--baseline none` against freshly recorded budgets.

The production plugin itself needs none of these Node development dependencies or generated bundles.

SDK reference: https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk

Current rename verification is in [`docs/rename-verification.md`](rename-verification.md). Earlier review/remediation/verification reports under `docs/` are historical evidence for the original Session Flow candidates; their names, outputs and hashes do not validate the renamed bytes.
