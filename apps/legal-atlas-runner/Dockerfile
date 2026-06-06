# Pin to digest for supply-chain integrity (oven/bun:1.3.14-slim)
FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04 AS base
WORKDIR /app

FROM base AS pruner
RUN bun install -g turbo@^2
COPY . .
RUN turbo prune @stll/legal-atlas-runner --docker

FROM base AS deps
COPY --from=pruner /app/out/json/ .
RUN bun install --filter @stll/legal-atlas-runner --production --frozen-lockfile --ignore-scripts --network-concurrency=8

FROM deps AS builder
ENV NODE_ENV=production
COPY --from=pruner /app/out/full/ .
RUN bun --filter @stll/legal-atlas-runner build
RUN bun apps/legal-atlas-runner/dist/index.js smoke

FROM base AS runner
ENV NODE_ENV=production
RUN groupadd --system --gid 1001 stella && \
    useradd --system --uid 1001 --gid stella --no-create-home stella
COPY --chown=stella:stella --from=builder /app/apps/legal-atlas-runner/dist/index.js /app/legal-atlas.js
WORKDIR /app
USER stella
ENTRYPOINT ["bun", "/app/legal-atlas.js"]
CMD ["--help"]
