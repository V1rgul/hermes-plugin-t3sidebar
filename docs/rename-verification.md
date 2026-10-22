# hermes-t3sidebar rename verification

Verified locally on 2026-10-23 against the uncommitted rename from `82944a386bb5d278a94998fe8049d34981bbbabd`.

## Scope

- Product/display name, Desktop plugin ID, agent manifest name, dashboard name/label and private npm package name are exactly `hermes-t3sidebar`.
- The backend mount namespace is `/api/plugins/hermes-t3sidebar`; profile-local metadata resolves through `get_hermes_home()` to `plugin-data/hermes-t3sidebar/state.sqlite3`.
- Settings navigation, query keys/disposal, named component/store exports, tests, synthetic harness and current README/acceptance documentation use the new identity.
- Dependency versions, scripts, behavior, native read-only boundaries and metadata schema are unchanged. A programmatic comparison confirmed that production sources, manifests and package files are exact rename-only transformations of the baseline.
- The repository URL remains `https://github.com/V1rgul/hermes-plugin-t3sidebar`; the repository, checkout and Hermes project were not renamed.

## Executed gates

From the repository root, all commands exited 0:

```sh
PYTHONDONTWRITEBYTECODE=1 npm run test:all
node --check desktop/plugin.js
PYTHONDONTWRITEBYTECODE=1 hermes plugins doctor --ci .
git diff --check
```

| Gate | Actual result |
| --- | --- |
| Node/React/controller + real loopback HTTP integration | 32 passed, 0 failed |
| Python metadata/native-contract tests | 23 passed |
| Chromium interaction smoke | 13 checks passed; no page errors |
| JavaScript syntax | Passed without diagnostics |
| Plugin Doctor | `hermes-t3sidebar 0.1.0 (standalone)`; discovery, manifest parsing, import and registration passed; 0 tools/hooks |
| Whitespace check | Passed |

Rename assertions cover the actual plugin ID/name, dashboard name/label, agent manifest name, npm/lockfile root names, pane/settings titles, rendered sidebar name, settings URL and scoped query prefix. The HTTP integration derives its namespace from the actual Desktop plugin ID and successfully talks to the renamed Python fixture mount. The profile-home path test checks the renamed metadata location.

Regenerated and visually inspected `artifacts/frontend.png` and `artifacts/actions.png`: both show `hermes-t3sidebar`, with readable header controls and an unclipped actions popover. The generated harness bundle remains ignored; no release archive was produced.

SHA-256 of the verified production files and previews:

```text
ba5f2a921829c0fc7c5b3c32039155fa7e8750f16a6b4252648d850a50cb69cd  desktop/plugin.js
d5684aee15249e1230924db2133aa4fefb204dce4ffc61ee2d065cba1c34bb60  dashboard/plugin_api.py
1ea1182beaa4e556c34ee74deecf2ac23e5e929ce8234d8acfba19d6e0183c33  artifacts/frontend.png
7983607ad81a8e0cc0b76ea6fa9ca1afd024f470341927680d766678fa6e36fc  artifacts/actions.png
```

## Existing installations and evidence boundaries

The old `session-flow` installation/enabled entries must be removed before installing the renamed plugin to avoid running both IDs. Old `plugin-data/session-flow/state.sqlite3` metadata is not automatically migrated or deleted; the renamed ID starts a separate organization store. No live storage was read or changed by this rename, and native conversation history is unaffected.

A tracked-text audit found old product tokens only in the README’s explicit rename/history explanations and the historical review/remediation/verification reports. Those reports now carry a historical banner; their original report bodies, command outputs and candidate hashes were programmatically confirmed preserved verbatim. They do not validate the renamed bytes.

This is local checkout verification with synthetic SDK/session fixtures and scratch native databases, not a live Electron or authenticated remote-mount test. Native helper compatibility remains version-sensitive. No installation, enablement/configuration change, service restart, deployment, commit or push was performed.
