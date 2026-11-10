# Security

KeepGreen runs an AI model against your app and your tests, so it is built on the assumption that
the model can be wrong or manipulated. Text on a page or in a test file could try to instruct it;
every prompt marks such text as data.

## What protects you

- **Your key, your runner.** KeepGreen has no server, no account and no telemetry. The only
  network calls go to the AI provider you choose, your own app, and (in CI) GitHub to open the PR.
- **Two jobs in CI.** The explore job, where AI-written tests run, has a read-only token and
  checks out with `persist-credentials: false`. It uploads the new tests as a patch. The publish
  job never runs your project's code. `keepgreen check-patch` accepts the patch only if it just
  **adds** plain test files (`*.spec.ts`, `*.test.js`, `*.cy.ts`, `test_*.py`, ...): no changes
  to existing files, no deletes, renames, mode changes or binary data, nothing under hidden
  folders such as `.github/`, nothing in `node_modules`, at most 10 files. Then git applies it
  with hooks off and the PR is opened.
- **Secrets stay out of test runs.** New tests, and an app started with `start-command`, run in a
  child process without the AI key or any GitHub / Actions token (AutoHeal's scrubbed engine
  environment).
- **New-test guard.** AutoHeal's `scanNewTest` rejects tests without real assertions, or with
  skips, faked network answers (`page.route`), injected scripts, fixed waits, `force: true`,
  extra retries or timeouts, file, environment or network access. A test must then pass every
  one of `runs` runs in a row. The scans are pattern based, so every test still arrives as a PR
  for a person to review.
- **Pages stay on your app.** Planning only opens the app URL and the paths you list in
  `pages:`; `cover` only opens pages on the same origin.
- **Spend cap.** One `max-usd` limit covers a whole explore run (planning plus every flow).

## Your part

- Use an AI key with a spend limit; it is present in the explore job.
- Run explore on your own branches only. The template runs on `workflow_dispatch` and an
  optional schedule, never on pull requests from forks.
- Review every KeepGreen PR like any other change.
- For the self-host bundle, put the servers behind HTTPS and keep `.env` out of git.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository
(Security > Report a vulnerability). Do not open a public issue.
