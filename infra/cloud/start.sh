#!/usr/bin/env bash
# Starts ModelOps Cloud on the AWS free-plan server (docs/14-aws-free-plan.md). Runs on every boot
# (systemd unit modelops.service, installed by the Terraform user data); safe to run again by hand:
#
#   sudo systemctl restart modelops      # or: sudo /opt/modelops/infra/cloud/start.sh
#
# MO_PUBLIC_HOST=<address> overrides the address the platform announces (tests use this; on AWS it
# is read from the instance metadata, because the public IP changes on every start).
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
log() { printf '[modelops %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# The same Node image the API and web images are built on: runs the repo's own scripts without
# installing Node on the server.
NODE_IMAGE='node:24.22.2-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9'

# 1. Secrets: generated once, on the first boot, by the same script a laptop uses (pnpm env:init).
#    They never leave the server and are not in Terraform state.
if [ ! -f .env ]; then
  log 'generating .env (first boot)'
  docker run --rm -v "$root:/repo" -w /repo "$NODE_IMAGE" node scripts/init-env.mjs
fi

# 2. The address users reach the platform on.
host="${MO_PUBLIC_HOST:-}"
if [ -z "$host" ]; then
  token="$(curl -sf -X PUT http://169.254.169.254/latest/api/token \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')"
  host="$(curl -sf -H "X-aws-ec2-metadata-token: $token" \
    http://169.254.169.254/latest/meta-data/public-ipv4)"
fi
if ! [[ "$host" =~ ^[A-Za-z0-9.-]+$ ]]; then
  log "no usable public address ('$host'): is a public IP attached?" >&2
  exit 1
fi
umask 077
printf 'MO_PUBLIC_HOST=%s\n' "$host" > .env.cloud
log "public address: $host"

compose=(docker compose --project-name modelops --env-file .env --env-file .env.cloud
  -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.cloud.yml)

# 3. Images (built here from the cloned source; cached after the first boot), then everything up.
#    The model-server image is only ever started by the worker, so it is built explicitly.
log 'building images (about 7 minutes on the first boot with 2 vCPUs, seconds afterwards)'
"${compose[@]}" --profile images build model-server
"${compose[@]}" --profile obs build
log 'starting the platform'
"${compose[@]}" --profile obs up -d --wait --wait-timeout 900

# 4. Grafana's read-only database role (idempotent; tables exist only after the migrations).
"${compose[@]}" exec -T postgres sh /docker-entrypoint-initdb.d/02-grafana.sh

# 5. Reclaim build cache so the 30 GB disk does not fill up across code updates.
docker builder prune -f --filter 'until=168h' > /dev/null || true

log "ready: web console http://$host:3300  gateway http://$host:18088  grafana http://$host:13001"
