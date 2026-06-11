# Pin to digest for supply-chain integrity (oven/bun:1.3.14-slim)
FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04 AS base
WORKDIR /app

# Prune the monorepo for the API
FROM base AS pruner
# Keep in sync with the turbo version in the root package.json; an unpinned
# major lets a new turbo release change `turbo prune` lockfile output mid-flight.
RUN bun install -g turbo@2.9.16
COPY . .
RUN turbo prune @stll/api @stll/legal-atlas-runner --docker

# Install dependencies using only package manifests (cached layer)
FROM base AS deps
COPY --from=pruner /app/out/json/ .
RUN bun install --frozen-lockfile --ignore-scripts

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
RUN bun build \
    --compile \
    --minify-whitespace \
    --minify-syntax \
    --target bun \
    --outfile /app/server \
    apps/api/src/index.ts
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
COPY --chown=stella:stella --from=builder /app/apps/legal-atlas-runner/dist/index.js /app/legal-atlas.js
COPY --chown=stella:stella --from=builder /app/apps/api/drizzle.config.ts /app/apps/api/drizzle.config.ts
COPY --chown=stella:stella --from=builder /app/apps/api/src/db-url.ts /app/apps/api/src/db-url.ts
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
