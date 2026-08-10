# Pin to digest for supply-chain integrity (oven/bun:1.3.14-slim).
# Compile on the native build host; only the runtime dependency tree and final
# image belong to the deployment target. This keeps Rolldown and its native
# binding off target-architecture emulation while preserving ARM64 runtime
# dependencies such as sharp/canvas.
FROM --platform=$BUILDPLATFORM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04 AS build-base
WORKDIR /app

FROM --platform=$TARGETPLATFORM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04 AS runtime-base
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
# Keep in sync with the turbo version in the root package.json.
RUN bun install -g turbo@2.10.7
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
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --filter @stll/web --frozen-lockfile --ignore-scripts --network-concurrency=8

# Runtime install: the SSR server bundle (dist/server/server.js) externalises
# its imports, so they must resolve from `dependencies` alone with
# devDependencies stripped. The web-build CI job boot-smokes this same install.
FROM runtime-base AS deps-prod
COPY --from=install-inputs /json/ .
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --filter @stll/web --production --frozen-lockfile --ignore-scripts --network-concurrency=8

FROM deps AS builder
ARG STELLA_VERSION=dev
ARG STELLA_COMMIT_SHA=dev
ARG RAILWAY_GIT_COMMIT_SHA=dev
ARG PUBLIC_API_URL
ARG PUBLIC_APP_URL
ARG PUBLIC_GOOGLE_LOGIN_ENABLED
ARG PUBLIC_MICROSOFT_LOGIN_ENABLED
ARG PUBLIC_POSTHOG_TOKEN
ARG PUBLIC_POSTHOG_HOST
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
ARG VITE_BETA_FEATURES_ENABLED=true
ARG VITE_FEATURE_AI_MEMORY=false
ARG VITE_FEATURE_LEGAL_LISTS=false
ARG VITE_FEATURE_GOVERNED_WORKFLOW=false
ARG VITE_GUIDES_ENABLED=false
ARG VITE_SELFHOST=true
ARG VITE_TERMS_URL
ENV NODE_ENV=production
ENV STELLA_VERSION=${STELLA_VERSION}
ENV STELLA_COMMIT_SHA=${STELLA_COMMIT_SHA}
ENV RAILWAY_GIT_COMMIT_SHA=${RAILWAY_GIT_COMMIT_SHA}
COPY --from=pruner /app/out/full/ .
COPY --from=pruner /app/VERSION ./VERSION
RUN test -n "${PUBLIC_API_URL}" || (echo "PUBLIC_API_URL build arg is required" >&2; exit 1)
RUN test -n "${PUBLIC_APP_URL}" || (echo "PUBLIC_APP_URL build arg is required" >&2; exit 1)
RUN VITE_API_URL="${PUBLIC_API_URL}" \
    VITE_PUBLIC_APP_URL="${PUBLIC_APP_URL}" \
    VITE_AUTH_GOOGLE="${PUBLIC_GOOGLE_LOGIN_ENABLED}" \
    VITE_AUTH_MICROSOFT="${PUBLIC_MICROSOFT_LOGIN_ENABLED}" \
    VITE_POSTHOG_KEY="${PUBLIC_POSTHOG_TOKEN}" \
    VITE_POSTHOG_HOST="${PUBLIC_POSTHOG_HOST}" \
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
    VITE_BETA_FEATURES_ENABLED="${VITE_BETA_FEATURES_ENABLED}" \
    VITE_FEATURE_AI_MEMORY="${VITE_FEATURE_AI_MEMORY}" \
    VITE_FEATURE_LEGAL_LISTS="${VITE_FEATURE_LEGAL_LISTS}" \
    VITE_FEATURE_GOVERNED_WORKFLOW="${VITE_FEATURE_GOVERNED_WORKFLOW}" \
    VITE_GUIDES_ENABLED="${VITE_GUIDES_ENABLED}" \
    VITE_SELFHOST="${VITE_SELFHOST}" \
    VITE_TERMS_URL="${VITE_TERMS_URL}" \
    bun --filter @stll/web build

FROM deps-prod AS runner
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3002
RUN groupadd --system --gid 1001 stella && \
    useradd --system --uid 1001 --gid stella --no-create-home stella
# Bun links workspace dependencies into /app/packages. Folio remains external
# to the SSR bundle and imports these source-exporting workspaces at runtime;
# keep that exact dependency closure without restoring the full pruned tree.
COPY --chown=stella:stella --from=pruner /app/out/json/ .
COPY --chown=stella:stella --from=pruner /app/out/full/packages/conditions/src ./packages/conditions/src
COPY --chown=stella:stella --from=pruner /app/out/full/packages/docx-utils/src ./packages/docx-utils/src
COPY --chown=stella:stella --from=pruner /app/out/full/packages/template-conditions/src ./packages/template-conditions/src
COPY --chown=stella:stella --from=builder /app/apps/web/start-runtime.js ./apps/web/start-runtime.js
COPY --chown=stella:stella --from=builder /app/apps/web/dist ./apps/web/dist
WORKDIR /app/apps/web
RUN bun -e 'await import("@stll/folio-core/docx/xmlParser"); await import("@stll/folio-core/prosemirror/plugins/templateDirectives")'
USER stella
EXPOSE 3002
CMD ["bun", "start-runtime.js"]
