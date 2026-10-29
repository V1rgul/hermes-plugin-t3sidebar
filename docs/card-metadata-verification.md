# Safe native card metadata — local verification

## Contract

The native `/sessions` reader now enriches its allowlisted list rows with:

- `project`: `{id, name, icon, color, cwd, is_home?}`. Native active projects retain their IDs, custom display names, icons and colors. Matching uses the longest owning folder with a path boundary, including secondary folders; archived projects are excluded. `cwd` is the matched folder. With no match/catalog, a nonempty session cwd produces an honest path/basename fallback. Empty cwd produces `{id: "__no_project__", name: "Home", icon: null, color: null, cwd: null, is_home: true}`.
- `provider`: an explicit nonempty provider from the surfaced compression tip's `model_config.provider`, then `model_config.gateway_runtime.provider`; otherwise `null`. Invalid JSON, non-object configurations and model-name guesses never establish a provider.
- `model`: native surfaced-tip model, or `null` when unknown.
- `input_tokens`, `output_tokens`: sums across unique compression-chain segment IDs plus every delegated subagent session below them (nested delegates and subagent compression continuations included, each counted once; branch/reset forks excluded). Each unknown/missing/invalid component makes that component's aggregate `null`; known zero stays zero.
- `total_tokens`: input plus output only, or `null` when either aggregate is unknown. Cache and reasoning counters are not added again.
- `source`: native source provenance.

Raw `model_config`, system prompts, and non-allowlisted native row fields are not serialized.

## Read-only and batching boundaries

- The catalog is derived from the **currently opened SessionDB's `db_path` parent**, not global/default profile home.
- A missing `projects.db` is not created. Existing catalogs open with SQLite URI `mode=ro` and `sqlite3.Row`; native `list_projects` runs once per enrichment batch. Native `projects_db.connect` is never invoked by enrichment, so schema initialization/migration is not triggered. Unreadable/legacy catalogs fall back without modification.
- Compression segments are fetched together through `_get_session_rich_rows_batch(..., compact_rows=True)`. No enrichment `get_session` or full-prompt reads occur. Ordinary rows reuse the existing native compact listing.
- Existing exact-profile query assertions, native pagination/organized backfill, cron exclusions, standalone exact-home runtime mapping, launch-home `None` handling, and unsent-draft source provenance remain intact.

## Verified locally

Command: `npm run test:backend`

Result: **49 tests passed**, using `python -W error::ResourceWarning -m unittest discover -s tests -v`.

`test_card_metadata.py` contains 10 focused regressions covering real scratch SessionDB/projects catalogs, custom native project metadata, nested and secondary folders, archived exclusions, `/repo` versus `/repo2`, Home, missing/corrupt catalogs, no file creation, read-only enforcement, one catalog load, explicit provider precedence, invalid configurations, surfaced-tip versus root provenance, batched unique segments, partial unknown usage, zero/invalid counters, cache/reasoning non-double-counting, secret exclusion, unchanged native-store bytes, and authority-runtime cron exclusion.

Existing backend/native/standalone regressions also pass, including repeated exact profile parameters, organized cron backfill exclusion, 500 substring-collision pagination, real native compression projection, exact-home runtime isolation and unsent drafts.

`git diff --check -- dashboard/plugin_api.py tests/test_backend.py tests/test_native_contracts.py tests/test_card_metadata.py` passed.

## Scope and limitations

Local backend verification only, against the installed native Hermes APIs. No frontend edits, services/configuration changes, deployment, dependency installation, commits or pushes. No live user catalog/session data was used for card metadata tests. Enrichment depends on the installed private compact-batch API and native Project dataclasses; compatibility with other Hermes revisions was not exercised. Native `list_projects` internally loads folders per project; this change avoids per-session catalog lookups, not the native catalog implementation's internal query pattern.
