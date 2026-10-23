# Development

[Back to the README](../README.md) · [Architecture](architecture.md)

Frontend tests use Node’s test runner and render the actual React tree. Backend tests use Python’s `unittest` and a real FastAPI test client. The HTTP integration test connects the frontend controller to the real Python API and SQLite store. Browser tests render the real plugin in Chromium with explicitly synthetic SDK/session fixtures; they do **not** establish live Electron compatibility.

```sh
npm ci --ignore-scripts --no-audit --no-fund && npm run test:all
```

Python test dependencies are listed in `requirements-dev.txt`; Hermes already provides the production FastAPI/Pydantic environment. The browser smoke uses an installed Chromium from the Playwright cache or `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. If neither exists, install the matching development browser with `npx playwright install chromium`; the tests never silently download one.

To inspect the rendered sidebar with synthetic data:

```sh
npm run harness
```

Open `http://127.0.0.1:4173`. The right-hand panel is a labeled test workspace, not an alternative chat implementation. Generated screenshots are written to `artifacts/`.

The production plugin itself needs none of these Node development dependencies or generated bundles.

SDK reference: https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk

Current rename verification is in [`docs/rename-verification.md`](rename-verification.md). Earlier review/remediation/verification reports under `docs/` are historical evidence for the original Session Flow candidates; their names, outputs and hashes do not validate the renamed bytes.
