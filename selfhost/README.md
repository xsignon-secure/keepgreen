# KeepGreen self-host bundle

KeepGreen itself needs no server: it runs in your CI or on your laptop. These two servers are
optional extras you host yourself, started together with Docker Compose:

| Service | What it gives you | Port |
| --- | --- | --- |
| `history` | Test runs from every CI job and laptop in one place: flaky ranking, the commit where a test went bad ([docs](https://github.com/xsignon-secure/E2E/tree/main/history-server)) | 8787 |
| `dashboard` | AutoHeal's dashboard: fixes, quarantines, blocked cheats, app bugs, time saved and AI spend across your repos ([docs](https://github.com/xsignon-secure/AutoHeal-AI#self-hosted-dashboard-optional)) | 8080 |

## Start

The servers refuse to start with short or placeholder secrets, so let `make-env.sh` create them
(or copy `.env.example` to `.env` and fill it in by hand).

```bash
sh make-env.sh your-org/your-repo   # writes .env with fresh random secrets
docker compose up -d --build
```

Both listen on `127.0.0.1` only. Before CI can reach them, put an HTTPS reverse proxy in front,
for example Caddy:

```
history.example.com {
  reverse_proxy 127.0.0.1:8787
}
heal.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

With the dashboard behind your proxy, set `AUTOHEAL_TRUST_PROXY=1` in `.env`.

## Connect CI

- History: set `PW_MCP_HISTORY_URL=https://history.example.com` and `PW_MCP_HISTORY_TOKEN=<token>`
  (repository secrets), and run `npx -y playwright-e2e-mcp upload` after your tests.
- Dashboard: on AutoHeal's publish step set `dashboard-url: https://heal.example.com` and
  `dashboard-secret: ${{ secrets.AUTOHEAL_DASHBOARD_SECRET }}`. Open the dashboard once with
  `?token=<view token>`.

## Update

Change the tags in `docker-compose.yml` (`#v0.16.1`, `#v0.12.1`) to the new releases, then run
`docker compose up -d --build`. Data stays in the `history-data` and `dashboard-data` volumes.
