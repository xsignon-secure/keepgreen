# Changelog

## 0.1.0

First release.

- `keepgreen explore`: looks at your app (playwright-e2e-mcp `inspect-page`), reads which tests already exist, asks your AI for the most important user flows with no test, and writes a test for each with AutoHeal's `cover`. A test is kept only if it passes the new-test guard (real assertions, no fakes, skips or fixed waits) and runs green several times in a row. One spend cap covers the whole run.
- `keepgreen heal`: AutoHeal's local `fix` (run the tests, fix what broke, leave the changes for review).
- `keepgreen init`: writes `.keepgreen.yml`, the explore workflow (read-only explore job + publish job that only accepts new test files) and AutoHeal's heal workflow.
- `keepgreen doctor`, `keepgreen autoheal <command>`, `keepgreen check-patch`.
- GitHub Action (`xsignon-secure/keepgreen@v0.1.0`) and a Docker Compose bundle for the self-hosted history server and AutoHeal dashboard.
