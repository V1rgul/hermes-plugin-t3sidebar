# Search, Working height and composer-draft refinements

## Search and editing controls

Search does not automatically unfold Snoozed or Archived. Their filtered counts remain in the headings, manual expansion works during search, and matching folded shelves do not generate a false no-results message. Working may still temporarily expand for matching searches without overwriting saved folds.

An explicit Clear search cross is visible for any nonempty input, including whitespace, independently of hover/focus. Clicking it clears the input and returns keyboard focus there. The browser's hover-only search decoration is suppressed to avoid duplicate crosses. Input, Working and Done labels are semibold. Rename submits with Enter or a checkmark directly beside the text field, not a bottom text button.

## Content-sized Working

Working's track is capped by its actual header plus card heights instead of claiming unused fractional space. It retains a pane-relative ceiling and an independently scrolling body for large lists. An empty Working shelf contains just its fixed header. The remaining room goes to the other tracks, including the larger Archives shelf. No Hermes source changes are involved.

The initial Chromium regression failed with one Working card because its shelf exceeded the header-plus-card height. Browser cases cover zero, one and two Working cards in a tall pane, plus existing dense/short-pane category geometry and animated folding.

## Composer text

The installed public SDK provides `host.composer.getDraft(sessionId)`, exported through `sdk/index.ts` and implemented in `sdk/composer.ts`. Mounted composers answer with their current text; absent surfaces fall back to the native persisted text stash. `takeSessionDraft` is a read-only clone despite its name. The plugin does not call setDraft, insertText or submit, inspect native DOM, or read private storage.

A nonempty text draft produces a dim theme-orange card background only for an unfocused session. Focusing that session immediately restores its normal selected background without discarding draft presence. Query results retain only a boolean; composer contents are not logged, sent to the backend or copied into plugin storage. Focused drafts are refreshed with the host query scheduler, while inactive rows use cached/on-focus reads rather than polling every loaded history card. Folded bodies do not poll. The public method returns text only, so attachment-only drafts are not claimed detectable by this feature. Availability depends on the user's installed Desktop SDK; older clients fail safely without draft highlighting.

## Empty cards and project controls

Confirmed zero-message sessions with no meaningful title or preview display **New session**. When no project is assigned, the card omits the unavailable-project placeholder; known project metadata and meaningful titles remain visible. Unknown message history is not treated as confirmed empty.

The new-session picker omits Home and its unsupported-creation explanation, while retaining supported named-project creation. Clicking Filter sessions opens project choices directly rather than a second select control. Selecting a project closes the picker, marks the selected choice and replaces the toolbar filter glyph with the selected project's icon; All projects restores the generic filter glyph. Filtering does not change the native workspace.

## Running subagents

The runtime snapshot includes a read-only `running_subagents` count. A positive integer adds a Working signal to the parent session across its compression aliases. The existing Waiting, native archive and Snoozed precedence remains intact. Counts are replaced from snapshots rather than accumulated from events, so remounts need no event replay and the last child's completion/cancellation clears the signal on refresh. Unknown counts never classify a session as Working. Start/completion events request a refresh; streamed child text and thinking do not fan out snapshot or draft reads.

With the Detailed Working indicator setting on, the Working badge displays the count as `+N` (summed across the card's runtimes, a repeated runtime counted once). Display, unlike classification, keeps the last known value: a failed poll keeps the whole last snapshot, and a runtime whose count reads as unknown on a successful poll keeps showing its previous count. That memory is per source/profile/epoch and forgets runtimes that leave the snapshot. A card with no known count shows only its elapsed time.

The runtime snapshot also carries `compacting`: true for a manual `/compress` (the native session flag) or while an automatic compaction's activity heartbeat is running on the live agent (provenance `agent.compression` with the native "started"/"in progress" stamps; its "completed"/"failed" stop stamp and any later activity clear it). Authority rows report null. Only the detailed Working indicator uses it, and only for cards already Working; it never affects classification.

## Confirmed deletion

The right-click Delete session action opens the public SDK's `ConfirmDialog`, the same component used by native session deletion. Cancel performs no write. Confirmation reads an exact, profile-qualified native mutation snapshot through the read-only companion, then issues routed `session.mutate` with operation `delete`, explicit empty payload, a retained request ID and the snapshot's revision/generation. The plugin validates the receipt and reads back every returned deleted ID as explicitly absent before confirming success. A lost reply retries the original request rather than generating fresh fences. Source/profile/epoch changes fence every await.

Busy or unknown sessions are refused rather than implicitly interrupted; unsaved runtime-only drafts have no stored row and retain an explicit native-close limitation. A verified deletion of the still-focused session opens a fresh draft through public `host.newChat`. The user accepted reduced cleanup: this does not invoke Desktop's private tab/prompt/journal cleanup or the native HTTP endpoint's transcript/request-dump file scrub. Native session history is deleted, but this is not a promise that all local files/caches have been erased.

## Unread boundary and timestamp rejection

Read-only inspection of the user-reported Question request found one native row with no compression descendants. The native rich listing, plugin card projection and plugin listing all returned `unread: false`; its native read watermark was null. The plugin did not drop a true unread flag.

Desktop separately reconstructs unread from profile/lineage-scoped seen-message counts and explicit background-completion markers. The native status map combines those with backend unread. Its computed value is not exposed through the inspected public SDK, although its dot component is exported. This explains the screenshot discrepancy without treating completed history as unseen.

The user declined a Hermes SDK/source change. Runtime last_active cannot replace the unavailable local unread value: normal resume refreshes it, but agent activity, reconnect/reattach and internal session-info paths also refresh it. It is neither a read-only watermark nor persistent proof of human viewing. No timestamp heuristic, native state rewriting or parallel unread tracker is introduced. Exact native-green-dot/Done parity remains an explicit limitation.

## Executed checks

The integrated `npm run test:all` gate passed **103 frontend/integration tests**, **84 backend tests**, and **137 Chromium checks**. Browser checks establish sparse Working content sizing, persistent search controls, folded Snoozed/Archived behavior, icon-only rename geometry, bold labels, unfocused-only orange draft tint and focus transitions, boolean-only draft caches, focused clearing/polling, friendly empty cards, direct project filtering, Home-free new-session choices, running-child Working classification, Delete confirmation/cancellation/error/readback, existing category animation, independent scrolling, and short-pane Undo/error geometry. Draft/controller tests also cover unsupported SDKs, whitespace, failed reads, compression-tip addressing, source/profile/epoch changes and disposal. Backend tests exercise actual native subagent ownership projections and canonical deletion/receipt replay against isolated scratch stores; the companion remains read-only against native history. No real user session was deleted during verification.

Chromium renders the real plugin tree with explicit synthetic SDK fixtures; this is not live verification of the user's Windows Electron installation. The Desktop UI half must be updated separately from the remote backend package.
