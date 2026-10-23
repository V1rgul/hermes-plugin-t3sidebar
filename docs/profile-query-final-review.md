# Bounded candidate re-verification — PASS

Scope: exact uncommitted candidate in `/home/hermes/Git/hermes-plugin-t3sidebar`; reproduced launch-profile sentinel and unpersisted-draft blockers, plus profile isolation and matching transport-profile queries. No deployment or upstream suite.

## Findings

No remaining deterministic blocker found in this scope.

- Inspected installed native `_profile_home`, `_launch_home`, `_own_profile_read`, `_session_live_item` and `_session_mutation_context` source/signatures. Native `_profile_home` explicitly returns `None` for the launch profile. The request-local adapter maps only that sentinel to native `_launch_home`; the native helper retains exact resolved-home equality.
- Adapter shares the already-loaded server's registry/lock, delegates native mapping, and captures source only for rows selected by the native exact-home helper. No independent registry traversal, replacement server import, global monkeypatch or private RPC is introduced in production.
- Persisted source wins. Only absent DB records fall back to captured native source. An unsent CLI draft remains visible/idle without persistence; internal and foreign drafts remain excluded; genuinely unknown source remains 503.
- Native authentication resolution precedes standalone admission. Actor home, native grant home and read capability checks precede the scoped helper. Colliding stored IDs in two homes retain their distinct runtime identities/statuses.
- Every supplied transport-profile value must match the host-established profile; mixed, foreign, empty and unknown parameters remain refused.

## Fresh execution

- `PYTHONDONTWRITEBYTECODE=1 python -W error::ResourceWarning -m unittest discover -s tests -p test_standalone_runtime.py -v`: **14 passed**.
- Equivalent focused `test_native_contracts.py` discovery: **8 passed**, including matching repeated profile values and foreign/mixed-value rejection.
- Additional scratch fixture probe combined the real launch sentinel and unpersisted draft in one request, with deliberately contradictory registry/persisted source values: **PASS**, exactly `[('draft', 'idle'), ('runtime-a', 'waiting')]`. Persisted CLI source stayed visible despite registry `tool`; persisted internal source stayed excluded despite registry `cli`.
- `git diff --check`: **passed**.

Only this review document was created. No source edits, live DB access, credentials, process-memory inspection, configuration changes, restart, deployment, commit or push. Synthetic authenticated fixtures and scratch databases validate the installed native contract, not live post-deployment activation.

Documentation caveat (nonblocking): `docs/profile-query-fix.md` lines 42–45 describe the older unconditional missing-record failure; current code correctly permits a missing persisted row when native captured source is known.
