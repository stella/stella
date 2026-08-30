# Pin to digest for supply-chain integrity (oven/bun:1.4.1-slim).
# Run the JavaScript toolchain on the native build host. Cross-platform
# installs select the target's optional native packages explicitly; the final
# image alone belongs to the deployment target.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.1-slim@sha256:887d0f37f674c69984be4e397fef29ca0d74df1e75155431abbe857258bffde5 AS build-base
WORKDIR /app

FROM --platform=$TARGETPLATFORM oven/bun:1.4.1-slim@sha256:887d0f37f674c69984be4e397fef29ca0d74df1e75155431abbe857258bffde5 AS runtime-base
WORKDIR /app

FROM build-base AS install-inputs
# Preserve Bun's committed root lockfile and full workspace manifest map.
# Turbo's pruned bun.lock is a generated approximation and can drift from
# Bun's catalog/resolution semantics.
COPY . .
RUN mkdir -p /json && \
    cp bun.lock package.json /json/ && \
    for input in bunfig.toml .npmrc patches; do \
      [ ! -e "$input" ] || cp -a "$input" /json/; \
    done && \
    find apps packages -mindepth 2 -maxdepth 2 -name package.json \
      -not -path '*/node_modules/*' \
      -exec cp --parents -t /json/ {} +

FROM build-base AS pruner
COPY package.json .
RUN bun install -g "turbo@$(bun -p 'require("./package.json").devDependencies.turbo')"
COPY . .
# The prune graph must contain every workspace package that bun.lock resolves
# npm dependencies to: @stll/folio-core (npm) depends on @stll/docx-core,
# @stll/docx-utils, and @stll/template-conditions. The lockfile links the latter
# two to their workspace copies; apps/web declares all three explicitly so the
# pruned context carries the required sources and package manifests even if the
# transitive workspace graph (@stll/web -> @stll/api -> ...) changes.
RUN turbo prune @stll/web --docker

FROM build-base AS deps
COPY --from=install-inputs /json/ .
# A BuildKit cache mount is not part of the resulting layer. Materialize the
# isolated store in /app so node_modules never points into the detached mount.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    BUN_INSTALL_GLOBAL_STORE=0 bun install --filter @stll/web --frozen-lockfile --ignore-scripts --network-concurrency=8

# Runtime install: the SSR server bundle (dist/server/server.js) externalises
# its imports, so they must resolve from `dependencies` alone with
# devDependencies stripped. Select target-native optional packages while Bun
# itself stays on the native build platform; running Bun through QEMU is not a
# reliable image-build boundary.
FROM build-base AS deps-prod
ARG TARGETARCH
COPY --from=install-inputs /json/ .
RUN --mount=type=cache,target=/root/.bun/install/cache \
    case "${TARGETARCH}" in \
      amd64) target_cpu=x64 ;; \
      arm64) target_cpu=arm64 ;; \
      *) echo "unsupported web runtime architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    BUN_INSTALL_GLOBAL_STORE=0 bun install --filter @stll/web --production --frozen-lockfile --ignore-scripts \
      --network-concurrency=8 --cpu="${target_cpu}" --os=linux

