# hermes-t3sidebar

A T3 Code-inspired replacement session sidebar for Hermes Desktop. It opens existing conversations in Hermes’s normal workspace; it does not replace the chat interface or alter agent instructions.

## Workflow

- **Ready:** headerless conversations ready for your attention. Pending approvals and questions remain visible here rather than disappearing into a background shelf.
- **Working:** unpinned running jobs separated from attention items and visually subdued, with blue Working text. Running subagents also give an idle parent Working status; waiting for user input still takes priority.
- **Snoozed:** conversations put aside until a chosen time, with four presets and a custom date/time. Tomorrow and Next Monday share the **Snooze preset time** in the plugin settings, defaulting to 09:00 in the Desktop client's local time. The preference persists locally and applies to new snoozes only; on Monday, Next Monday means the following Monday. Calendar arithmetic preserves the configured local time across daylight-saving changes.
- **Archived:** Hermes’s real archived sessions, including conversations archived outside this plugin. Archive and Unarchive use native session archival; history is retained. The shelf is ordered by last activity, not an invented archival timestamp.
- Headerless Pinned cards above Ready, two-line session cards, search, project filtering and hover-only Snooze/Archive actions. Pinned sessions stay here while working, retaining blue Working status without dimming; Snoozed still wins over Pinned, while native archives and input/unknown-status safeguards keep their existing precedence. Pinned fits its cards without reserving blank space; large pinned lists remain height-capped and scroll independently. Category bodies scroll independently while secondary headers remain visible.
- Working, Snoozed and Archived headings show a parenthesized session count, a divider and a right-aligned chevron. Fold preferences persist locally through Desktop restarts, separately for each source and profile. Searching temporarily reveals matching Working rows, but never automatically unfolds Snoozed or Archived; their matching counts remain available for explicit expansion.
- Project glyphs have transparent backgrounds in both cards and the new-session picker. The picker closes through the normal popover dismissal without a Cancel button. Searches with no loaded matches show “No matching sessions”, never “All caught up”.
- Reverse actions through ordinary controls: Archive/Unarchive, Pin/Unpin and Restore to Ready. No action creates an Undo toast or button; Delete retains its confirmation modal.
- Menu buttons stay highlighted until their popover closes. Snooze also keeps its hover controls visible and its anchor stable when the pointer leaves the card.
- Provider icons appear only when concrete metadata identifies a supported logo. Missing, automatic or unrecognized providers have no placeholder icon or empty spacer; the logo appears when metadata arrives.
- Search retains keyboard focus as filtering removes cards. Row-focus recovery only applies while the card actually owns focus; background list updates do not reclaim focus from search, menus or the composer.
- The pane tab is named **t3sidebar**; the plugin ID and storage namespace remain `hermes-t3sidebar`.
- Cards show green **Done** for a backend-recorded successful completion, or native backend unread when available. Completion markers persist in profile-scoped plugin SQLite even with Desktop closed; clients read the same state and acknowledge its exact generation when a thread is opened/read. No client-local completion tracker or native unread rewrite is used. See [backend completion markers](docs/completion-markers.md).
- Orange **Woke** after snooze expiry and purple **Input** for a question or approval retain priority over Done; Working remains blue and also outranks Done. Status labels have a leading icon and bold title. Project names, glyphs and ordinary ages have stronger contrast while provider/token metadata stays subdued.
- Expanded Archives receives a larger share of list height. Categories animate open/closed without moving their headers into the scroll bodies; reduced-motion preferences disable these transitions.
- Right-click offers Pin/Unpin, Restore when snoozed, Rename, Copy session ID, confirmed Delete, and a final **Project** submenu. Project contains Rename, Copy path, Filter for, the approved 48-color palette (24 hue-aligned bright/dark pairs in golden-ratio portrait swatches) and 64 native Codicons in eight categories. All selectable project glyphs use the chosen project color; action icons keep their ordinary styling. Right-click a project in the filter list (or use Shift+F10) to open the same menu without selecting that filter or changing workspace. Project edits update the native backend catalog and verify exact saved values; auto-discovered folders are adopted as native projects on their first edit, without changing the active workspace. Every action has a decorative leading icon; Delete's icon and text use the native red theme color, including hover/focus and disabled states. Session Rename is available only for a confirmed live runtime and verifies the saved title; stored-only threads explain the limitation. Archive and Snooze stay on their direct hover controls, and archived cards omit Snooze. Lists are always flat; project filtering does not group them.
- Custom snooze uses the date/time field with Enter or its adjacent checkmark; there is no bottom “Snooze until chosen time” button.
- Opening a thread marks it read but does not change its displayed conversation age or recency order. Stored conversation activity, not the runtime's resume/reattach clock, drives those values.
- Token totals have whole-thousand resolution (`12K`, not `12.3K`) and one decimal for millions (`1.2M`). Archived cards never show Done, Woke, pin or snooze indicators/actions. Viewing their history leaves them archived; resumed agent activity restores their native compression lineage through the backend plugin hook. Authoritative running/input state leaves the Archived shelf immediately, even before the persisted flag refreshes.
- **Move to project**, directly above **Project** in the session menu, re-homes a confirmed-idle stored conversation to a selected project folder through the native workspace-move operation. Folder choices include multi-folder projects. The companion verifies the exact persisted workspace before the card changes; moving never opens the session or sends a prompt.
- Working fits its cards through intrinsic CSS sizing rather than calculated JavaScript heights; large Working lists still scroll within the pane's height limit. Session cards keep a 3px gap between their two text lines without changing the 56px card height. Search keeps an explicit clear cross visible whenever the input has text. Rename uses a checkmark beside its field, and Input/Working/Done labels are bold.
- A nonempty composer text draft gives its card a dim orange background only while that session is unfocused. The focused editor retains its ordinary selected background. The public Desktop composer API is read-only here: no draft is changed or sent, and the query cache retains only a boolean rather than composer text. Focused composer text refreshes periodically; folded bodies do not poll.
- Empty, untitled sessions stay out of the list unless their local composer contains a nonblank draft prompt. Those draft cards display **New session**, with the exact runtime workspace's project name, icon/color and concrete provider metadata even before the first message. Clearing the draft removes the empty card; the first real message makes it ordinary history. Running jobs, pending input and unknown history remain accessible. Draft text is read only through the public composer API and reduced immediately to a boolean; attachment-only drafts are not detectable through that text-only API.
- The new-session picker lists supported project folders, without the unsupported Home entry or its explanatory text. The filter button opens project choices directly; while filtered, it shows the selected project's icon instead of the generic filter icon.
- Filter and New session share the same native project list, always-visible name/path search and right-click/Shift+F10 project menu. Only Filter includes **All projects**. Paths are dimmed and shorten the owning backend user's home to `~` without changing the actual selection/copy/create paths. A multi-folder project appears once as a non-selectable heading with selectable folders indented below; searching for one folder retains that heading. Its heading's menu still edits the project, but path-specific Copy path/Filter for actions require choosing an individual folder.
- Right-click **Delete session** keeps Hermes's destructive confirmation modal. Deletion is revision/generation-fenced and verified against exact stored IDs; Cancel does nothing, errors remain visible, and ambiguous retries reuse the original request. Busy sessions are not interrupted automatically. Permanently retired session IDs are excluded from runtime listings even if an old chat remains mounted; missing history alone does not imply deletion. Genuine unsaved runtime-only drafts have no stored history to delete, and disappear from the sidebar when their prompt is cleared.

