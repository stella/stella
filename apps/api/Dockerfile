# Pin to digest for supply-chain integrity (oven/bun:1.3.13-slim)
FROM oven/bun:1.3.13-slim@sha256:7e8ed3961db1cdedf17d516dda87948cfedbd294f53bf16462e5b57ed3fff0f1 AS base
WORKDIR /app

# Prune the monorepo for the API
FROM base AS pruner
RUN bun install -g turbo@^2
COPY . .
RUN turbo prune @stll/api --docker

# Install dependencies using only package manifests (cached layer)
FROM base AS deps
COPY --from=pruner /app/out/json/ .
RUN bun install --frozen-lockfile --ignore-scripts

# Copy source code and compile the API to a Bun binary
FROM deps AS builder
COPY --from=pruner /app/out/full/ .
RUN bun build \
    --compile \
    --minify-whitespace \
    --minify-syntax \
    --target bun \
    --outfile /app/server \
    apps/api/src/index.ts

# Run the compiled API as non-root.
#
# Build off `deps` (not `base`) so node_modules is present.
# The same image runs the case-law ingestion daemon on the
# utility worker, whose entrypoint is `bun scripts/ingest-case-law.ts`
# (not the compiled binary). It needs the source tree and
# node_modules at runtime.
FROM deps AS runner
RUN groupadd --system --gid 1001 stella && \
    useradd --system --uid 1001 --gid stella --no-create-home stella
COPY --chown=stella:stella --from=pruner /app/out/full/ .
COPY --chown=stella:stella --from=builder /app/server /app/server
RUN mkdir -p '/$bunfs/root'
COPY --chown=stella:stella --from=builder /app/apps/api/src/lib/file-scan/yara /\$bunfs/root/yara
COPY --chown=stella:stella --from=deps \
    /app/node_modules/@stll/aho-corasick-wasm/dist/*.wasm \
    /app/node_modules/@stll/fuzzy-search-wasm/dist/*.wasm \
    /app/node_modules/@stll/regex-set-wasm/dist/*.wasm \
    /\$bunfs/root/
COPY --chown=stella:stella --from=deps /app/node_modules/@stll/aho-corasick-wasm/dist/wasi-worker-browser.mjs /\$bunfs/root/wasi-worker-browser.mjs
WORKDIR /app/apps/api

# Build-time smoke: invoke the ingestion entrypoint with a fake
# adapter key to verify all imports resolve. This catches future
# regressions where the runner stage drops files that the utility
# worker's docker-compose entrypoint (`bun scripts/ingest-case-law.ts`)
# needs at runtime — e.g., source, packages, or node_modules. On
# success the script exits 1 with "Unknown adapter"; if any import
# fails ("Cannot find module"), the build fails.
RUN out=$(DATABASE_URL=postgres://smoke:smoke@localhost:5432/smoke \
            S3_ENDPOINT=http://localhost \
            S3_BUCKET=smoke \
            S3_REGION=eu-central-1 \
            bun scripts/ingest-case-law.ts __smoke__ 2>&1 || true); \
    echo "$out"; \
    echo "$out" | grep -q 'Unknown adapter: __smoke__' \
      || { echo "ERROR: ingestion entrypoint smoke failed" >&2; exit 1; }

USER stella
EXPOSE 3001
CMD ["/app/server"]