FROM deps AS builder
ARG STELLA_VERSION=dev
ARG STELLA_COMMIT_SHA=dev
ARG RAILWAY_GIT_COMMIT_SHA=dev
ARG PUBLIC_API_URL
ARG PUBLIC_BROWSER_API_URL
ARG PUBLIC_APP_URL
ARG PUBLIC_GOOGLE_LOGIN_ENABLED
ARG PUBLIC_MICROSOFT_LOGIN_ENABLED
ARG PUBLIC_POSTHOG_TOKEN
ARG PUBLIC_POSTHOG_HOST
ARG PUBLIC_POSTHOG_UI_HOST
ARG PUBLIC_FEEDBACK_EMAIL_TO
ARG PUBLIC_LAW_ENABLED
ARG PUBLIC_LAW_INDEXING_ENABLED
ARG SEO_INDEXABLE=false
ARG PUBLIC_TOOLS_ENABLED
ARG PUBLIC_TOOLS_INDEXING_ENABLED
ARG VITE_COLLAB_URL
ARG VITE_DESKTOP_BRIDGE_PORT
ARG VITE_DESKTOP_RELEASES_BASE_URL
ARG VITE_FEATURE_TIME_BILLING
ARG VITE_FEATURE_CALENDAR
ARG VITE_FEATURE_CASE_LAW
ARG VITE_FEATURE_CHAT=true
ARG VITE_FEATURE_CONTACTS=true
ARG VITE_FEATURE_DESKTOP_EDITING=true
ARG VITE_FEATURE_FOLIO_COLLAB
ARG VITE_FEATURE_KNOWLEDGE_TEMPLATES=true
ARG VITE_FEATURE_MCP
ARG VITE_FEATURE_TODOS=true
ARG VITE_FEATURE_USAGE
ARG VITE_POSTHOG_LOCAL_DEBUG
ARG VITE_BETA_FEATURES_ENABLED=true
ARG VITE_FEATURE_AI_MEMORY=false
ARG VITE_FEATURE_LEGAL_LISTS=false
ARG VITE_FEATURE_GOVERNED_WORKFLOW=false
ARG VITE_FEATURE_INBOX=false
ARG VITE_SELFHOST=true
ARG VITE_TERMS_URL
ARG VITE_WORKFLOWS_ENABLED
# Source-map publication is an explicit build argument, not a side effect of
# the `posthog_cli_api_key` secret: secrets are outside the layer cache key,
# so only a plain argument keeps a cached no-publish layer from standing in
# for a publishing build. The project id names the error-tracker project.
ARG POSTHOG_SOURCEMAP_PUBLISH=false
ARG POSTHOG_SOURCEMAP_PROJECT_ID
ENV NODE_ENV=production
ENV STELLA_VERSION=${STELLA_VERSION}
ENV STELLA_COMMIT_SHA=${STELLA_COMMIT_SHA}
ENV RAILWAY_GIT_COMMIT_SHA=${RAILWAY_GIT_COMMIT_SHA}
COPY --from=pruner /app/out/full/ .
COPY --from=pruner /app/VERSION ./VERSION
RUN test -n "${PUBLIC_API_URL}" || (echo "PUBLIC_API_URL build arg is required" >&2; exit 1)
RUN test -n "${PUBLIC_APP_URL}" || (echo "PUBLIC_APP_URL build arg is required" >&2; exit 1)
RUN VITE_API_URL="${PUBLIC_API_URL}" \
    VITE_BROWSER_API_URL="${PUBLIC_BROWSER_API_URL}" \
    VITE_PUBLIC_APP_URL="${PUBLIC_APP_URL}" \
    VITE_AUTH_GOOGLE="${PUBLIC_GOOGLE_LOGIN_ENABLED}" \
    VITE_AUTH_MICROSOFT="${PUBLIC_MICROSOFT_LOGIN_ENABLED}" \
    VITE_POSTHOG_KEY="${PUBLIC_POSTHOG_TOKEN}" \
    VITE_POSTHOG_HOST="${PUBLIC_POSTHOG_HOST}" \
    VITE_POSTHOG_UI_HOST="${PUBLIC_POSTHOG_UI_HOST}" \
    VITE_FEEDBACK_EMAIL_TO="${PUBLIC_FEEDBACK_EMAIL_TO}" \
    VITE_PUBLIC_LAW_ENABLED="${PUBLIC_LAW_ENABLED}" \
    VITE_PUBLIC_LAW_INDEXING_ENABLED="${PUBLIC_LAW_INDEXING_ENABLED}" \
    VITE_SEO_INDEXABLE="${SEO_INDEXABLE}" \
    VITE_PUBLIC_TOOLS_ENABLED="${PUBLIC_TOOLS_ENABLED}" \
    VITE_PUBLIC_TOOLS_INDEXING_ENABLED="${PUBLIC_TOOLS_INDEXING_ENABLED}" \
    VITE_COLLAB_URL="${VITE_COLLAB_URL}" \
    VITE_DESKTOP_BRIDGE_PORT="${VITE_DESKTOP_BRIDGE_PORT}" \
    VITE_DESKTOP_RELEASES_BASE_URL="${VITE_DESKTOP_RELEASES_BASE_URL}" \
    VITE_FEATURE_TIME_BILLING="${VITE_FEATURE_TIME_BILLING}" \
    VITE_FEATURE_CALENDAR="${VITE_FEATURE_CALENDAR}" \
    VITE_FEATURE_CASE_LAW="${VITE_FEATURE_CASE_LAW}" \
    VITE_FEATURE_CHAT="${VITE_FEATURE_CHAT}" \
    VITE_FEATURE_CONTACTS="${VITE_FEATURE_CONTACTS}" \
    VITE_FEATURE_DESKTOP_EDITING="${VITE_FEATURE_DESKTOP_EDITING}" \
    VITE_FEATURE_FOLIO_COLLAB="${VITE_FEATURE_FOLIO_COLLAB}" \
    VITE_FEATURE_KNOWLEDGE_TEMPLATES="${VITE_FEATURE_KNOWLEDGE_TEMPLATES}" \
    VITE_FEATURE_MCP="${VITE_FEATURE_MCP}" \
    VITE_FEATURE_TODOS="${VITE_FEATURE_TODOS}" \
    VITE_FEATURE_USAGE="${VITE_FEATURE_USAGE}" \
    VITE_POSTHOG_LOCAL_DEBUG="${VITE_POSTHOG_LOCAL_DEBUG}" \
    VITE_BETA_FEATURES_ENABLED="${VITE_BETA_FEATURES_ENABLED}" \
    VITE_FEATURE_AI_MEMORY="${VITE_FEATURE_AI_MEMORY}" \
    VITE_FEATURE_LEGAL_LISTS="${VITE_FEATURE_LEGAL_LISTS}" \
    VITE_FEATURE_GOVERNED_WORKFLOW="${VITE_FEATURE_GOVERNED_WORKFLOW}" \
    VITE_FEATURE_INBOX="${VITE_FEATURE_INBOX}" \
    VITE_SELFHOST="${VITE_SELFHOST}" \
    VITE_TERMS_URL="${VITE_TERMS_URL}" \
    VITE_WORKFLOWS_ENABLED="${VITE_WORKFLOWS_ENABLED}" \
    bun --filter @stll/web build
