# Independent candidate verification

> Historical report for the original Session Flow candidate, before the `hermes-t3sidebar` rename. Names, command outputs and hashes below are preserved evidence, not verification of the renamed bytes. See [rename-verification.md](rename-verification.md) for current results.

## Verdict: FAIL — one bounded native-picker regression

The reproduced review defects are closed. The new companion history reader nevertheless admits internal, non-conversation sessions excluded by the native Sessions picker. This is a regression in the replacement listing introduced by remediation, not a request for additional UI features.

### Blocking finding: P2 — internal sources leak into browsing

`dashboard/plugin_api.py:206` and `:216` call `list_sessions_rich` without `exclude_sources`. The installed implementation defaults that argument to `None`; it does **not** automatically apply `INTERNAL_LISTING_SOURCES = ('kanban', 'tool', 'oneshot')` (`hermes_state_sessions.py:235–239, 1345–1365`). Consequently both ordinary pagination and organized-reference backfill admit internal rows. The native runtime reader correctly excludes those sources, so leaked rows can also appear deceptively idle in Session Flow. They consume recent-page slots and make a native-sidebar replacement browse a different population. Acceptance anchor: `docs/acceptance.md:7` (usable instead of the native Sessions pane), and the remediation's native visibility claim (`docs/remediation.md:10,61`).

Required bounded correction: apply the native internal-source exclusion to **both** rich-list calls, with a scratch-DB regression covering the recent page, older page and organized backfill. No drag/bulk/draft-project work is required.

Deterministic reproducer, run from this checkout with its existing Python dependencies:

```python
from contextlib import closing
import importlib.util
from pathlib import Path
import sys, tempfile
from unittest.mock import patch
from hermes_state import SessionDB
from hermes_state_sessions import INTERNAL_LISTING_SOURCES
import hermes_cli.web_server_sessions as native

spec = importlib.util.spec_from_file_location('flow_probe', Path('dashboard/plugin_api.py'))
plugin = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin
spec.loader.exec_module(plugin)
with tempfile.TemporaryDirectory(prefix='flow-filter-repro-') as directory:
    path = Path(directory) / 'state.db'
    with closing(SessionDB(path)) as db:
        for source in ('cli', *INTERNAL_LISTING_SOURCES):
            db.create_session(source, source)
    with patch.object(native, '_session_db_path_for_profile', return_value=path):
        actual = sorted(r['id'] for r in plugin.native_sessions('scratch', 0, 500, ())['sessions'])
    with closing(SessionDB(path, read_only=True)) as db:
        expected = sorted(r['id'] for r in db.list_sessions_rich(
            exclude_sources=list(INTERNAL_LISTING_SOURCES),
            compact_rows=True, order_by_last_active=True))
    print('actual:', actual)
    print('expected native picker:', expected)
    assert actual == expected, 'internal non-conversation rows leak into Session Flow'
```

Executed equivalent scratch file:
`PYTHONDONTWRITEBYTECODE=1 python /home/hermes/.hermes/cache/scratch/flow-internal-filter-reproducer.py`

Actual output, exit 1:

```text
actual: ['cli', 'kanban', 'oneshot', 'tool']
expected native picker: ['cli']
AssertionError: internal non-conversation rows leak into Session Flow
```

## Verified closures and native boundaries

- Asynchronous route inventory is awaited; ordinary and ABA route changes reject list/open/new before dispatch. Open and new-chat retain the exact owning route, including duplicate names/IDs.
- Stored focused identity plus `focusedSessionOwner` qualifies selection by connection/profile, including compression aliases and tile focus. These names and shapes match the actual installed SDK.
- Legacy process-wide runtime RPC is absent. Exact companion profile markers reject foreign matching IDs; runtime failure becomes unknown and keeps rows visible. Waiting outranks suppressed shelves.
- Metadata writes/readback use only plugin-owned SQLite. Concurrent updates preserve fields; no native mutation, claim binding, prompt or execution action is introduced.
- Search reveals collapsed-shelf hits without overwriting collapse preference.
- Rich older pagination, 501st organized-row recovery across remount/due wake, stable compression roots and project/branch filtering pass. Exact-ID backfill pages beyond 500 substring collisions.
- Independent extra probe exercised the **real** `_session_mutation_context`, `_open_session_db_for_profile`, `active_list` and `live_entries` against scratch storage, with explicit authentication/home/authority doubles. Helper call signatures match production; the actor is reduced to `session:read`. Native runtime excludes internal sources. Healthy native scratch DB bytes remained unchanged after the independent listing/backfill probe; the existing native-contract test additionally checks unchanged native bytes across metadata operations.
- `served_profile()` returns `default` with the real `profile_name_for_home(get_default_hermes_root())`; no live profile DB was opened to establish this.

## Executed verification

All following commands exited 0:

- `PYTHONDONTWRITEBYTECODE=1 npm test`: **32 passed, 0 failed**, including real loopback FastAPI/controller/SQLite integration; duration 5072.896925 ms.
- `PYTHONDONTWRITEBYTECODE=1 npm run test:backend`: **22 passed**, including six source-sensitive native contract tests; `Ran 22 tests in 2.770s — OK`.
- `node --check desktop/plugin.js`: no diagnostics.
- `PYTHONDONTWRITEBYTECODE=1 hermes plugins doctor --ci .`: standalone `session-flow 0.1.0`; runtime discovery, manifest parsing, import and registration passed; zero tools/hooks.
- `npm run test:browser` in a scratch copy of this project's desktop/harness/tests with the checkout's dependency directory: **13 checks passed**, no browser page errors. Build/screenshots stayed in the disposable copy, preserving repository artifacts.
- `PYTHONDONTWRITEBYTECODE=1 python /home/hermes/.hermes/cache/scratch/flow-verification-native.py`: real-helper compatibility, default profile, read-only actor, root/tip backfill and unchanged healthy scratch native bytes passed; independently exposed the internal-source listing mismatch.

The existing passing suites lack the internal-source history case; they do not invalidate the failing independent reproducer.

## Exact production hashes and safety

Before **and** after verification, SHA-256 was identical:

```text
3133195600df8bae91dd3baec5350ee616902fe8458d2fd4c1f45f5fe89055be  desktop/plugin.js
05a013666ec90402d631a7e60d6c4065c67de8c7dc3c755e34f11b81d5bb8076  dashboard/plugin_api.py
```

Only this report was written inside the repository. No production source edits, install, enablement, deployment, live profile DB access, core edits, configuration changes, restart, commit or push occurred. Repository remains intentionally uncommitted against its unborn-main empty baseline. Process inspection found no remaining fixture/browser/test runner; listener inventory was unchanged after testing.

Boundary: Chromium uses an SDK mock, not Electron. Authenticated remote plugin mounting and the user's actual Desktop client were not exercised. Native helper imports remain version-sensitive; healthy scratch-store read-only behavior is not a claim about every core schema-drift recovery path. These are verification limits, not additional feature demands.