Archive/Unarchive calls Hermes’s profile-routed `session.archive` operation with an explicit boolean and verifies the exact stored session’s flag through the read-only companion before confirming success. Archival applies to the native compression lineage; it is not deletion, an agent-stop operation or a hidden prompt. Pins and snoozing remain plugin-owned organization metadata. Snooze eligibility is based on an absolute server timestamp: closing Desktop does not reset the deadline. Due items become Ready on the next metadata refresh; no background agent is resumed.

Earlier versions used a plugin-only settlement shelf. Existing settlement metadata is retained for compatibility but does not count as native archival and is not automatically converted by bulk-writing session history. Those conversations rejoin the ordinary list unless another current condition (such as a pin, snooze or running job) places them elsewhere. Archive them explicitly to move them into Hermes’s real archive.

## Performance

Local toolbar interactions avoid rebuilding every card, history lineage merges use an index, and verified actions no longer wait for an unrelated full-list refresh. Scoped lifecycle events refresh runtime only; history changes trigger broader reconciliation. The companion avoids writer transactions for ordinary metadata reads and keeps blocking standalone runtime reads off the event loop and outside the global session lock. Before/after measurements, regression coverage and remaining limitations are documented in [the performance report](docs/performance.md).

Large sections mount only their visible cards plus a small overscan, retaining focused cards and open-menu owners. Counts, scroll ranges and keyboard ordering still cover every loaded session. Runtime classification uses an indexed join; organized-history recovery uses one bounded lookahead to avoid hundreds of native searches for archived metadata IDs. The [large-history report](docs/large-history-performance.md) measures five hundred Ready plus five hundred Archived cards, both motion modes, search/filter clearing and backend reads.

