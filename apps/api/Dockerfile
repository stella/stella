# Pin to digest for supply-chain integrity (oven/bun:1.4.0-slim)
FROM oven/bun:1.4.0-slim@sha256:e0ee68d16ccb9927bf02aa7dd8fd4bf3369ee6d46da04faa72b05ce8bfd135f6 AS base
WORKDIR /app

FROM base AS install-inputs
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

# Prune the monorepo for the API
FROM base AS pruner
COPY package.json .
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install -g "turbo@$(bun -p 'require("./package.json").devDependencies.turbo')"
COPY . .
RUN turbo prune @stll/api @stll/legal-atlas-runner --docker

# Install dependencies using only package manifests (cached layer)
FROM base AS deps
COPY --from=install-inputs /json/ .
# The cache mount is detached after this layer, so packages must be
# materialized under /app instead of linked into the global virtual store.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    BUN_INSTALL_GLOBAL_STORE=0 bun install --filter @stll/api --filter @stll/legal-atlas-runner --frozen-lockfile --ignore-scripts --network-concurrency=8

# Copy source code and compile the API to a Bun binary.
#
# NODE_ENV must be set during `bun build` because Bun inlines
# `process.env.NODE_ENV` at bundle time. Without this, every
# `process.env.NODE_ENV !== "production"` check in the source
# is baked as `true` in the compiled binary, and the resulting
# image runs as if it were dev (e.g. OTP emails are skipped).
FROM deps AS builder
ARG TARGETARCH
ENV NODE_ENV=production
COPY --from=pruner /app/out/full/ .
# Build the server unminified: `bun build --minify` can break Elysia's AOT
# handler codegen (minified variable renames vs Sucrose). See elysiajs/elysia#1711.
RUN bun build \
    --compile \
    --no-compile-autoload-dotenv \
    --target bun \
    --outfile /app/server \
    apps/api/src/server.ts
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
# Better Auth migration rehearsal validator. It accepts only a database
# credential plus a private tmpfs baseline path; stdout is a redacted JSON
# report. Run on the isolated clone task with command override:
#   ["bun", "/app/better-auth-migration-audit.js", "pre-migration",
#    "--baseline", "/tmp/better-auth-baseline.json", "--identity-map",
#    "/tmp/better-auth-identity-map.json", "--oauth-base-url",
#    "https://api.stll.app"]
RUN bun build \
    --target bun \
    --outfile /app/better-auth-migration-audit.js \
    apps/api/src/scripts/better-auth-migration-audit.ts
# Trusted Microsoft identity-map derivation for the Better Auth rehearsal. It
# reads stored ID tokens only inside the isolated task and writes the verified
# sub-to-oid map to the task's private tmpfs without logging identity values.
RUN bun build \
    --target bun \
    --outfile /app/better-auth-microsoft-identity-map.js \
    apps/api/src/scripts/better-auth-microsoft-identity-map.ts
# Bounded Better Auth bridge backfill. The command reproduces the private
# baseline before mutating and runs the post-backfill audit before succeeding.
RUN bun build \
    --target bun \
    --outfile /app/better-auth-17-backfill.js \
    apps/api/src/scripts/better-auth-17-backfill.ts
# Whole-database census (counts, digests, foreign-key orphans) recorded before
# a migration rehearsal and compared after it.
RUN bun build \
    --target bun \
    --outfile /app/database-census.js \
    apps/api/src/scripts/database-census.ts
# Dedicated durable document-processing worker. Deploy the same image with
# command override ["bun", "/app/document-processing-worker.js"]. OCR runs
# in-image through the isolated local ONNX worker.
RUN bun build \
    --target bun \
    --outfile /app/document-processing-worker.js \
    apps/api/src/scripts/document-processing-worker.ts
# Bundle the migration entrypoint so its full transitive @/api import graph is
# resolved at build time. Keep the output at the same directory depth as the
# source so its `import.meta.dir`-relative migrationsFolder lookup resolves to
# /app/apps/api/drizzle in the runtime image.
RUN bun build \
    --target bun \
    --outfile /app/apps/api/src/db/migrate.js \
    apps/api/src/db/migrate.ts
