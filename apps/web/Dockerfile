# Pin to digest for supply-chain integrity (oven/bun:1.3.14-slim)
FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04 AS base
WORKDIR /app

FROM base AS pruner
# Keep in sync with the turbo version in the root package.json; an unpinned
# major lets a new turbo release change `turbo prune` lockfile output mid-flight.
RUN bun install -g turbo@2.9.16
COPY . .
RUN turbo prune @stll/web --docker

FROM base AS deps
COPY --from=pruner /app/out/json/ .
RUN bun install --filter @stll/web --frozen-lockfile --ignore-scripts --network-concurrency=8

# Runtime install: the SSR server bundle (dist/server/server.js) externalises
# its imports, so they must resolve from `dependencies` alone with
# devDependencies stripped. The web-build CI job boot-smokes this same install.
FROM base AS deps-prod
COPY --from=pruner /app/out/json/ .
RUN bun install --filter @stll/web --production --frozen-lockfile --ignore-scripts --network-concurrency=8

FROM deps AS builder
ARG STELLA_VERSION=dev
ARG STELLA_COMMIT_SHA=dev
ARG PUBLIC_API_URL
ARG PUBLIC_APP_URL
ARG PUBLIC_GOOGLE_LOGIN_ENABLED
ARG PUBLIC_MICROSOFT_LOGIN_ENABLED
ARG PUBLIC_POSTHOG_TOKEN
ARG PUBLIC_POSTHOG_HOST
ARG PUBLIC_FEEDBACK_EMAIL_TO
ARG PUBLIC_EMPTY_STATE_MATTERS_VIDEO_URL
ARG PUBLIC_LAW_ENABLED
ARG PUBLIC_LAW_INDEXING_ENABLED
ARG VITE_AI_DEVTOOLS_ENABLED
ARG VITE_AI_SDK_DEVTOOLS_PORT
ARG VITE_COLLAB_URL
ARG VITE_DESKTOP_BRIDGE_PORT
ARG VITE_DESKTOP_RELEASES_BASE_URL
ARG VITE_FEATURE_BILLING
ARG VITE_FEATURE_CALENDAR
ARG VITE_FEATURE_CASE_LAW
ARG VITE_FEATURE_CHAT
ARG VITE_FEATURE_CONTACTS
ARG VITE_FEATURE_DESKTOP_EDITING
ARG VITE_FEATURE_FOLIO_COLLAB
ARG VITE_FEATURE_KNOWLEDGE_TEMPLATES
ARG VITE_FEATURE_MCP
ARG VITE_FEATURE_TODOS
ARG VITE_SELFHOST
ARG VITE_TERMS_URL
ENV NODE_ENV=production
ENV STELLA_VERSION=${STELLA_VERSION}
ENV STELLA_COMMIT_SHA=${STELLA_COMMIT_SHA}
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
    VITE_EMPTY_STATE_MATTERS_VIDEO_URL="${PUBLIC_EMPTY_STATE_MATTERS_VIDEO_URL}" \
    VITE_PUBLIC_LAW_ENABLED="${PUBLIC_LAW_ENABLED}" \
    VITE_PUBLIC_LAW_INDEXING_ENABLED="${PUBLIC_LAW_INDEXING_ENABLED}" \
    VITE_AI_DEVTOOLS_ENABLED="${VITE_AI_DEVTOOLS_ENABLED}" \
    VITE_AI_SDK_DEVTOOLS_PORT="${VITE_AI_SDK_DEVTOOLS_PORT}" \
    VITE_COLLAB_URL="${VITE_COLLAB_URL}" \
    VITE_DESKTOP_BRIDGE_PORT="${VITE_DESKTOP_BRIDGE_PORT}" \
    VITE_DESKTOP_RELEASES_BASE_URL="${VITE_DESKTOP_RELEASES_BASE_URL}" \
    VITE_FEATURE_BILLING="${VITE_FEATURE_BILLING}" \
    VITE_FEATURE_CALENDAR="${VITE_FEATURE_CALENDAR}" \
    VITE_FEATURE_CASE_LAW="${VITE_FEATURE_CASE_LAW}" \
    VITE_FEATURE_CHAT="${VITE_FEATURE_CHAT}" \
    VITE_FEATURE_CONTACTS="${VITE_FEATURE_CONTACTS}" \
    VITE_FEATURE_DESKTOP_EDITING="${VITE_FEATURE_DESKTOP_EDITING}" \
    VITE_FEATURE_FOLIO_COLLAB="${VITE_FEATURE_FOLIO_COLLAB}" \
    VITE_FEATURE_KNOWLEDGE_TEMPLATES="${VITE_FEATURE_KNOWLEDGE_TEMPLATES}" \
    VITE_FEATURE_MCP="${VITE_FEATURE_MCP}" \
    VITE_FEATURE_TODOS="${VITE_FEATURE_TODOS}" \
    VITE_SELFHOST="${VITE_SELFHOST}" \
    VITE_TERMS_URL="${VITE_TERMS_URL}" \
    bun --filter @stll/web build

FROM deps-prod AS runner
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3002
RUN groupadd --system --gid 1001 stella && \
    useradd --system --uid 1001 --gid stella --no-create-home stella
COPY --chown=stella:stella --from=pruner /app/out/full/ .
COPY --chown=stella:stella --from=builder /app/apps/web/dist ./apps/web/dist
WORKDIR /app/apps/web
USER stella
EXPOSE 3002
CMD ["bun", "start-runtime.js"]
