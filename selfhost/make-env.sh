#!/bin/sh
# Writes selfhost/.env with fresh random secrets (never overwrites an existing .env).
#   sh make-env.sh your-org/your-repo[,other-org/other-repo]
set -eu
cd "$(dirname "$0")"
if [ -e .env ]; then echo ".env already exists; edit it or delete it first." >&2; exit 1; fi
repos="${1:-}"
if [ -z "$repos" ]; then echo "usage: sh make-env.sh owner/repo[,owner/repo]" >&2; exit 2; fi
rand() { openssl rand -hex "$1"; }
umask 077
cat > .env <<ENV
HISTORY_TOKENS=default:$(rand 24)
HISTORY_RETENTION_DAYS=90
AUTOHEAL_DASHBOARD_SECRET=$(rand 32)
AUTOHEAL_DASHBOARD_VIEW_TOKEN=$(rand 24)
AUTOHEAL_DASHBOARD_REPOS=$repos
AUTOHEAL_TRUST_PROXY=0
ENV
echo "Wrote $(pwd)/.env (readable only by you). Keep it out of git."
