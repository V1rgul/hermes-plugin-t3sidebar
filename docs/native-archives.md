# Native archives: read-only companion API

The Archived shelf is native Hermes archival, not the plugin's legacy `settled` metadata. Sessions archived in another Hermes client appear without any plugin metadata. There is no metadata migration. The Python companion is read-only toward native history; user-triggered frontend actions use Hermes's native archive RPC.

All paths below are relative to the authenticated `/api/plugins/hermes-t3sidebar` namespace. The host establishes the owning profile/home before the handler runs. An optional `profile` query is an exact assertion of that profile, not a selector; repeated values must all match. Unknown query parameters are rejected (422). Successful reads return `Cache-Control: no-store`.

## Listing

`GET /archives?offset=0&limit=500`

Returns `{profile, sessions, offset, limit, has_more}`. Offset must be nonnegative; limit is 1–500. `has_more` uses the same bounded-page convention as `/sessions`: a full page means another page may exist, so a final empty page can be necessary.

The Desktop plugin requests 100 rows for the first archive page, then 500-row pages starting at offsets 100, 600 and onward. The first page retains the existing five-second recovery poll. Older loaded pages are cached separately for up to 30 seconds; history events invalidate them, and a changed page's ordered membership invalidates its later offsets to reconcile shifts. One aggregate cache entry per feed replaces pagination-depth prefixes. The HTTP endpoint remains uncached and retains its 500-row default for other callers. No new socket, event payload or delta protocol is introduced.

The reader opens the exact profile's native SessionDB with `read_only=True` and invokes native `list_sessions_rich` with `archived_only=True`, compact rows, last-active ordering, and internal/cron source exclusion **before** native LIMIT/OFFSET. Native archived-only semantics intentionally recover archived-and-hidden sessions even though ordinary listings exclude hidden rows. There is no manual post-filter pagination or organization backfill for archives.

Both `/sessions` and `/archives` card rows include an `archived` JSON boolean. Rich project, branch, provider, model, timestamps, unread, compression lineage and conversation token metadata retain the ordinary listing projection. Provider evidence comes from the tip's explicit model configuration; tokens are summed once per lineage segment. Raw model configurations/system prompts are not exposed. `/sessions` continues excluding native archives, including its organized-row backfill.

## Exact archive-state verification

`GET /sessions/{session_id}/archive`

Returns `{profile, id, archived}` with `id` exactly equal to the validated requested ID. The native reader uses `_get_session_rich_rows_batch([session_id], compact_rows=True)` and an exact dictionary lookup. It does not resolve aliases, titles, substrings, or foreign lineage roots. A missing stored ID is 404 (`session_not_found`), never a fabricated `archived: false`. An unavailable/incompatible native store is 503. Only the optional exact-profile assertion is accepted on this endpoint.

The frontend owns mutations through native `session.archive`, passing the durable stored lineage root and an explicit `archived` boolean. Installed native `tui_gateway/methods_session.py` applies this to the lineage without submitting a prompt or stopping execution. After the RPC, the frontend can verify the exact root's persisted state through the readback endpoint. The plugin exposes no native archive mutation route.

Unarchive changes only the archive flag, not Hermes's independent hidden flag. An archived-and-hidden conversation is recoverable in the archive feed, but after Unarchive it remains excluded from ordinary listings while hidden. This native visibility behavior is not an archive-readback failure; the plugin does not silently unhide Bot Mode or other hidden conversations.

## Compatibility and tests

Legacy plugin `settle`/`restore` metadata actions remain for backward compatibility; their data store and behavior are unchanged. They do not set or clear native archive flags.

`create_router` accepts independent `archives_reader(profile, offset, limit)` and `archive_reader(profile, id)` test injections. Existing ordinary `sessions_reader` injections retain their four-positional-argument contract.

Run `npm run test:backend`. `tests/test_archives.py` uses real scratch native databases for compression root/tip archival, rich metadata, archive readback/restoration, archives created elsewhere, hidden recovery, cron/internal pre-pagination filtering, exact-ID false-positive rejection, profile assertions, and native byte-preservation checks. Native archive writes in these tests are fixture setup only, with `notify=False` so native archive lifecycle hooks do not load real profile plugins. No deployment or live-history writes are required.