# The extraction worker builds with `--outdir`, not `--outfile`: it pulls in a
# native addon, which the bundler emits as a sidecar `.node` asset next to the
# entry point and references relatively. `--outfile` refuses to write more than
# one output. The whole directory is copied into the runtime image below, so the
# sidecar travels with the bundle. The same-stage `cp` calls below copy regular
# files whose path may traverse a package symlink under an isolated install;
# cp follows it and materializes each asset before the cross-stage COPY.
RUN mkdir -p /app/runtime-workers && \
    bun build \
      --target bun \
      --outfile /app/runtime-workers/pdf-worker.js \
      apps/api/src/lib/files/pdf-worker.ts && \
    bun build \
      --target bun \
      --outdir /app/runtime-workers \
      apps/api/src/lib/search/extraction-worker.ts && \
    bun build \
      --target bun \
      --outfile /app/runtime-workers/ocr-searchable-pdf-worker.js \
      apps/api/src/lib/ocr-searchable-pdf-worker.ts && \
    bun build \
      --target bun \
      --outfile /app/runtime-workers/office-evidence-worker.js \
      apps/api/src/lib/files/office-evidence-worker.ts && \
    bun build \
      --target bun \
      --outfile /app/runtime-workers/ocr-local-worker.js \
      apps/api/src/lib/ocr-local/ocr-local-worker.ts && \
    cp node_modules/@silurus/ooxml/dist/xlsx_parser_bg.wasm \
      /app/runtime-workers/xlsx_parser_bg.wasm && \
    cp node_modules/@silurus/ooxml/dist/pptx_parser_bg.wasm \
      /app/runtime-workers/pptx_parser_bg.wasm && \
    cp node_modules/@hyzyla/pdfium/dist/pdfium.wasm \
      /app/runtime-workers/pdfium.wasm && \
    cp apps/api/src/lib/ocr-local/latin-v5-dict.txt \
      /app/runtime-workers/latin-v5-dict.txt
# Local OCR runtime assets: the pinned ONNX models, plus the onnxruntime
# native binding, which the bundled worker resolves relative to its own
# location (`../bin/...`), so the directory must sit beside the workers.
RUN cd apps/api && bun src/scripts/fetch-ocr-models.ts /app/ocr-models
# Materialize only this image's ONNX Runtime closure. The package contains
# binaries for every supported OS and architecture; copying its whole `bin`
# directory adds more than 200 MB of unreachable files. The materializer
# imports the same lookup manifest as the runtime image-layout test, so the
# worker and container cannot drift onto different package paths.
RUN cd apps/api && \
    bun src/scripts/materialize-runtime-worker-native-assets.ts \
      "$TARGETARCH" /app/runtime-onnx
RUN bun --filter @stll/legal-atlas-runner build
# Runtime-asset smoke probe: initializes the compiled anonymize and QuickJS
# runtimes, plus the external YARA rules, worker bundles, OCR model, and font.
# Compiled like the server and run by the verification stage below.
RUN bun build \
    --compile \
    --no-compile-autoload-dotenv \
    --target bun \
    --outfile /app/image-smoke \
    apps/api/src/scripts/image-smoke.ts

# Run the compiled API as non-root. Built from the bare base image: every
# entrypoint is either the compiled binary or a self-contained
# `bun build --target bun` bundle, so the runtime image ships only those
# outputs plus the asset trees they read at runtime; the workspace install
# (node_modules, manifest tree) stays in the build stages.
FROM base AS runner
# Stamp the running container with the release version so the API can
# return it from /health and tag PostHog events with build metadata.
# Defaults to "dev" for local `docker build` outside the release flow.
ARG STELLA_VERSION=dev
ARG STELLA_COMMIT_SHA=dev
ARG RAILWAY_GIT_COMMIT_SHA=dev
ENV STELLA_VERSION=${STELLA_VERSION}
ENV STELLA_COMMIT_SHA=${STELLA_COMMIT_SHA}
ENV RAILWAY_GIT_COMMIT_SHA=${RAILWAY_GIT_COMMIT_SHA}
ENV NODE_ENV=production
ENV FEATURE_CHAT=true
ENV FEATURE_CONTACTS=true
ENV FEATURE_DESKTOP_EDITING=true
ENV FEATURE_KNOWLEDGE_TEMPLATES=true
ENV FEATURE_TODOS=true
ENV REQUIRE_PERSONAL_AI_KEY=true
ENV STELLA_WORKER_DIR=/\$bunfs/root/workers
ENV STELLA_OCR_PDF_FONT_PATH=/\$bunfs/root/fonts/CabinetGrotesk-Regular.otf
ENV DOCUMENT_OCR_MODEL_DIR=/app/ocr-models
ENV TEMPLATE_PACKS_CONTENT_DIR=/app/template-packs-content
RUN groupadd --system --gid 1001 stella && \
    useradd --system --uid 1001 --gid stella --no-create-home stella
