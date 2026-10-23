# Sidebar persistence and interaction refinements

## Requested behavior

- Preserve folded/unfolded Working, Snoozed and Archived categories through Desktop restarts, independently for each source and profile. Pinned and Ready remain headerless. A search temporarily reveals matching folded categories without modifying the saved preference.
- Use the native blue theme color for the Working card label while retaining the existing dimmed-card behavior.
- Keep an opened Snooze menu anchored when the pointer leaves and re-enters the sidebar, without revealing off-hover controls or moving the card title.
- Remove the redundant history/agent footer from row menus, the project-icon fill in cards and the project picker, and the picker's Cancel button. Native popover dismissal remains responsible for outside-click and Escape behavior.
- Do not show “All caught up” during a filtered search. Report “No matching sessions” only when the filtered loaded data actually has no matches, not merely when all matched categories are folded.
- Archive and Unarchive no longer create an Undo banner; use the opposite action in the list. Snooze, pin and restore Undo remain available. Native archive readback and partial-failure safeguards remain unchanged.
- Match the supplied category-heading reference: label and parenthesized count, a flexible thin divider, and a chevron at the far right. Keep fixed 24px headings outside their independently scrolling bodies.

## Reproduced defects

The focused Chromium regression failed against the original CSS when it compared the Snooze trigger's rectangle before and after leaving the sidebar: `.sf-hover { display:none }` removed the trigger from layout. The popup's positioning reference therefore lost its geometry. The correction must hide controls without destroying that rectangle; a popup-only mock that never recalculates on pointer leave would miss the underlying bug.

A second Chromium regression folded Working and Snoozed, reloaded the entire page, and failed because the categories reopened. The test harness now models the public SDK's namespaced JSON storage with browser storage so it exercises real document reloads rather than only React rerenders. Production uses `ctx.storage`, not browser globals. Reconnection epochs must not be included in the persistence key because they change while the source/profile identity remains the same.

## Verification scope

`npm test` covers the actual frontend controller and React tree plus real FastAPI/SQLite integration. `npm run test:backend` covers the companion. `npm run test:browser` uses Chromium with the actual production React tree and explicit SDK fixtures, including reloads, source switching, temporary search expansion, native-blue label styling, heading geometry, transparent icons, menu-anchor geometry and short-pane scrolling with Snooze Undo/error banners.

These checks do not establish live rendering inside the user's Windows Electron client. The installed SDK's native Popover wraps Radix and portals content outside the trigger; the harness popover is a test adapter. Verifying stable trigger geometry is the direct regression for the native positioning failure, not a claim that the native Radix implementation ran in the harness.

Final checks passed: **67 frontend/integration tests**, **59 backend tests**, and **91 Chromium checks**, with no browser page errors. Visual inspection confirmed the count/divider/chevron headings, blue Working status text without recoloring the card, transparent project glyphs, and absence of archive Undo banners. The short-pane checks still cover 300px/350px/400px with no banner, Snooze Undo, and Snooze Undo plus an error; dense 400px/650px fixtures preserve independent category scrolling.
