# Usage page

The sidebar footer's **Usage** button opens the `/t3sidebar-usage` page, modeled on T3 Code's Usage page and on the quota chart of Theo's CLIProxyAPI fork ("These 3 skills changed my life", https://www.youtube.com/watch?v=5Bmp9cz1JN8&t=496).

## Usage tab

Three charts on one time axis: tokens, API-equivalent cost and human user messages, over 24 h (hourly) or 7/30/90 days (daily, in the Desktop client's time zone). **Split** draws one series per provider or per model; **Mode** stacks the series or draws them independently from zero.

- Source: Hermes `session_model_usage` (exact totals per session × model × task), read strictly read-only through `GET /usage/history` (`usage_history.py`). No extra data is stored.
- Timing: Hermes keeps no per-call token counts, so each total is spread over the session's assistant messages (one per API call). Input-side tokens are weighted by the context size at each call and output-side tokens by the reply's size, both measured in characters. Totals are exact; placement within a bucket is approximate.
- Cost: every row is priced at the list price of the API it corresponds to (`openai-codex` → `openai`), including subscription traffic that Hermes records as $0 "included". Models without a known price count as $0 and are named under the charts.
- User messages: only messages typed by a person. Cron, internal and delegated subagent sessions are excluded (subagents often keep the parent's `desktop`/`tui` source, so they are identified by Hermes's `_delegate_from` marker), as are notifications Hermes injects into the user role.

## Limits tab

For each provider, a pooled chart sums every pool account's remaining percentage for one window (5-hour, weekly or a model-scoped window). Past samples are drawn as a solid area, then comes a **Now** line and a dashed projection. The projection drains at the pooled rate of the last six hours, uses accounts in pool priority order, and steps up when an account's window resets. Per-account rows below show each window with a pace tick and its reset time.

- Source: `GET /usage/limits` (`usage_limits.py`) reads samples from `<HERMES_HOME>/plugin-data/hermes-t3sidebar/usage-limits.sqlite3`, kept for 35 days.
- Sampling: a backend thread wakes every 5 minutes. It asks Hermes's native per-credential refresh to fetch each pool account's usage in read-only mode, then records the snapshot. That refresh never refreshes or rotates tokens, clears cooldowns or redeems banked resets. The thread starts on the first Desktop poll after a backend start and keeps sampling while Desktop is closed. Only `openai-codex` and `anthropic` credential-pool entries are sampled. A vetted provider whose pool is empty is shown as logged out.
