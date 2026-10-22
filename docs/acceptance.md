# Session Flow acceptance contract

Source: user session `20261023_002913_f349b4`, followed by the implementation request and clarifications in the current conversation. The repository started empty with an unborn `main` branch, so review compares the complete tracked-plus-untracked file manifest against an empty baseline; no commit is required to create a review anchor.

## Requested product

A Hermes Desktop plugin providing a sidebar usable instead of the native Sessions pane, as close as practical to the T3 Code sidebar’s functionality and layout. The explicit priorities are separate Working jobs, reversible recently Settled history, Snooze, and keeping project filtering independent of list layout. Use subagents proactively.

## Local delivery gates

| Area | Acceptance |
| --- | --- |
| Extension mechanism | Plain Desktop ESM plugin using only documented SDK/React imports; a normal contributed left pane, not a native pane override, DOM patch or core-source modification. |
| Layout | Compact navigation sidebar, collapsible workflow sections, compact session rows, search/filter controls, selected-row state, row actions and discoverable menus. Compare against actual T3 sidebar source rather than its name alone. |
| Active versus Working | Authoritative runtime waiting/approval/question state takes precedence over Working and suppressed shelves. Running/starting sessions are separately visible and subdued. Runtime read failures are not misrepresented as confirmed idle. |
| Settled | Explicit timestamp controls recently-settled ordering. Restore is reversible. No native archival, history deletion or execution interruption. |
| Snooze | Presets and custom timestamp; absolute server-side deadline survives Desktop closure. Due eligibility requires no prompt or resumed agent. Document read-time wake reconciliation accurately. |
| Persistence | Profile-local backend metadata; transactional writes and concurrent updates preserve fields. Metadata actions require backend availability; no hidden local-only fallback. |
| Navigation | Existing sessions open in the normal Hermes workspace through supported actions. Compression lineage aliases retain metadata identity. |
| Routing | Selected connection/profile scope is explicit. Cache keys and stale async guards prevent data or mutations leaking across route switches. |
| Projects | Project filtering never implies selecting the workspace of a new chat. No fake project picker or dummy message to bypass missing draft SDK actions. |
| Safety | No install, production configuration change, service restart, commit or push in this task. No secrets, credentials or real transcript contents in fixtures. |
| Verification | Execute own plugin/backend tests and a browser-rendered interaction smoke when tooling permits. Record the exact commands, results and limitations. SDK-mocked browser rendering must not be called live Electron verification. |

## Explicit non-goals and SDK gaps

- Do not patch Hermes to add the missing project/cwd setter for a fresh native draft.
- Do not replace native conversation, model/provider, terminal, worktree or PR orchestration with a new app.
- Desktop client installation and authenticated live Electron verification are separate from creating the server-side repository artifact.
- Preserve local uncommitted delivery; publication and deployment need separate authorization.
