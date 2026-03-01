#!/usr/bin/env bash
set -euo pipefail

PORTS=(3000 3001 3002 6420)

echo "==> Killing processes on ports ${PORTS[*]}..."
for port in "${PORTS[@]}"; do
  pids=$(lsof -ti :"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill 2>/dev/null || true
    echo "    Stopped port $port (PIDs: $(echo $pids | tr '\n' ' '))"
  fi
done

echo "==> Starting Docker services (Postgres + MinIO)..."
docker compose --profile dev up -d --wait --wait-timeout 30

echo "==> Installing dependencies..."
bun ci || bun install

echo "==> Setting up .env files..."
[ -f apps/api/.env ] || cp apps/api/.env.example apps/api/.env
[ -f apps/web/.env ] || cp apps/web/.env.example apps/web/.env

echo "==> Pushing database schema..."
(cd apps/api && bun run db:push)

echo "==> Starting dev servers..."
bun run dev
