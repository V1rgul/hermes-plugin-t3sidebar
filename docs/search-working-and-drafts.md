# Search, Working height and composer-draft refinements

## Search and editing controls

Search does not automatically unfold Archived. Its filtered count remains in the heading, manual expansion works during search, and matching folded archives do not generate a false no-results message. Working/Snoozed may still temporarily expand for matching searches without overwriting saved folds.

An explicit Clear search cross is visible for any nonempty input, including whitespace, independently of hover/focus. Clicking it clears the input and returns keyboard focus there. The browser's hover-only search decoration is suppressed to avoid duplicate crosses. Input, Working and Done labels are semibold. Rename submits with Enter or a checkmark directly beside the text field, not a bottom text button.

## Content-sized Working

Working's track is capped by its actual header plus card heights instead of claiming unused fractional space. It retains a pane-relative ceiling and an independently scrolling body for large lists. An empty Working shelf contains just its fixed header. The remaining room goes to the other tracks, including the larger Archives shelf. No Hermes source changes are involved.

The initial Chromium regression failed with one Working card because its shelf exceeded the header-plus-card height. Browser cases cover zero, one and two Working cards in a tall pane, plus existing dense/short-pane category geometry and animated folding.

## Composer text

The installed public SDK provides `host.composer.getDraft(sessionId)`, exported through `sdk/index.ts` and implemented in `sdk/composer.ts`. Mounted composers answer with their current text; absent surfaces fall back to the native persisted text stash. `takeSessionDraft` is a read-only clone despite its name. The plugin does not call setDraft, insertText or submit, inspect native DOM, or read private storage.

A nonempty text draft produces a dim theme-orange card background. Query results retain only a boolean; composer contents are not logged, sent to the backend or copied into plugin storage. Focused drafts are refreshed with the host query scheduler, while inactive rows use cached/on-focus reads rather than polling every loaded history card. Folded bodies do not poll. The public method returns text only, so attachment-only drafts are not claimed detectable by this feature. Availability depends on the user's installed Desktop SDK; older clients fail safely without draft highlighting.

## Unread boundary and timestamp rejection

Read-only inspection of the user-reported Question request found one native row with no compression descendants. The native rich listing, plugin card projection and plugin listing all returned `unread: false`; its native read watermark was null. The plugin did not drop a true unread flag.

Desktop separately reconstructs unread from profile/lineage-scoped seen-message counts and explicit background-completion markers. The native status map combines those with backend unread. Its computed value is not exposed through the inspected public SDK, although its dot component is exported. This explains the screenshot discrepancy without treating completed history as unseen.

The user declined a Hermes SDK/source change. Runtime last_active cannot replace the unavailable local unread value: normal resume refreshes it, but agent activity, reconnect/reattach and internal session-info paths also refresh it. It is neither a read-only watermark nor persistent proof of human viewing. No timestamp heuristic, native state rewriting or parallel unread tracker is introduced. Exact native-green-dot/Done parity remains an explicit limitation.

## Executed checks

The final `npm run test:all` gate passed **86 frontend/integration tests**, **67 backend tests**, and **122 Chromium checks**. Browser checks establish sparse Working content sizing, persistent search controls, folded Archived behavior, icon-only rename geometry, bold labels, orange draft tint without hover, boolean-only draft caches, focused clearing/polling, existing category animation, independent scrolling, and short-pane Undo/error geometry. Draft/controller tests also cover unsupported SDKs, whitespace, failed reads, compression-tip addressing, source/profile/epoch changes and disposal.

Chromium renders the real plugin tree with explicit synthetic SDK fixtures; this is not live verification of the user's Windows Electron installation. The Desktop UI half must be updated separately from the remote backend package.
