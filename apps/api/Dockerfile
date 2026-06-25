# Pin to digest for supply-chain integrity (oven/bun:1.3.14-slim)
FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04 AS base
WORKDIR /app

FROM base AS install-inputs
# Preserve Bun's committed root lockfile and full workspace manifest map.
# Turbo's pruned bun.lock is a generated approximation and can drift from
# Bun's catalog/resolution semantics.
COPY . .
RUN mkdir -p /json && \
    cp bun.lock package.json /json/ && \
    for f in bunfig.toml .npmrc; do [ ! -e "$f" ] || cp "$f" /json/; done && \
    find apps packages -mindepth 2 -maxdepth 2 -name package.json \
      -not -path '*/node_modules/*' \
      -exec cp --parents -t /json/ {} +

# Prune the monorepo for the API
FROM base AS pruner
# Keep in sync with the turbo version in the root package.json.
RUN bun install -g turbo@2.9.18
COPY . .
RUN turbo prune @stll/api @stll/legal-atlas-runner --docker

# Install dependencies using only package manifests (cached layer)
FROM base AS deps
COPY --from=install-inputs /json/ .
RUN bun install --filter @stll/api --filter @stll/legal-atlas-runner --frozen-lockfile --ignore-scripts --network-concurrency=8

# Copy source code and compile the API to a Bun binary.
#
# NODE_ENV must be set during `bun build` because Bun inlines
# `process.env.NODE_ENV` at bundle time. Without this, every
# `process.env.NODE_ENV !== "production"` check in the source
# is baked as `true` in the compiled binary, and the resulting
# image runs as if it were dev (e.g. OTP emails are skipped).
FROM deps AS builder
ENV NODE_ENV=production
COPY --from=pruner /app/out/full/ .
# Build the server unminified: `bun build --minify` can break Elysia's AOT
# handler codegen (minified variable renames vs Sucrose). See elysiajs/elysia#1711.
RUN bun build \
    --compile \
    --target bun \
    --outfile /app/server \
    apps/api/src/index.ts
# One-off maintenance tool: assigns public slugs to legacy case-law rows that
# predate slug-at-ingest. Bundled to a single JS file (like the workers above,
# not --compile) so it reuses the container's Bun runtime instead of embedding
# a second copy; bundling still resolves the `@/api/*` aliases. Run as a one-off
# task on the API task-def (it needs the API env, not the migrate env):
#   command override -> ["bun", "/app/backfill.js"]
RUN bun build \
    --target bun \
    --outfile /app/backfill.js \
    apps/api/src/scripts/backfill-case-law-slugs.ts
RUN mkdir -p /app/runtime-workers && \
    bun build \
      --target bun \
      --outfile /app/runtime-workers/pdf-worker.js \
      apps/api/src/handlers/files/pdf-worker.ts && \
    bun build \
      --target bun \
      --outfile /app/runtime-workers/extraction-worker.js \
      apps/api/src/lib/search/extraction-worker.ts
RUN bun --filter @stll/legal-atlas-runner build

# Run the compiled API as non-root.
FROM deps AS runner
# Stamp the running container with the release version so the API can
# return it from /health and tag PostHog events with build metadata.
# Defaults to "dev" for local `docker build` outside the release flow.
ARG STELLA_VERSION=dev
ARG STELLA_COMMIT_SHA=dev
ENV STELLA_VERSION=${STELLA_VERSION}
ENV STELLA_COMMIT_SHA=${STELLA_COMMIT_SHA}
ENV STELLA_WORKER_DIR=/\$bunfs/root/workers
RUN groupadd --system --gid 1001 stella && \
    useradd --system --uid 1001 --gid stella --no-create-home stella
COPY --chown=stella:stella --from=builder /app/server /app/server
COPY --chown=stella:stella --from=builder /app/backfill.js /app/backfill.js
COPY --chown=stella:stella --from=builder /app/apps/legal-atlas-runner/dist/index.js /app/legal-atlas.js
# Loose files for the one-off migrate task (the API itself is the compiled
# /app/server binary). migrate.ts runs the drizzle migrator over Bun's SQL
# client; it imports db-url.ts and reads the drizzle/ migration folder.
COPY --chown=stella:stella --from=builder /app/apps/api/drizzle.config.ts /app/apps/api/drizzle.config.ts
COPY --chown=stella:stella --from=builder /app/apps/api/src/db-url.ts /app/apps/api/src/db-url.ts
COPY --chown=stella:stella --from=builder /app/apps/api/src/db/migrate.ts /app/apps/api/src/db/migrate.ts
COPY --chown=stella:stella --from=builder /app/apps/api/drizzle /app/apps/api/drizzle
RUN mkdir -p '/$bunfs/root'
COPY --chown=stella:stella --from=builder /app/runtime-workers /\$bunfs/root/workers
COPY --chown=stella:stella --from=builder /app/apps/api/src/lib/file-scan/yara /\$bunfs/root/yara
COPY --chown=stella:stella --from=deps \
    /app/node_modules/@stll/aho-corasick-wasm/dist/*.wasm \
    /app/node_modules/@stll/fuzzy-search-wasm/dist/*.wasm \
    /app/node_modules/@stll/regex-set-wasm/dist/*.wasm \
    /\$bunfs/root/
# quickjs-emscripten loads this WASM file at runtime from the
# compiled Bun binary's `$bunfs/root` asset directory.
COPY --chown=stella:stella --from=deps \
    /app/node_modules/@jitl/quickjs-wasmfile-release-asyncify/dist/emscripten-module.wasm \
    /app/node_modules/@stll/aho-corasick-wasm/dist/wasi-worker-browser.mjs \
    /\$bunfs/root/
WORKDIR /app/apps/api

USER stella
EXPOSE 3001
CMD ["/app/server"]
