# Architecture and performance

[Back to the README](../README.md)

## Package layout

```text
hermes-t3sidebar/
├── plugin.yaml
├── __init__.py
├── dashboard/
│   ├── manifest.json
│   └── plugin_api.py
└── desktop/
    └── plugin.js
```

The Desktop half is plain ESM: no bundle, compile step or Hermes source changes. The companion stores organization metadata in the active Hermes profile’s `plugin-data/hermes-t3sidebar/state.sqlite3` and reads that profile’s native rich session list and authoritative runtime status. It uses Hermes’s authenticated plugin namespace, `/api/plugins/hermes-t3sidebar`.

The UI uses the supported Desktop SDK. The companion’s native session readers reuse **version-sensitive Hermes internals** for authenticated authority resolution and read-only rich listing; compatibility failures become explicit unavailable/unknown state rather than falling back to a process-wide runtime registry. A standalone dashboard without a native session authority cannot provide the Working/Waiting split.

## Performance

Local toolbar interactions avoid rebuilding every card, history lineage merges use an index, and verified actions no longer wait for an unrelated full-list refresh. Scoped lifecycle events refresh runtime only; history changes trigger broader reconciliation. The companion avoids writer transactions for ordinary metadata reads and keeps blocking standalone runtime reads off the event loop and outside the global session lock. Before/after measurements, regression coverage and remaining limitations are documented in [the performance report](performance.md).

Large sections mount only their visible cards plus a small overscan, retaining focused cards and open-menu owners. Counts, scroll ranges and keyboard ordering still cover every loaded session. Runtime classification uses an indexed join; organized-history recovery uses one bounded lookahead to avoid hundreds of native searches for archived metadata IDs. The [large-history report](large-history-performance.md) measures five hundred Ready plus five hundred Archived cards, both motion modes, search/filter clearing and backend reads.

Viewport height is cached from `ResizeObserver` after initial measurement, so ordinary scrolling and keyboard reveals do not repeatedly read `clientHeight`. Folding preserves the last positive height; older clients without the observer retain direct measurement as a fallback. Working uses a constant content-fit parent track and animates its own body track, retaining its empty/folded header and sparse-card fit. Dense Working stays capped during part of that intrinsic animation, so its easing differs slightly from the former calculated-height transition; this cleanup does not establish a new wall-clock speedup.
