# Changelog

## 0.1.1

- OpenRouter and other OpenAI-compatible endpoints in the GitHub Action: new `base-url`, `api-key`, `price-in` and `price-out` inputs (the template shows them commented out). The README has an OpenRouter section.
- `keepgreen explore` sets `KEEPGREEN=1` for the app and the tests, so a Playwright `webServer` can reuse the app KeepGreen started: `reuseExistingServer: !process.env.CI || !!process.env.KEEPGREEN`. Without it, Playwright stops in CI with "port already in use".
- Explore workflow template: a blank `max-flows` input now keeps the value from `.keepgreen.yml` (it used to force 3).
- A refused AI request (no credit, bad key) now prints a short reason and what to do, instead of a stack trace.
- First release published from CI with npm provenance (0.1.0 was published by hand).

## 0.1.0

First release.

- `keepgreen explore`: looks at your app (playwright-e2e-mcp `inspect-page`), reads which tests already exist, asks your AI for the most important user flows with no test, and writes a test for each with AutoHeal's `cover`. A test is kept only if it passes the new-test guard (real assertions, no fakes, skips or fixed waits) and runs green several times in a row. One spend cap covers the whole run.
- `keepgreen heal`: AutoHeal's local `fix` (run the tests, fix what broke, leave the changes for review).
- `keepgreen init`: writes `.keepgreen.yml`, the explore workflow (read-only explore job + publish job that only accepts new test files) and AutoHeal's heal workflow.
- `keepgreen doctor`, `keepgreen autoheal <command>`, `keepgreen check-patch`.
- GitHub Action (`xsignon-secure/keepgreen@v0.1.0`) and a Docker Compose bundle for the self-hosted history server and AutoHeal dashboard.