Viewport height is cached from `ResizeObserver` after initial measurement, so ordinary scrolling and keyboard reveals do not repeatedly read `clientHeight`. Folding preserves the last positive height; older clients without the observer retain direct measurement as a fallback. Working uses a constant content-fit parent track and animates its own body track, retaining its empty/folded header and sparse-card fit. Dense Working stays capped during part of that intrinsic animation, so its easing differs slightly from the former calculated-height transition; this cleanup does not establish a new wall-clock speedup.

## Package

```text
hermes-t3sidebar/
├── plugin.yaml
├── __init__.py
├── dashboard/
│   ├── manifest.json
│   └── plugin_api.py
└── desktop/
    └── plugin.js
```

The Desktop half is plain ESM: no bundle, compile step or Hermes source changes. The companion stores organization metadata in the active Hermes profile’s `plugin-data/hermes-t3sidebar/state.sqlite3` and reads that profile’s native rich session list and authoritative runtime status. It uses Hermes’s authenticated plugin namespace, `/api/plugins/hermes-t3sidebar`.

The UI uses the supported Desktop SDK. The companion’s native session readers reuse **version-sensitive Hermes internals** for authenticated authority resolution and read-only rich listing; compatibility failures become explicit unavailable/unknown state rather than falling back to a process-wide runtime registry. A standalone dashboard without a native session authority cannot provide the Working/Waiting split.

## Installation

This checkout is an implementation artifact, not a deployment. In particular, a checkout on a remote Hermes server does **not** install a plugin on your Windows Desktop client.

For a published repository, use **Capabilities → Plugins → Install from Git**, choose `https://github.com/V1rgul/hermes-plugin-t3sidebar`, and select both **Agent plugin** and **Desktop UI** as needed. Enable the agent companion in the desired profile and enable the Desktop UI switch. If the companion is already installed on the server, choose **Desktop UI** only for the client installation.

For an unpublished local artifact:

1. Put the package in the backend’s profile-local `plugins/hermes-t3sidebar/` and enable it through Hermes’s native plugin management.
2. The backend process serving Desktop must load its new API routes. Restart it only when an interruption is acceptable.
3. On the computer running Electron, use **Capabilities → Plugins → Open folder**. Copy the contents of `desktop/` into `<that folder>/hermes-t3sidebar/` and enable **hermes-t3sidebar**. The file watcher hot-loads the UI; no client restart is normally required.
4. Open the **t3sidebar** pane. Hide the built-in **Sessions** pane using Hermes’s normal layout controls. The replacement is a normal movable/resizable pane; it never overrides the native pane ID or mutates its DOM.

Installing files, enabling configuration, loading API routes and seeing the UI are separate verification steps. This repository does not restart services or change configuration automatically.

### Rename boundary

The plugin was previously named **Session Flow** (`session-flow`). Its ID, backend namespace, Desktop settings/query-cache namespace and metadata folder are now `hermes-t3sidebar`. Before installing the renamed plugin, remove the old agent/Desktop plugin installations and enabled entries through Hermes’s plugin management so both versions do not run side by side. Existing `plugin-data/session-flow/state.sqlite3` metadata is **not automatically migrated or deleted**; the renamed plugin uses a separate `plugin-data/hermes-t3sidebar/state.sqlite3` store. Native conversation history is unchanged. This source rename does not modify any installed plugin, configuration or live metadata.

## Boundaries

