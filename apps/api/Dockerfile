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

# Copy source code and run as non-root
FROM deps AS runner
RUN groupadd --system --gid 1001 stella && \
    useradd --system --uid 1001 --gid stella --no-create-home stella
COPY --chown=stella:stella --from=pruner /app/out/full/ .
WORKDIR /app/apps/api
USER stella
EXPOSE 3001
CMD ["bun", "src/index.ts"]
