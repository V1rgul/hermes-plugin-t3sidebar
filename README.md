# hermes-t3sidebar

A T3 Code-inspired replacement session sidebar for Hermes Desktop. It opens existing conversations in Hermes’s normal workspace; it does not replace the chat interface or alter agent instructions.

## Workflow

- **Ready:** headerless conversations ready for your attention. Pending approvals and questions remain visible here rather than disappearing into a background shelf.
- **Working:** running jobs separated from attention items and visually subdued, with blue Working text.
- **Snoozed:** conversations put aside until a chosen time, with presets and a custom date/time.
- **Archived:** Hermes’s real archived sessions, including conversations archived outside this plugin. Archive and Unarchive use native session archival; history is retained. The shelf is ordered by last activity, not an invented archival timestamp.
- Headerless Pinned cards above Ready, two-line session cards, search, project filtering and hover-only Snooze/Archive actions. Category bodies scroll independently while secondary headers remain visible.
- Working, Snoozed and Archived headings show a parenthesized session count, a divider and a right-aligned chevron. Fold preferences persist locally through Desktop restarts, separately for each source and profile. Searching temporarily reveals matching Working/Snoozed rows, but never automatically unfolds Archived; its matching count remains available for explicit expansion.
- Project glyphs have transparent backgrounds in both cards and the new-session picker. The picker closes through the normal popover dismissal without a Cancel button. Searches with no loaded matches show “No matching sessions”, never “All caught up”.
- Reverse archival directly through Archive/Unarchive; these actions do not add an Undo banner. Snooze, restore and pin actions retain Undo.
- The pane tab is named **t3sidebar**; the plugin ID and storage namespace remain `hermes-t3sidebar`.
- Cards show green **Done** for backend unread, orange **Woke** after snooze expiry until the thread is opened/read, and purple **Input** for a question or approval awaiting attention. Each has a leading status icon and a bold title; Working remains blue. Project names, glyphs and ordinary ages have stronger contrast while provider/token metadata stays subdued.
- Expanded Archives receives a larger share of list height. Categories animate open/closed without moving their headers into the scroll bodies; reduced-motion preferences disable these transitions.
- Right-click offers Pin/Unpin, Restore when snoozed, Rename, Copy session ID and an exact project-filter shortcut. Rename is available only for a confirmed live runtime and verifies the saved title; stored-only threads explain the limitation. Archive and Snooze stay on their direct hover controls, and archived cards omit Snooze. Lists are always flat; project filtering does not group them.
- Custom snooze uses the date/time field with Enter or its adjacent checkmark; there is no bottom “Snooze until chosen time” button.
- Opening a thread marks it read but does not change its displayed conversation age or recency order. Stored conversation activity, not the runtime's resume/reattach clock, drives those values.
- Working fits its cards instead of reserving empty vertical space; large Working lists still scroll within the pane's height limit. Search keeps an explicit clear cross visible whenever the input has text. Rename uses a checkmark beside its field, and Input/Working/Done labels are bold.
- A nonempty composer text draft gives its card a dim orange background. The public Desktop composer API is read-only here: no draft is changed or sent, and the query cache retains only a boolean rather than composer text. Focused composer text refreshes periodically; folded bodies do not poll.

Archive/Unarchive calls Hermes’s profile-routed `session.archive` operation with an explicit boolean and verifies the exact stored session’s flag through the read-only companion before confirming success. Archival applies to the native compression lineage; it is not deletion, an agent-stop operation or a hidden prompt. Pins and snoozing remain plugin-owned organization metadata. Snooze eligibility is based on an absolute server timestamp: closing Desktop does not reset the deadline. Due items become Ready on the next metadata refresh; no background agent is resumed.

Earlier versions used a plugin-only settlement shelf. Existing settlement metadata is retained for compatibility but does not count as native archival and is not automatically converted by bulk-writing session history. Those conversations rejoin the ordinary list unless another current condition (such as a pin, snooze or running job) places them elsewhere. Archive them explicitly to move them into Hermes’s real archive.

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
- Runtime Working/Waiting state comes from the gateway’s live session snapshot, not its connection status or a recent-activity heuristic. Unknown runtime status must not be presented as confirmed idle.
- Done currently uses backend unread only. Desktop also has local seen-message counts/completion markers that its public SDK does not expose as readable status. Consequently, a native green dot can exist while this plugin has no Done label. No Hermes source patch, private-store access or timestamp-based unread guess is used; runtime `last_active` also changes on agent activity and internal reattachments, so it cannot reliably stand in for a read watermark.
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