- Works in the selected gateway/profile scope, rather than silently aggregating different accounts or servers.
- The server companion provides persistent pins, snooze, profile-qualified runtime status, native archive-state readback and separate rich history/archive pagination. If unavailable, the SDK’s first 500 regular rich sessions remain browseable with an explicit cap; organization and native archive actions are unavailable, with no local metadata or unqualified runtime fallback. An archive-list failure is reported rather than presented as an empty archive.
- Older regular history and archives load on demand independently. Organized regular sessions are recovered outside the recent page automatically, including due snoozes. Search covers loaded rows and recovered organized sessions, not history that has not yet been loaded.
- Native archived-and-hidden conversations can appear in Archived, but Unarchive deliberately preserves their separate hidden flag. They will not return to this ordinary session list unless their native visibility is changed separately.
- Pins are hermes-t3sidebar metadata, not synchronized with Hermes’s native pin store. Drag/reorder, bulk selection and cross-profile aggregation are not implemented in this version.
- Snooze is plugin-owned metadata and remains available while a stored session is working; it never stops or resumes execution. Snoozed cards show a blue snooze icon before the non-bold remaining duration, rounded to one whole unit (for example, 2d 16h becomes 3d), without a “left” suffix. Their menu starts with two disabled blue information rows: precise `Xd Xh Xmin left` and the wake date/time in the client's locale-short format. Green Unsnooze is the first enabled action. Native Archive still requires confirmed idle status, and input/unknown-runtime visibility takes precedence over snoozed placement.
- Runtime Working/Waiting state comes from the gateway’s live session snapshot, not its connection status or a recent-activity heuristic. Unknown runtime status must not be presented as confirmed idle.
- Activity-based unarchiving is a best-effort `pre_llm_call` hook, not a session-open side effect. If the installed native archive setter would also touch an independent fork, the hook refuses the overbroad write; it never restores another conversation to make a card look correct. Native archival has no atomic lineage compare-and-set, so concurrent external archival/lineage changes remain a core API limitation.
- Done now uses shared plugin-owned backend completion markers, with native backend unread as an additional signal. This is not an exact projection of Desktop's private green-dot store and does not retroactively mark old idle history. The producer requires supported server lifecycle hooks; the inspected opt-in `codex_app_server` runtime bypasses its end hook and is not covered. The `openai-codex` provider alone does not imply that runtime. No core patch, native unread rewrite or timestamp-based completion guess is used.
- Delete delegates through the companion to the native authenticated HTTP deletion endpoint, avoiding `session.mutate` on Desktop's legacy RPC transport. Core retains revision/generation fences, durable request receipts, busy/lease guards, lineage deletion and transcript/request-dump cleanup; the companion and client verify exact stored-ID absence. The plugin does not perform the native Desktop's private tab/journal/cache cleanup. Deleting the currently focused session opens a fresh draft through the public SDK after verification. Hosted plugin processes without native actor context fail unavailable instead of bypassing native authorization or falling back to legacy deletion.
- Project filtering does not change Hermes’s sidebar grouping or the draft workspace.
- The public SDK does not provide the native fresh-draft project/cwd setter. **New session** uses Hermes’s normal new-chat action; this plugin does not pretend that a list filter chooses the new chat’s project.
- T3-specific provider, worktree, PR and terminal orchestration are not recreated. This is a session-navigation plugin, not a replacement for Hermes’s workspace or T3 Code itself.

## Development

Frontend tests use Node’s test runner and render the actual React tree. Backend tests use Python’s `unittest` and a real FastAPI test client. The HTTP integration test connects the frontend controller to the real Python API and SQLite store. Browser tests render the real plugin in Chromium with explicitly synthetic SDK/session fixtures; they do **not** establish live Electron compatibility.

```sh
npm ci --ignore-scripts --no-audit --no-fund && npm run test:all
```

Python test dependencies are listed in `requirements-dev.txt`; Hermes already provides the production FastAPI/Pydantic environment. The browser smoke uses an installed Chromium from the Playwright cache or `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. If neither exists, install the matching development browser with `npx playwright install chromium`; the tests never silently download one.

To inspect the rendered sidebar with synthetic data:

```sh
npm run harness
```

Open `http://127.0.0.1:4173`. The right-hand panel is a labeled test workspace, not an alternative chat implementation. Generated screenshots are written to `artifacts/`.

The production plugin itself needs none of these Node development dependencies or generated bundles.

SDK reference: https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk

Current rename verification is in [`docs/rename-verification.md`](docs/rename-verification.md). Earlier review/remediation/verification reports under `docs/` are historical evidence for the original Session Flow candidates; their names, outputs and hashes do not validate the renamed bytes.
