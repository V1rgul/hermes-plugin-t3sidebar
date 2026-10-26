# Backend-owned completion markers

## What Done means

Done indicates a newly completed successful turn recorded by the server-side plugin, independently of any Desktop connection. The shared marker is stored in the owning profile's plugin SQLite database and returned to every client through the companion's state API. It does not depend on a browser receiving `message.complete`, local plugin storage or native `unread: true`.

Previously the badge relied exclusively on backend unread. Native `last_read_at = NULL` means untracked/read, not unread; the read-only diagnostic found all five hundred recent human conversations in that state. Rendering tests seeded `unread: true` and therefore established appearance, not a working real completion lifecycle. The unfinished client-local draft was superseded before release: completion must work with every client closed and synchronize acknowledgments between clients.

## Evidence and ownership

- Record completions from the supported server-side agent lifecycle, not polling idle history, watching a frontend WebSocket or inferring completion from timestamps/message counts.
- Require explicit successful completion, a real turn identity and the owning profile/home's stored human conversation. Reject failure, interruption, missing ownership and internal/cron runs. Resolve compression lineage without modifying native history.
- Do not mistake an orchestrator's dispatch response for a final result while children are running. A later child finishing is not by itself proof that the parent has produced a new successful result.
- Persist only compact session/turn identifiers and backend completion time. Do not retain prompts, result text, composer contents or raw events.
- Keep Input, Working and Woke precedence independent. A parent with authoritative active children remains Working even if a prior unseen completion exists.

## Shared state and acknowledgment

The completion ledger shares the plugin's profile-scoped SQLite database but uses separate tables from organization metadata. Each marker contains `done_token` and `done_at`. Durable receipt deduplication prevents repeated delivery of the same lifecycle completion from recreating an acknowledged marker. No native read watermark or conversation timestamp is rewritten.

The state API returns a top-level `completions` map alongside the existing organization `sessions` map. Completion-only roots participate in native organized-history backfill so an old completed conversation remains discoverable. Read-only current-schema reads keep their fast path and snapshot consistency.

A client clears the exact observed generation with `ack_done` and its `done_token` only after successful native open or matching source/profile/lineage focus. A delayed acknowledgment of an older turn cannot clear a newer completion. A failed open cannot acknowledge anything. Acknowledgment is shared, so another client's next state refresh sees the cleared flag. It does not change pin/snooze/wake fields, create a missing organization row or advance unrelated due snoozes.

The backend can record successful completions while every Desktop client is closed. When one client is already viewing a conversation, it acknowledges a newly observed marker through the same shared API. There is no client-local completion fallback. Old idle history is deliberately not retroactively marked.

## Runtime coverage

The producer uses supported `pre_llm_call` and per-turn `on_session_end` plugin observers. Ordinary Hermes agent turns emit the completed/failed/interrupted outcome independently of client display. Hook delivery is best-effort and timeout-bounded; a process crash can lose an observation, and the plugin does not manufacture a success afterward from an idle session.

The inspected opt-in `api_mode: codex_app_server` path returns before the standard end hook and supplies no equivalent supported completion observer. It is not covered by this producer unless Hermes adds that lifecycle coverage. The `openai-codex` provider name alone does not imply this separate runtime mode. No core patch or private runtime replacement is installed to conceal the gap.

## Working time

Hermes's own in-flight turn start (`inflight_turn.started_at`, Desktop's chat timer source) is the primary source. The standalone runtime endpoint returns it as `turn_started_at`, captured under the registry lock and set before `message.start` is emitted, so the Working card and its time arrive together. A retained failed turn is not reported.

The hooks also record each human turn's start against the conversation root. `pre_llm_call` stores it under the same end fence as completion receipts, so a begin that finishes after its turn ended records nothing. `on_session_end` marks that exact turn ended for every outcome rather than deleting it; a newer turn of the same conversation stays open. The state API exposes only `runs: {root: {started_at, ended_at}}`; turn identities stay in the backend. Desktop uses it for a parent kept Working only by subagents (counting from its last turn, ended or not) and, on authority runtimes without a native start, for an open turn. A lost end observation (process crash, or the uncovered `codex_app_server` path) leaves an open start until the next turn replaces it; it is only displayed while runtime status independently reports Working.

## Verification scope

Exercise the actual hook with an isolated native profile store and no connected UI. Verify completion persistence, duplicate suppression, profile/lineage ownership, failure/interruption/internal-source exclusion and delegated-parent behavior. Two independent API clients must observe one shared marker, and acknowledgment by one must clear it for the other without erasing a newer generation.

Frontend/browser regressions must start with backend `unread: false`, consume the server-provided completion map and verify Done through the production React tree. Cover read-clear, failed open, exact acknowledgment generations, native focus, status precedence, source/profile fences, retained search focus and absence of Undo UI. SDK-mocked Chromium does not establish live Windows/Electron behavior.

The combined `npm run test:all` gate passed 155 frontend/integration tests, 134 backend tests and 165 browser checks, without skipped tests. This includes native plugin-hook dispatch against isolated profile stores with no UI, real FastAPI/SQLite integration with two independent client caches, and a Chromium screenshot of a server-owned Done marker while native backend unread is false.
