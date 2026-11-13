# Changelog

## 0.2.0

Fixes from a full audit, plus the most-asked-for features.

- **Explore a deployed app.** `--url` (and `url:`) now accepts any http(s) address, such as a staging or preview deployment. 0.1.x refused anything but localhost with a message about `start-url`. An app KeepGreen starts itself (`start-command`) must still be on this machine. Point it at a test environment, not production.
- **Name the flows yourself.** `keepgreen explore --flow "A shopper adds the mug to the cart and the cart shows 1"` skips the AI planning and writes a test for each flow you name (repeat `--flow`). The Action has a `flows` input (one per line) and the workflow template a `flows` box (separated by `;`).
- **No more lost tests from name clashes.** Test file names were the first six words of the flow, so two flows starting "A visitor opens the home page..." got the same name and AutoHeal refused the second one. Names now skip filler words (`keepgreen-opens-home-clicks-account-link-lands.spec.ts`) and get `-2`, `-3` when a name is already taken, on disk or earlier in the run.
- **max-usd works on OpenRouter without setting prices.** For an OpenRouter `base-url`, KeepGreen looks up the model's price in OpenRouter's public model list. Before, a model with no listed price ran with only a token cap. When no price can be found, explore now says so up front.
- **Weekly runs don't pile up.** A scheduled explore run stops when a KeepGreen PR is still open, instead of planning the same flows again. Manual runs always go ahead.
- **CI runs on KeepGreen's PRs.** GitHub starts no workflows on a PR opened with the built-in token. Add an optional `KEEPGREEN_PR_TOKEN` secret (a fine-grained token for this repo) and the publish job uses it, so your checks run. Re-running the publish job no longer fails on an existing branch.
- **PR bodies can't ping people.** `@name` in AI-written flow text is defused before it goes into the report.
- `summary.json` now lists each flow's result (status, file, reason) and whether the spend is priced.

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
