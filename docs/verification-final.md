# Bounded final verification — PASS

> Historical report for the original Session Flow candidate, before the `hermes-t3sidebar` rename. Names, command outputs and hashes below are preserved evidence, not verification of the renamed bytes. See [rename-verification.md](rename-verification.md) for current results.

The last reproduced blocker (internal-session leakage) is closed on this exact candidate.

## Candidate and delta

SHA-256, identical before/after this verification:

```text
3133195600df8bae91dd3baec5350ee616902fe8458d2fd4c1f45f5fe89055be  desktop/plugin.js
324b0646fd1f8ec60b435ef00968f089fd14c6cd3987a592be8e05023fb86c50  dashboard/plugin_api.py
```

Frontend is unchanged. Independently removing only the imported `INTERNAL_LISTING_SOURCES` line and the two `exclude_sources=list(INTERNAL_LISTING_SOURCES)` arguments reconstructs the previous backend SHA-256 exactly: `05a013666ec90402d631a7e60d6c4065c67de8c7dc3c755e34f11b81d5bb8076`. Both ordinary pagination and organized backfill use the installed native denylist: `('kanban', 'tool', 'oneshot')`.

## Independently executed

- Original deterministic scratch reproducer: exit 0; actual and native-picker expected both `['cli']`.
- Focused regression: `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=tests python -m unittest test_native_contracts.NativeContracts.test_native_internal_sources_excluded_from_pages_and_organized_backfill -v`: **1 passed**, 0.154 seconds.
- Additional fresh scratch native DB using the real native profile DB opener, redirecting only its path: page 0 `['recent-human']`; page 1 `['older-human']`; page 2 empty. Organized backfill recovered the older human while excluding every explicitly referenced internal ID. Results matched native rich-list exclusion. Native DB bytes unchanged; temporary directory removed; foreground test exited, no remaining own fixture processes.

## Inherited acceptance and limits

All previously verified acceptance closures and broader suite results in `docs/verification-review.md` are inherited, not rerun here. The exact bounded backend delta closes that report's sole blocker; no new scope audit is claimed.

Only this report was written in the repository by this verifier. No source changes, configuration, install, restart, deployment, commit, push, or live history access. No Electron, actual Desktop-client, or live authenticated remote-mount verification is claimed. Existing native-helper version/schema-drift limits remain unchanged.
