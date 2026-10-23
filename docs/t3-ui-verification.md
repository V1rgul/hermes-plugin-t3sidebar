# T3 sidebar UI verification

## Result and scope

Integrated selected pieces of the interrupted scratch UI into the current dirty checkout rather than replacing the current frontend. Preserved the current controller's source/profile/activation fences, organization readback, rich pagination, waiting precedence, hover-only Snooze popup, labeled Settle/Restore, Undo and context/keyboard routes.

This work changed only:

- `desktop/plugin.js`
- `tests/frontend.test.mjs`
- `tests/sdk.mock.mjs`
- `tests/browser-smoke.mjs`
- `harness/app.mjs`
- `docs/t3-ui-verification.md` (this report)

Other existing or concurrent backend, integration-test and artifact changes are not part of this frontend write scope. No dependencies, configuration, installed plugins, native/core code, credentials or live histories were changed. No commit, push, deployment, service restart or publication was performed.

## Implemented acceptance

- Fixed 56 px, two-line cards: native project icon, outline pin immediately after it when pinned, project name on the upper left; local provider SVG, total input/output tokens and update age/Working on the upper right; single-line ellipsized session title below.
- Unknown project/provider/token data stays neutral. The model name is not used to guess a provider. Native icon strings are accepted. Token display uses `total_tokens`, or input plus output only when both are known; zero stays zero.
- Pinned is omitted when empty and precedes Ready when populated. Neither Pinned nor Ready has a visible heading or toggle. Ready retains the `Active` accessible section label for compatibility.
- Working, Snoozed and Settled have fixed 24 px nonshrinking headers, outside their independently scrolling bodies. Bodies have `min-height:0`. The list container does not scroll. Priority sections are bounded before Ready takes the remainder. At 400 px without banners, the dense case leaves one complete two-line card visible in every category. Smaller available list heights deliberately shrink bodies below one card instead of clipping headers or entire shelves.
- One 40 px toolbar: Search on the left, decreasing-lines filter, folder-plus, square-pen on the right. Local filtering/grouping and refresh live in the filter popup. No plugin heading, settings button, compact/detail toggle, persistent scope line or workspace/footer message remains in the pane.
- The clock/Snooze and labeled checkmark/Settle controls use `display:none` outside pointer hover, including focus-only states. They replace the upper-right metadata, never the lower title. Restore semantics are unchanged. Right-click and Shift+F10 remain available.
- Cron/non-conversational sources are rejected from rich pages, older pages, organized rows, runtime-derived additions, and SDK fallback input. Existing backend filtering is independent of this additional UI boundary.
- Keyboard row navigation focuses with `preventScroll:true` and explicitly scrolls only the destination category body. Settle-and-advance still prioritizes Ready attention over pins even though pins render first.

## Public project picker integration and remaining boundary

The production controller now calls `host.requestProfile(route, 'projects.tree', {preview_limit:0})`, not the partial scratch UI's empty injected adapters. It maps the native `{projects:[{id,label,path,repos,...}]}` tree, offers each distinct project folder, and always inserts synthetic Home:

```js
{id:'__no_project__',name:'Home',path:null,isNoProject:true}
```

Named project selection performs this public, profile-routed handoff:

1. `session.create` with explicit `source:'desktop'`, selected `cwd`, `cwd_explicit:true`, `close_on_disconnect:false`, and a caller-generated stable idempotency key retained across picker retries.
2. `host.openSession(stored_session_id, {route,profile,intent:'in-place',awaitHydration:true,expectHistory:false})`.
3. Recheck activation scope plus the focused stored ID and exact connection/profile owner. If the user navigated elsewhere, cancel with an explicit error and send no final workspace setter.
4. `session.cwd.set` with the returned runtime `session_id` and selected `cwd`; require the returned `cwd` to confirm the selected path. The native method emits `session.info` for composer workspace hydration.

No prompt, seed message, global grouping change, private import, DOM manipulation or arbitrary Home filesystem fallback is used. The original untargeted native new-chat fallback remains only for existing settle-and-advance behavior.

**Home creation remains unavailable.** Its picker entry and explanatory text are visible, but choosing it raises an explicit unavailable explanation and does not create a session. Native `startFreshSessionDraft({workspaceTarget:null})` supplies detached first-send semantics but is not exported by the plugin SDK; public `host.newChat` lacks a path/detached target and may retain the current project. Empty `session.cwd.set` is rejected with code 4016. The UI does not substitute `$HOME`, `/home/hermes`, `/`, or the current project. Folder-plus similarly reports the unavailable public project-management action rather than remaining inert.

Native contracts inspected read-only in `/home/hermes/.hermes/hermes-agent/`:

- `tui_gateway/project_tree.py`: native tree shape, Home omission when empty and `__no_project__` identity.
- `tui_gateway/contracts/sessions.py`: explicit creation fields and stored/runtime identities.
- `tui_gateway/methods_session.py`: `session.cwd.set` confirms cwd and emits `session.info`.
- `apps/desktop/src/sdk/index.ts`: public hydration/open options and focused owner state.

