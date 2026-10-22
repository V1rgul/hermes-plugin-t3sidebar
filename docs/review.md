# Independent review of the initial candidate

> Historical report for the original Session Flow candidate, before the `hermes-t3sidebar` rename. Names, command outputs and hashes below are preserved evidence, not verification of the renamed bytes. See [rename-verification.md](rename-verification.md) for current results.

Review baseline: empty repository; all local source files are new and uncommitted. Review input was the integrated candidate before remediation, with `24` frontend tests, `16` backend tests and `13` Chromium checks passing. A subsequently added real HTTP integration test also passed. Passing those fixtures did not establish the real SDK contract.

## Standards and correctness

The independent correctness reviewer returned **changes required**:

- **P1 — Async route inventory:** the actual SDK declares `host.profileRoutes` async. The initial controller passed its promise to `.find()`, so persisted-session browsing failed against the real SDK despite the synchronous fixture passing. Required regression: asynchronous route discovery and route switches while awaiting it.
- **P1 — Runtime ownership:** legacy `session.active_list` can enumerate every runtime in the process without profile ownership fields. Injecting unmatched rows or joining by a bare stored ID can contaminate the selected scope. Required fix: a genuinely profile-qualified source, failing explicitly unknown when unavailable; a profile parameter alone is insufficient.
- **P2 — Selection identity:** runtime `activeSessionId` is not the durable focused stored ID. Required fix: focused stored identity plus matching owning connection/profile, including session tiles.
- **Routing risk:** bare `host.openSession(id)` drops the captured owning route. Required fix: pass the explicit route and fence route discovery/action against source changes.

No blocking code-complexity issue was found. Tab indentation was suggested to align with the user’s repository convention.

## Specification and layout

The independent spec reviewer confirmed the async-route defect and reported:

- **P2 — Search over collapsed shelves:** an existing match in a collapsed shelf was hidden and falsely labeled “No matching sessions.” Searching must reveal matching results without destroying the saved collapse preference.
- **Bounded parity gap — Older organized sessions:** sessions beyond the rich list’s 500-row page were absent after remount until manual expansion, even when recently settled or due from snooze. The compact fallback also discarded project filtering. Required remediation acceptance: preserve rich on-demand pagination and automatically recover organized rows beyond the initial page.

The reviewer found no material unasked scope creep. Native-workspace preservation, the missing fresh-draft project setter and omission of T3-specific provider/worktree orchestration were accepted boundaries. Screenshots showed a compact, usable layout.

## Verification boundary

The reviewers used source inspection and targeted plugin probes; neither deployed the plugin or verified the user’s Windows Electron client. No production configuration, service, commit or remote ref changed during review. Remediation and its exact follow-up verification are recorded separately.