COPY --chown=stella:stella --from=builder /app/server /app/server
COPY --chown=stella:stella --from=builder /app/backfill.js /app/backfill.js
COPY --chown=stella:stella --from=builder /app/better-auth-migration-audit.js /app/better-auth-migration-audit.js
COPY --chown=stella:stella --from=builder /app/better-auth-microsoft-identity-map.js /app/better-auth-microsoft-identity-map.js
COPY --chown=stella:stella --from=builder /app/better-auth-17-backfill.js /app/better-auth-17-backfill.js
COPY --chown=stella:stella --from=builder /app/database-census.js /app/database-census.js
COPY --chown=stella:stella --from=builder /app/document-processing-worker.js /app/document-processing-worker.js
COPY --chown=stella:stella --from=builder /app/apps/legal-atlas-runner/dist/index.js /app/legal-atlas.js
# Bundled migration task entrypoint:
#   ["bun", "/app/apps/api/src/db/migrate.js"]
COPY --chown=stella:stella --from=builder /app/apps/api/src/db/migrate.js /app/apps/api/src/db/migrate.js
# The bundled entrypoint reads migration SQL from this external folder.
COPY --chown=stella:stella --from=builder /app/apps/api/drizzle /app/apps/api/drizzle
RUN mkdir -p '/$bunfs/root'
COPY --chown=stella:stella --from=builder /app/runtime-workers /\$bunfs/root/workers
# ONNX Runtime is the one native exception: its binding dynamically links a
# sibling shared library, so Bun cannot embed it as one standalone asset. The
# bundled worker resolves this package-owned directory as `../bin`; the image
# smoke executes a real model so a broken native closure fails the build.
COPY --chown=stella:stella --from=builder /app/runtime-onnx/bin /\$bunfs/root/bin
COPY --chown=stella:stella --from=builder /app/ocr-models /app/ocr-models
COPY --chown=stella:stella --from=install-inputs \
    /app/apps/landing/public/fonts/CabinetGrotesk-Regular.otf \
    /\$bunfs/root/fonts/CabinetGrotesk-Regular.otf
COPY --chown=stella:stella --from=builder /app/apps/api/src/lib/file-scan/yara /\$bunfs/root/yara
# Bundled template packs: the manifest is compiled into the binary, the DOCX
# bytes are read from TEMPLATE_PACKS_CONTENT_DIR when a pack is installed.
# Copied from the unpruned context stage. A build whose context has no content
# submodule copies the empty mount point, and the catalogue is then empty.
COPY --chown=stella:stella --from=install-inputs \
    /app/packages/template-packs/content/ \
    /app/template-packs-content/
WORKDIR /app/apps/api

USER stella
EXPOSE 3001
CMD ["/app/server"]

# Throwaway verification stage: run the runtime-asset probe on the exact
# runner filesystem, so a missing or unloadable hand-copied asset fails the
# image build instead of the first request that reaches it. The probe binary
# never ships; the final stage below re-selects the runner and forces this
# stage into the build by copying its marker.
FROM runner AS runtime-asset-smoke
COPY --from=builder /app/image-smoke /tmp/image-smoke
RUN /tmp/image-smoke && touch /tmp/image-smoke-ok

FROM runner
COPY --chown=stella:stella --from=runtime-asset-smoke /tmp/image-smoke-ok /tmp/image-smoke-ok