# Publish the hidden client source maps to the error tracker when the build
# opts in (the chunks are injected with ids the tracker matches at capture
# time), then drop every map so none reaches the runtime image. A build that
# does not opt in still drops the maps.
RUN --mount=type=secret,id=posthog_cli_api_key \
    POSTHOG_SOURCEMAP_PUBLISH="${POSTHOG_SOURCEMAP_PUBLISH}" \
    POSTHOG_CLI_API_KEY="$(cat /run/secrets/posthog_cli_api_key 2>/dev/null || true)" \
    POSTHOG_CLI_HOST="${PUBLIC_POSTHOG_UI_HOST}" \
    POSTHOG_CLI_PROJECT_ID="${POSTHOG_SOURCEMAP_PROJECT_ID}" \
    bun apps/web/scripts/publish-sourcemaps.ts
# Stage the workspace packages reached by externalized runtime dependencies
# (closure derived from bun.lock) in their published dist shape. The runner
# overlays this tree so it never resolves TypeScript source. Restore the
# committed root manifest first: the out/full copy above overwrote it with
# Turbo's pruned root package.json (an explicit workspace subset), and the
# staging install resolving that subset against the committed lockfile fails
# --frozen-lockfile. bun.lock is restored defensively alongside it: today
# out/full carries no lockfile (Turbo emits its pruned one at out/bun.lock,
# which no stage copies), so the committed one from the deps stage survives,
# but this install must never depend on that staying true.
COPY --from=install-inputs /json/bun.lock /json/package.json ./
COPY --from=pruner /app/scripts/publish-manifest.ts /app/scripts/stage-web-runtime.ts /app/scripts/web-runtime-closure.ts ./scripts/
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun scripts/stage-web-runtime.ts /app/web-runtime-stage --install-build-deps

FROM runtime-base AS runner
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3002
RUN groupadd --system --gid 1001 stella && \
    useradd --system --uid 1001 --gid stella --no-create-home stella
COPY --from=deps-prod /app/ .
# Bun links workspace dependencies into /app/packages. Folio remains external
# to the SSR bundle and imports those workspaces at runtime; overlay the
# staged dist-shaped closure (derived from bun.lock at build time) onto the
# manifest tree so the runner never ships or resolves TypeScript source.
COPY --chown=stella:stella --from=pruner /app/out/json/ .
COPY --chown=stella:stella --from=builder /app/web-runtime-stage/ .
COPY --chown=stella:stella --from=builder /app/apps/web/dist ./apps/web/dist
WORKDIR /app/apps/web
USER stella
EXPOSE 3002
CMD ["bun", "dist/runtime.js"]
