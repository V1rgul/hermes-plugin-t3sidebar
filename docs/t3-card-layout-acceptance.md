# T3 card and section layout acceptance

This amendment supersedes the initial compact/detail-row design. Preserve the existing uncommitted, verified profile-query and standalone-runtime fixes.

## Screenshot contract

Reference images supplied by the user:

- `upload_3bnroerb.png`: two-line card, project icon/name at top-left, provider logo/token count/relative last update or Working at top-right, session title on the lower line.
- `upload_373es89t.png`: one horizontal toolbar, Search with magnifier on the left; filter, folder-plus and square-pen new-session controls on the right. No extra plugin heading, second controls bar or persistent scope line.

- `upload_walqtj7a.png`: while hovered, show an icon-only clock/Snooze control and a checkmark plus “Settle” control at the card’s top-right. Hide both controls completely when the card is not hovered; preserve the lower title line. Snooze opens its time choices, while Settle performs the existing reversible settlement action.

Provider and token metadata are additional explicit user requirements even when absent from the reference crop. Missing metadata must remain visibly unknown rather than being inferred from the model name. Displayed tokens mean input plus output across unique compression segments and the delegated subagent sessions they spawned; do not double-count cache/reasoning categories.

## Required removals and filtering

- No cron runs in recent pages, older pages, organized backfill, runtime-derived rows or SDK fallback rows.
- No compact/detail-row toggle or mode.
- No connection/profile/current-scope line.
- No “New session uses native workspace selection” footer.

## Section sizing amendment

- Pinned precedes Ready, has no visible title or header, and exists only when there are pinned conversations. Pinned cards place an outline pin icon immediately after the project icon and before the project name.
- Ready has no visible title or header and uses the remaining space.
- Working, Snoozed and Settled headings remain visible even when Ready has many sessions.
- Each category body scrolls independently when its content cannot fit. Do not use a single scrolling region for the entire list.
- Pinned/Working/Snoozed/Settled receive layout space before Ready; they also shrink their bodies into inner scroll areas when required. Their headers must remain outside those scrollers.

## Project creation

The new-session button opens a project selector before creating or sending anything. Include the native synthetic Home option (`__no_project__`, no project path), even when the native tree omits an empty Home bucket. A selection must establish the actual session workspace before its first message, without fake prompts, global grouping changes, DOM manipulation or Hermes core patches. Prove any plugin-owned create/open handoff against native workspace metadata/events before calling it complete; if public contracts cannot support it, record the exact remaining boundary instead of making a decorative selector.

## Verification and delivery boundaries

Use browser geometry/scroll tests at constrained heights to establish toolbar/card alignment and independently visible section headers. Preserve the native conversation workspace and all prior routing, waiting, snooze and settlement behavior. Local changes do not authorize commit, push, installed-plugin replacement, client updates or service restarts.
