# KeepGreen

**Your AI test agent that writes, fixes and keeps your end-to-end tests green.**

KeepGreen is free and MIT licensed. It runs on your own CI runner or laptop with your own AI key
(Anthropic, OpenAI or any OpenAI-compatible endpoint, including local models). There is no
KeepGreen server, no account and no telemetry. You pay only your AI provider, and one spend cap
covers every run.

It combines two XSignOn projects into one agent:

- [playwright-e2e-mcp](https://github.com/xsignon-secure/E2E) is the toolbox. It opens pages,
  finds stable locators, runs tests and reads failures.
- [AutoHeal](https://github.com/xsignon-secure/AutoHeal-AI) is the guarded fixer and test writer,
  with its anti-cheat guard and stability proof.

| Recipe | What it does | Command |
| --- | --- | --- |
| **Explore** | Looks at your app, picks the most important user flows that have **no test yet**, and writes a test for each. A test is kept only if it makes real assertions and passes every run (5 by default). | `npx keepgreen explore` |
| **Heal** | Runs your tests, finds what broke, fixes it and proves the fix. App bugs are reported, not "fixed". | `npx keepgreen heal` (local) · AutoHeal workflow (CI) |

Works with Playwright Test and pytest-playwright. Healing also covers Cypress and WebdriverIO.

## Quick start (your machine)

```bash
npm install -D keepgreen              # or use npx keepgreen ... without installing
export ANTHROPIC_API_KEY=sk-ant-...   # your own key
npx keepgreen init                    # writes .keepgreen.yml + workflows, checks your setup
npx keepgreen explore --url http://localhost:3000
```

Explore prints a table of the flows it tried and which tests it kept. New files are named
`tests/keepgreen-<flow>.spec.ts`. Review them with `git diff` and commit the ones you like.

Try it without writing anything first:

```bash
npx keepgreen explore --url http://localhost:3000 --dry-run   # plan only: shows the flows it would test
```

Let KeepGreen start your app:

```bash
npx keepgreen explore --start-command "npm run dev" --start-url http://localhost:3000
```

Fix broken tests:

```bash
npx keepgreen heal          # = AutoHeal's `autoheal fix`; changes stay in your working tree for review
```

## In GitHub Actions

`npx keepgreen init` writes two workflows:

- **`.github/workflows/keepgreen-explore.yml`** runs from *Actions > KeepGreen explore > Run
  workflow*, or weekly if you uncomment the schedule. It opens **one PR** with the new tests that
  passed. It has two jobs. The explore job runs the AI-written tests with a read-only token. The
  publish job accepts the result only if it just adds test files, then opens the PR.
- **`.github/workflows/autoheal.yml`** is written by AutoHeal's own `init`. It runs after your
  test workflow fails and opens a fix PR.

Then:

1. Add `ANTHROPIC_API_KEY` as a repository secret. For OpenAI, add `OPENAI_API_KEY` and a
   repository variable `AUTOHEAL_MODEL`.
2. Go to *Settings > Actions > General > Workflow permissions* and tick "Allow GitHub Actions to
   create and approve pull requests".
3. Make the explore job's install steps match your test workflow (Node or Python, browsers,
   services).

You can also use the action directly:

```yaml
- uses: xsignon-secure/keepgreen@v0.1.1
  with:
    url: http://localhost:3000
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
# leaves keepgreen-out/ (report.md, summary.json, new-tests.patch); output `written` = tests kept
```

## Settings

`.keepgreen.yml` at the repo root. Command-line flags override it.

```yaml
url: http://localhost:3000        # the running app, or:
# start-command: npm run dev
# start-url: http://localhost:3000
pages:                            # extra pages to look at when choosing flows
  - /login
  - /pricing
max-flows: 3                      # new tests per explore run (1-10)
max-usd: 3                        # AI spend cap for one explore run
runs: 5                           # passing runs in a row a new test needs (2-20)
framework: auto                   # auto | playwright | pytest | cypress | webdriverio
```

AI settings use AutoHeal's variables:

| Variable | Meaning |
| --- | --- |
| `ANTHROPIC_API_KEY` | Use Anthropic (default model `claude-opus-5-5`) |
| `OPENAI_API_KEY` + `AUTOHEAL_MODEL` | Use OpenAI |
| `AUTOHEAL_BASE_URL` + `AUTOHEAL_MODEL` (+ `AUTOHEAL_API_KEY`) | Any OpenAI-compatible endpoint: OpenRouter, or Ollama at `http://localhost:11434/v1` |
| `AUTOHEAL_EFFORT` | Anthropic effort: `low` … `max` (default `medium`) |
| `AUTOHEAL_PRICE_IN` / `AUTOHEAL_PRICE_OUT` | USD per 1M tokens, for models without a listed price |

### OpenRouter (or any OpenAI-compatible endpoint)

```bash
export AUTOHEAL_BASE_URL=https://openrouter.ai/api/v1
export AUTOHEAL_API_KEY=sk-or-...            # your OpenRouter key; give it a credit limit
export AUTOHEAL_MODEL=<model id from openrouter.ai/models>
export AUTOHEAL_PRICE_IN=3 AUTOHEAL_PRICE_OUT=15   # USD per 1M tokens of that model, so max-usd is enforced
npx keepgreen explore --url http://localhost:3000
```

In the Action: `base-url: https://openrouter.ai/api/v1`, `api-key: ${{ secrets.OPENROUTER_API_KEY }}`,
`model: ...`, and `price-in` / `price-out`.

### Playwright `webServer`

If your `playwright.config` starts the app with `webServer`, and KeepGreen starts it too
(`start-command`), let Playwright reuse it during a KeepGreen run:

```ts
webServer: { command: 'npm run start', url: 'http://127.0.0.1:3000/', reuseExistingServer: !process.env.CI || !!process.env.KEEPGREEN },
```

## How explore works

1. **Look.** It opens your app's start page and every path in `pages:` with playwright-e2e-mcp's
   `inspect-page`, which lists the interactive elements and their locators.
2. **Plan.** It reads the titles of your existing tests and asks your AI for the most important
   user flows that have no test yet. Flows that pay money, send email or delete data are skipped.
3. **Write.** For each flow, AutoHeal's `cover` explores the pages, checks every locator, and
   writes one test in your project's own style.
4. **Prove.** The new-test guard rejects tests that cannot fail, or that use skips, faked network
   answers, fixed waits, forced clicks or retries. The test must then pass every run in a row.
   Anything less is thrown away.

One `max-usd` cap covers the whole run. Each flow gets an even share of what is left, so money one
flow saves goes to the next.

## All commands

```
keepgreen init [--force] [--dry-run]
keepgreen doctor
keepgreen explore [--url <app>] [--start-command <cmd> --start-url <url>] [--pages /a,/b]
                  [--max-flows 3] [--max-usd 3] [--runs 5] [--dry-run] [--out <dir>]
keepgreen heal [AutoHeal fix options]
keepgreen autoheal <command> [...]      # any AutoHeal command: learn, metrics, dashboard, ...
keepgreen check-patch <file>            # CI publish step
keepgreen --version
```

## Self-host bundle (optional)

KeepGreen needs no server. If you want **test history across all CI runs** (flaky ranking, the
commit where a test went bad) and **AutoHeal's dashboard** (fixes, blocked cheats, AI spend),
[`selfhost/`](selfhost/) starts both servers with one command:

```bash
cd selfhost && sh make-env.sh your-org/your-repo && docker compose up -d --build
```

## Security

See [SECURITY.md](SECURITY.md). In short: your key goes only to your AI provider, AI-written tests
never run with a write token or your AI key, the publish step only accepts new test files, and
every change arrives as a PR for a person to review.

## License

MIT. Free for any use, with no paid tier.
