# Card attention states, actions and animated categories

## Behavior

The contributed pane title is `t3sidebar`. Package identity, backend URLs, query keys and persisted storage remain `hermes-t3sidebar`.

The rightmost card position displays Input (purple question bubble), Working (blue), Woke (orange alarm) or Done (green checked circle), ahead of the ordinary conversation age in that precedence order. Input covers authoritative human-input waiting, including questions and approvals. Done uses the backend's exact boolean `unread` field, as explicitly selected by the user; it does not guess from session age, activity or an assumed completion. Backend unread is a native input but not the whole Desktop-local completion-marker store. No private unread atom, native DOM inspection or localized-label matching is used. Attention titles are bold. Project/ordinary age use secondary text contrast; provider and tokens retain tertiary contrast.

Snooze and Archive remain direct hover controls; archived cards omit Snooze altogether. The right-click menu contains Pin/Unpin, Restore for a snoozed thread, Rename, Copy session ID and Filter by the row's exact project. Lists stay flat. The custom-time input submits with Enter or its adjacent checkmark, without the old bottom text button.

Rename is enabled only for one confirmed live runtime. The controller rediscovers that runtime on the owning route before writing `session.title`, then calls the same method without a title to read back both the saved title and matching stored lineage key. Pending, dropped, foreign-lineage and switched-source results do not become confirmed saves. Stored-only threads explain the live-runtime limitation. Clipboard operations use public `ctx.os.writeClipboard`; a false result is an error, not a success. Project shortcuts change only this pane's exact cwd filter.

## Durable wake markers

The companion adds nullable `woke_at` to its own SQLite table under the existing immediate writer transaction. Due normalization preserves the original deadline there while returning the row to active. Pins retain the marker; explicit restore, settlement or a new snooze clears it. Native conversation history is never migrated or mutated by the companion.

A successful native open or matching source/profile/lineage focus acknowledges the exact observed marker with `ack_wake`. Compare-and-clear prevents a delayed acknowledgment from clearing a newer wake. Acknowledgment creates no missing metadata row, changes no organization timestamp, and does not sweep a different newly due snooze. Failed opens and foreign focused owners do not acknowledge Woke. The frontend deduplicates simultaneous open/focus acknowledgments and does not create an Undo banner or discard existing pin/snooze Undo.

## Recency correction

The old frontend took the maximum of stored conversation activity and runtime `last_active`. Native resume calls `_live_session_payload(..., touch=True)`, which refreshes the runtime clock on a normal open. That made merely viewing an old thread show “now” and could reorder it. The regression failed with runtime activity 9999 replacing stored activity 100. The corrected card uses persisted conversation activity; genuine persisted progress still updates the age and ordering. Runtime-only drafts retain their own available timestamps. No Hermes core patch or native timestamp rewrite is involved.

## Layout and motion

The list uses five explicit grid tracks with non-scrolling outer bounds and independently scrolling category bodies. Expanded populated Archives receives a larger flexible weight than Ready or the other shelves; dense fixtures give it roughly half the available list height. Every secondary track reserves its fixed 24px header plus positive open-body space, even when error/Undo banners reduce a 300px pane.

CSS interpolates the actual grid tracks over 220ms for folding/unfolding. Retained closed bodies are inert and aria-hidden; their opacity/visibility transitions accompany the size change. Reduced-motion disables transitions. Chromium tests sample intermediate category heights in both directions and verify a rapid reversal settles without stuck/inert content.

## Executed checks

- `npm test`: 77 frontend/integration tests passed, including real loopback FastAPI/SQLite wake acknowledgment.
- `npm run test:backend`: 67 tests passed, including old six-column database migration, stale wake generations, exact/idempotent acknowledgment, invalid payloads and profile isolation.
- `npm run test:browser`: 109 Chromium checks passed, including semantic colors/icons/bold titles, exact live rename readback, clipboard/project shortcuts, Woke/read lifecycle, unchanged age after reopen, real folding size animation, rapid reversal, reduced motion, larger Archives share, isolated scrolling and 300px/350px/400px Undo/error geometry.

The browser harness renders the actual plugin React tree with explicitly synthetic SDK fixtures. It does not establish live rendering inside the user's Windows Electron client; its Desktop UI installation remains a separate target from the remote backend.