The tests below verify the production controller against labeled SDK doubles and metadata against the real temporary FastAPI/SQLite integration test. They do **not** establish native Electron composer hydration or a first real prompt in the user's remote Desktop build. That client-side handoff remains an integration check; Home requires a supported native SDK capability rather than a hidden workaround.

## Actual verification

- `npm test`: **43 tests passed, 0 failed** (frontend tests plus the real temporary FastAPI/SQLite controller integration).
- `npm run test:browser`: **55 checks passed**, no browser page errors, including the short-pane correction below.
- `git diff --check -- desktop/plugin.js tests/frontend.test.mjs tests/sdk.mock.mjs tests/browser-smoke.mjs harness/app.mjs`: passed after removing one trailing space in a test assertion.

Browser assertions preserve actual pointer hover/unhover visibility, focus-only invisibility, Snooze choices and organization readback, reversible Settle, context menu, Undo, filtering/grouping, unknown runtime and read-only backend behavior. Additional project checks cover Home refusal without creation, named-project payload/open/cwd sequencing, and explicit folder-plus unavailability. Unit tests also cover scope/selection cancellation and stable create retry keys.

Dense geometry fixtures are labeled SYNTHETIC: **100 Ready + 20 Pinned + 20 Working + 20 Snoozed + 20 Settled**. No live session history is used. Sidebar width was 294 px (295 px harness wrapper including its border). Both tested heights keep all secondary headers visible and all five bodies overflow-constrained:

| Sidebar height | Toolbar | Pinned body | Ready body | Working body | Snoozed body | Settled body | List scrollHeight/clientHeight |
|---|---|---|---|---|---|---|---|
| 400 px | 40 px | 60 px | 56 px | 56 px | 56 px | 56 px | 360 / 360 px |
| 650 px | 40 px | 134.1875 px | 69.25 px | 110.1875 px | 110.1875 px | 110.1875 px | 610 / 610 px |

At each height, real wheel movement was applied separately to all five bodies; only the owning body's `scrollTop` changed while every other body position and scroll offset stayed fixed. Arrow navigation scrolled Ready alone, and cross-category End scrolled Settled without changing Ready or any other shelf. Card height, ellipsis, metadata/title line ordering, unchanged title geometry under hover, top-row hover controls and toolbar alignment were also asserted.

The initial dense run exposed fixture runtime-failure state carried over from an earlier test; the fixture reset now explicitly clears it. Visual inspection of the first 400 px screenshot also caught partly clipped first cards; reducing fixed toolbar/header heights and reserving a full row per populated shelf fixed that, and the browser now requires every dense body to be at least 56 px tall.

Independent review subsequently reproduced a real short-pane defect: the original hard 56/80 px section minimums overflowed the list at 300 px or when an Undo banner consumed height. A new browser regression failed against that candidate. The corrected minimum body height is capped at 56 px but shares the available list height after reserving three 24 px headers and four 1 px gaps. The headerless Ready/Pinned selectors override the header-bearing minimum with equal specificity. All six 300/350/400 px cases, with and without a real Undo banner, now assert every header and scroll body stays inside the list and the list itself has no overflow. The independent scratch reproducer now reports `scrollHeight === clientHeight` throughout; at 350 px with Undo the list is 257 px and each body is approximately 36 px. Cards remain 56 px and scroll inside those smaller bodies. No claim is made that arbitrary stacks of banners fit a physically smaller pane than the headers themselves.

## Screenshots and log

Generated outside the repository, under the task scratch directory:

- `/home/hermes/.hermes/cache/scratch/t3-sidebar-ui-verification/frontend.png`
- `/home/hermes/.hermes/cache/scratch/t3-sidebar-ui-verification/actions.png`
- `/home/hermes/.hermes/cache/scratch/t3-sidebar-ui-verification/dense-400.png`
- `/home/hermes/.hermes/cache/scratch/t3-sidebar-ui-verification/dense-650.png`
- `/home/hermes/.hermes/cache/scratch/t3-sidebar-ui-verification/browser.log`

Inspected the ordinary pane and final dense-400 screenshot visually. These show the actual production React tree in the synthetic Chromium harness, not a deployed Electron instance.

## SHA-256 manifest

Executable/UI/test files at the verified revision:

```text
66c0463d642cf23b6ad905797ead448efb55886eb9b71d1f1e813ffe5067c764  desktop/plugin.js
ff5247e67608286ec83689fec29f3efc7aeb2290e291392659d971b0c9615adf  tests/frontend.test.mjs
4aa9a74e44236d7e6dc66096270ef836e2384445646eb6666817ecb723804bab  tests/sdk.mock.mjs
5091544091f68292e06b79bfec76decc8fb024e99d2f0d70a220d62ea5286eed  tests/browser-smoke.mjs
81614778dc6defc0bc46fc101c619efef34fcb34a79125441a0c45fd87bfb997  harness/app.mjs
```

This report cannot contain its own stable hash. The complete six-file manifest including this report is saved separately as `/home/hermes/.hermes/cache/scratch/t3-sidebar-ui-verification/files.sha256`.
