# Usage page

The sidebar footer's **Usage** button opens the `/t3sidebar-usage` page, modeled on T3 Code's Usage page and on the quota chart of Theo's CLIProxyAPI fork ("These 3 skills changed my life", https://www.youtube.com/watch?v=5Bmp9cz1JN8&t=496).

## Usage tab

Three charts on one time axis: tokens, API-equivalent cost and human user messages, in roughly 500 buckets per period: 24 h in 3-minute buckets, 7/30/90 days in 20-minute, 90-minute and 4-hour buckets from local midnight (in the Desktop client's time zone, ending with the bucket in progress). Every chart plots a rate per day, each bucket scaled by its real length (a DST day stretches or shrinks one bucket by an hour); tooltips also give the bucket's raw amount. **Split** draws one series per provider or per model; **Mode** stacks the series or draws them independently from zero.

- Source: Hermes `session_model_usage` (exact totals per session × model × task), read strictly read-only through `GET /usage/history` (`usage_history.py`). No extra data is stored.
- Timing: Hermes keeps no per-call token counts, so each total is spread over the session's assistant messages (one per API call). Input-side tokens are weighted by the context size at each call and output-side tokens by the reply's size, both measured in characters. Totals are exact; placement within a bucket is approximate.
- Cost: every row is priced at the list price of the API it corresponds to (`openai-codex` → `openai`), including subscription traffic that Hermes records as $0 "included". Models without a known price count as $0 and are named under the charts.
- User messages: only messages typed by a person. Cron, internal and delegated subagent sessions are excluded (subagents often keep the parent's `desktop`/`tui` source, so they are identified by Hermes's `_delegate_from` marker), as are notifications Hermes injects into the user role.

## Limits tab

For each provider, a pooled chart sums every pool account's remaining percentage for one window (5-hour, weekly or a model-scoped window). Past samples are drawn as a solid area, then comes a **Now** line and a dashed projection. The projection drains at the pooled rate of the last six hours, uses accounts in pool priority order, and steps up when an account's window resets. Per-account rows below show each window with a pace tick and its reset time.

- Source: `GET /usage/limits` (`usage_limits.py`) reads samples from `<HERMES_HOME>/plugin-data/hermes-t3sidebar/usage-limits.sqlite3`, kept for 35 days.
- Sampling: a backend thread wakes every 5 minutes. It asks Hermes's native per-credential refresh to fetch each pool account's usage in read-only mode, then records the snapshot. That refresh never refreshes or rotates tokens, clears cooldowns or redeems banked resets. The thread starts on the first Desktop poll after a backend start and keeps sampling while Desktop is closed. Only `openai-codex` and `anthropic` credential-pool entries are sampled. A vetted provider whose pool is empty is shown as logged out, except Anthropic: with an empty Hermes pool it falls back to Claude Code's own login on the host (`$CLAUDE_CONFIG_DIR` or `~/.claude`), the account the Claude Code-based provider plugin actually consumes. That token is only read and passed to Hermes's OAuth usage fetcher (one GET per sample, never refreshed or stored); an expired one is skipped until Claude Code refreshes it, and the plan comes from its `rateLimitTier`.
- Banked resets: Codex's usage response only counts banked reset credits, so at most once an hour per account the sampler also reads Codex's credit list (`/wham/rate-limit-reset-credits`, read-only, with the account's own token; a 401 is not refreshed). Only each credit's status, grant and expiry times are stored, plus how many could be redeemed right now. Nothing is ever redeemed.
