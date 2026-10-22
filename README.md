# hermes-t3sidebar

A T3 Code-inspired replacement session sidebar for Hermes Desktop. It opens existing conversations in Hermes’s normal workspace; it does not replace the chat interface or alter agent instructions.

## Workflow

- **Active:** conversations ready for your attention. Pending approvals and questions remain visible here, even when the session was snoozed or settled.
- **Working:** running jobs separated from attention items and visually subdued.
- **Snoozed:** conversations put aside until a chosen time, with presets and a custom date/time.
- **Recently settled:** a reversible history ordered by settlement time, not deletion or native archival.
- Compact session rows, search, project filtering, pins and row actions.

Settlement and snoozing are organizational metadata. They never stop a running agent, send a prompt, delete history or modify Hermes’s native archive flag. Snooze eligibility is based on an absolute server timestamp: closing Desktop does not reset the deadline. Due items become Active on the next metadata refresh; no background agent is resumed.

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
4. Open the hermes-t3sidebar pane. Hide the built-in **Sessions** pane using Hermes’s normal layout controls. The replacement is a normal movable/resizable pane; it never overrides the native pane ID or mutates its DOM.

Installing files, enabling configuration, loading API routes and seeing the UI are separate verification steps. This repository does not restart services or change configuration automatically.

### Rename boundary

The plugin was previously named **Session Flow** (`session-flow`). Its ID, backend namespace, Desktop settings/query-cache namespace and metadata folder are now `hermes-t3sidebar`. Before installing the renamed plugin, remove the old agent/Desktop plugin installations and enabled entries through Hermes’s plugin management so both versions do not run side by side. Existing `plugin-data/session-flow/state.sqlite3` metadata is **not automatically migrated or deleted**; the renamed plugin uses a separate `plugin-data/hermes-t3sidebar/state.sqlite3` store. Native conversation history is unchanged. This source rename does not modify any installed plugin, configuration or live metadata.

## Boundaries

- Works in the selected gateway/profile scope, rather than silently aggregating different accounts or servers.
- The server companion provides persistent pins, settlement, snooze, profile-qualified runtime status and rich history pagination. If unavailable, the SDK’s first 500 rich sessions remain browseable with an explicit cap; organization is read-only and runtime status is unknown, with no local metadata or unqualified runtime fallback.
- Older history loads on demand. Organized sessions are recovered outside the recent page automatically, including due snoozes and newly settled old conversations. Search covers loaded rows and recovered organized sessions, not history that has not yet been loaded.
- Pins are hermes-t3sidebar metadata, not synchronized with Hermes’s native pin store. Drag/reorder, bulk selection and cross-profile aggregation are not implemented in this version.
- Runtime Working/Waiting state comes from the gateway’s live session snapshot, not its connection status or a recent-activity heuristic. Unknown runtime status must not be presented as confirmed idle.
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
