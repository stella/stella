# Pin to digest for supply-chain integrity (oven/bun:1.4.4-slim)
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS base
WORKDIR /app
# BEGIN GENERATED INSTALL TOOLING
COPY packages/scripts/src/child-exit-status.ts packages/scripts/src/child-exit-status.ts
COPY packages/sha256/src/bun.ts packages/sha256/src/bun.ts
COPY scripts/ci-install-store.ts scripts/ci-install-store.ts
COPY scripts/ci-install.ts scripts/ci-install.ts
# END GENERATED INSTALL TOOLING

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

# Prune the monorepo for the API image entrypoints.
FROM base AS pruner
COPY package.json .
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun scripts/ci-install.ts /tmp/pruner-install.log -g "turbo@$(bun -p 'require("./package.json").devDependencies.turbo')"
COPY . .
RUN turbo prune @stll/api @stll/collab @stll/legal-atlas-runner --docker

# Install dependencies using only package manifests (cached layer)
FROM base AS deps
COPY --from=install-inputs /json/ .
# The cache mount is detached after this layer, so packages must be
# materialized under /app instead of linked into the global virtual store.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    BUN_INSTALL_GLOBAL_STORE=0 bun scripts/ci-install.ts /tmp/deps-install.log --filter @stll/api --filter @stll/collab --filter @stll/legal-atlas-runner --frozen-lockfile --ignore-scripts --network-concurrency=8

# Copy source code and compile the API to a Bun binary.
#
# NODE_ENV must be set before the first `bun build`: Bun inlines direct
# `process.env.NODE_ENV` reads (dependencies included) at bundle time, and
# inlines "development" when it is unset. Every bundle is also built with
# `--define __STELLA_RELEASE__=true`, so a published artifact refuses local
# development access whatever its runtime environment says.
FROM deps AS builder
ARG TARGETARCH
ENV NODE_ENV=production
COPY --from=pruner /app/out/full/ .
# Generator inputs outside the pruned API workspace graph.
COPY --from=install-inputs /app/apps/web/src/fonts.css /app/apps/web/src/fonts.css
COPY --from=install-inputs /app/apps/web/src/i18n/langs/ /app/apps/web/src/i18n/langs/
COPY --from=install-inputs /app/apps/web/public/fonts/ /app/apps/web/public/fonts/
COPY --from=install-inputs /app/scripts/generated-artifacts.ts /app/scripts/generated-artifacts.ts
RUN bun apps/api/scripts/generate-capability-runtime.ts
RUN bun apps/api/scripts/generate-mcp-app-contracts.ts && bun packages/mcp-apps/scripts/build-mcp-apps.ts
# Build the server unminified: `bun build --minify` can break Elysia's AOT
# handler codegen (minified variable renames vs Sucrose). See elysiajs/elysia#1711.
# The server and collab are bundles run by the image's Bun, not --compile
# binaries: each compiled binary embeds another full copy of the runtime.
# Every bundle sets --public-path to the directory it lands in on the runner.
# Without it Bun emits `with { type: "file" }` asset paths as "./name-hash.ext",
# which resolve against the working directory instead of the bundle.
# Long-running bundles ship a linked source map so error frames name source
# positions; the strip step drops the embedded source text, which runtime
# mapping never reads.
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --sourcemap=linked \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming server.js \
    apps/api/src/server.ts && \
    bun apps/api/scripts/strip-source-map-content.ts /app/bundles/server.js.map
# Dedicated Hocuspocus collaboration service. The infrastructure runs it from
# the same immutable image with command override ["/app/collab"], through the
# apps/api/docker/collab launcher.
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming collab.js \
    apps/collab/src/index.ts
# One-off maintenance tool: assigns public slugs to legacy case-law rows that
# predate slug-at-ingest. Bundled to JS with sidecar assets (like the workers,
# not --compile) so it reuses the container's Bun runtime instead of embedding
# a second copy; bundling still resolves the `@/api/*` aliases. Run as a one-off
# task on the API task-def (it needs the API env, not the migrate env):
#   command override -> ["bun", "/app/backfill.js"]
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming backfill.js \
    apps/api/src/scripts/backfill-case-law-slugs.ts
# Deployment-owned usage policy configuration; run explicitly after migrations:
#   command override -> ["bun", "/app/seed-usage-policies.js"]
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming seed-usage-policies.js \
    apps/api/scripts/seed-usage-policies.ts
# Replays one stored hosted-usage provider event at a time. Run with the API
# task's database credentials. --apply requires --requested-by (a claimed
# operator label) and --reason.
# Replay performer is the ECS task ARN; metadata resolution must succeed.
#   command override -> ["bun", "/app/replay-provider-events.js"]
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming replay-provider-events.js \
    apps/api/scripts/replay-provider-events.ts
# Better Auth migration rehearsal validator. It accepts only a database
# credential plus a private tmpfs baseline path; stdout is a redacted JSON
# report. Run on the isolated clone task with command override:
#   ["bun", "/app/better-auth-migration-audit.js", "pre-migration",
#    "--baseline", "/tmp/better-auth-baseline.json", "--identity-map",
#    "/tmp/better-auth-identity-map.json", "--oauth-base-url",
#    "https://api.stll.app"]
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming better-auth-migration-audit.js \
    apps/api/src/scripts/better-auth-migration-audit.ts
# Trusted Microsoft identity-map derivation for the Better Auth rehearsal. It
# reads stored ID tokens only inside the isolated task and writes the verified
# sub-to-oid map to the task's private tmpfs without logging identity values.
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming better-auth-microsoft-identity-map.js \
    apps/api/src/scripts/better-auth-microsoft-identity-map.ts
# Bounded Better Auth bridge backfill. The command reproduces the private
# baseline before mutating and runs the post-backfill audit before succeeding.
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming better-auth-17-backfill.js \
    apps/api/src/scripts/better-auth-17-backfill.ts
# Whole-database census (counts, digests, foreign-key orphans) recorded before
# a migration rehearsal and compared after it.
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming database-census.js \
    apps/api/src/scripts/database-census.ts
# Replays stored sign-ins and sessions against a migrated database with the
# provider served locally; counts only.
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming better-auth-sign-in-replay.js \
    apps/api/src/scripts/better-auth-sign-in-replay.ts
# Case-law source replay: re-parses stored raw sources with the current
# parsers and, when asked, withdraws a stored document that no longer parses.
# It needs the API env (database, corpus bucket), so it runs inside the API
# task like backfill.js:
#   ["bun", "/app/replay-case-law-source.js", "--adapter", "eu-ecj"]
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming replay-case-law-source.js \
    apps/api/src/scripts/replay-case-law-source.ts
# Restricted review account commands: `provision` creates the account, its
# organization and owner membership; `set-password` reads the password from
# standard input.
#   ["bun", "/app/review-account.js", "provision"]
#   ["bun", "/app/review-account.js", "set-password"]
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming review-account.js \
    apps/api/src/scripts/review-account.ts
# One bounded, load-aware background replay tick; enrolment is reviewed in code.
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming replay-tick.js \
    apps/api/src/scripts/replay-tick.ts
# Weekly Czech Constitutional Court roster import and load-aware relink.
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming import-cz-us-roster.js \
    apps/api/src/scripts/import-cz-us-roster.ts
# Bounded EU completion ticks and operator controls.
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming eu-completion-tick.js \
    apps/api/src/scripts/eu-completion-tick.ts
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming eu-completion-control.js \
    apps/api/src/scripts/eu-completion-control.ts
# Case-law erasure and raw-storage operator passes. They delete from the
# documents bucket, so they run inside the API task, whose role may:
#   ["bun", "/app/redact-case-law-decision.js", "<decision id>"]
#   ["bun", "/app/case-law-raw-layout.js", "sweep-legacy", "--source", "<id>"]
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming redact-case-law-decision.js \
    apps/api/src/scripts/redact-case-law-decision.ts
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming case-law-raw-layout.js \
    apps/api/src/scripts/case-law-raw-layout.ts
# SK ÚS raw completion runs as its own one-off task with a scoped login rather
# than inside the API task; it reports without writing until `--apply`:
#   ["bun", "/app/complete-sk-us-raw.js", "--checkpoint", "/tmp/sk-us.json"]
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming complete-sk-us-raw.js \
    apps/api/src/scripts/complete-sk-us-raw.ts
# Decision-analysis operator pass. Like replay above, these need the API env
# (corpus bucket, storage mode) and run inside the API task, but their
# database login is overridden per task to the analysis writer role through
# CASE_LAW_ANALYSIS_DATABASE_URL:
#   ["bun", "/app/decision-analysis-candidates.js", "--country", "CZE"]
#   ["bun", "/app/decision-analysis-input.js", "--ids-file", "/tmp/ids.txt"]
#   ["bun", "/app/decision-analysis-save.js", "--input", "/tmp/analyses.json"]
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming decision-analysis-candidates.js \
    apps/api/src/scripts/decision-analysis-candidates.ts
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming decision-analysis-input.js \
    apps/api/src/scripts/decision-analysis-input.ts
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming decision-analysis-save.js \
    apps/api/src/scripts/decision-analysis-save.ts
# One-shot case-law repair passes over rows an earlier write path produced.
# Both need the API env (database, corpus bucket) and run inside the API task;
# both report without writing until `--apply`:
#   ["bun", "/app/repair-publisher-absent-text.js", "--apply"]
#   ["bun", "/app/repair-cz-ns-court.js", "--apply"]
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming repair-publisher-absent-text.js \
    apps/api/src/scripts/repair-publisher-absent-text.ts
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming repair-cz-ns-court.js \
    apps/api/src/scripts/repair-cz-ns-court.ts
# Citation polarity pass. `--recheck` re-reads a language's labelled citations
# against the rule tier and tightens a label only towards a more severe
# reading, which is the pass to run after new negative rules are seeded. Needs
# the API env (database) and runs inside the API task:
#   ["bun", "/app/classify-citations.js", "--recheck", "--language", "cs"]
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming classify-citations.js \
    apps/api/scripts/classify-citations.ts
# Reviewed citation polarities: stores them and applies them to the current
# citation rows. Needs the API env (database) and runs inside the API task;
# reports without writing until `--apply`:
#   ["bun", "/app/apply-reviewed-citation-labels.js", "--file", "/tmp/labels.json",
#    "--results", "/tmp/results.jsonl", "--apply"]
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming apply-reviewed-citation-labels.js \
    apps/api/src/scripts/apply-reviewed-citation-labels.ts
# Corpus generation registry: status, register, and the serving flip, which
# checks the target's indexes on the search endpoint first. Needs the API env
# (database, search endpoint); reports without writing until `--apply`:
#   ["bun", "/app/corpus-generation.js", "serve", "--family", "case_law", "--generation", "<generation>"]
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming corpus-generation.js \
    apps/api/src/scripts/corpus-generation.ts
# Read-only snippet comparison over the serving corpus index. Reads its query
# set from a JSON file, so the committed sample ships next to the bundle:
#   ["bun", "/app/corpus-snippet-compare.js",
#    "--queries", "/app/corpus-snippet-compare.sample.json",
#    "--out-dir", "/tmp/snippets"]
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming corpus-snippet-compare.js \
    apps/api/src/scripts/corpus-snippet-compare.ts
# Dedicated durable document-processing worker. Deploy the same image with
# command override ["bun", "/app/document-processing-worker.js"]. OCR runs
# in-image through the isolated local ONNX worker.
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --sourcemap=linked \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming document-processing-worker.js \
    apps/api/src/scripts/document-processing-worker.ts && \
    bun apps/api/scripts/strip-source-map-content.ts /app/bundles/document-processing-worker.js.map
# Bundle the migration entrypoint so its full transitive @/api import graph is
# resolved at build time. Mirror the source directory under the bundle tree
# so its runtime `import.meta.dir`-relative migrationsFolder lookup resolves
# to /app/apps/api/drizzle after the tree is copied to /app.
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles/apps/api/src/db \
    --public-path /app/apps/api/src/db/ \
    --entry-naming migrate.js \
    apps/api/src/db/migrate.ts
# All script bundles use --outdir so native addons can be emitted as sidecars.
# The shared bundle tree mirrors /app in the runner and is copied wholesale;
# --entry-naming preserves operator, migration, and worker entrypoint paths.
# The same-stage cp calls materialize assets reached through package symlinks
# before the cross-stage COPY.
RUN mkdir -p /app/bundles/runtime/workers && \
    bun build \
      --define __STELLA_RELEASE__=true \
      --target bun \
      --outdir /app/bundles/runtime/workers \
      --public-path /app/runtime/workers/ \
      --entry-naming sanctions-matcher-worker.js \
      apps/api/src/lib/lists/sanctions/sanctions-matcher-worker.ts && \
    bun build \
      --define __STELLA_RELEASE__=true \
      --target bun \
      --outdir /app/bundles/runtime/workers \
      --public-path /app/runtime/workers/ \
      --entry-naming pdf-worker.js \
      apps/api/src/lib/files/pdf-worker.ts && \
    bun build \
      --define __STELLA_RELEASE__=true \
      --target bun \
      --outdir /app/bundles/runtime/workers \
      --public-path /app/runtime/workers/ \
      --entry-naming extraction-worker.js \
      apps/api/src/lib/search/extraction-worker.ts && \
    bun build \
      --define __STELLA_RELEASE__=true \
      --target bun \
      --outdir /app/bundles/runtime/workers \
      --public-path /app/runtime/workers/ \
      --entry-naming ocr-searchable-pdf-worker.js \
      apps/api/src/lib/ocr-searchable-pdf-worker.ts && \
    bun build \
      --define __STELLA_RELEASE__=true \
      --target bun \
      --outdir /app/bundles/runtime/workers \
      --public-path /app/runtime/workers/ \
      --entry-naming office-evidence-worker.js \
      apps/api/src/lib/files/office-evidence-worker.ts && \
    bun build \
      --define __STELLA_RELEASE__=true \
      --target bun \
      --outdir /app/bundles/runtime/workers \
      --public-path /app/runtime/workers/ \
      --entry-naming ocr-local-worker.js \
      apps/api/src/lib/ocr-local/ocr-local-worker.ts && \
    cp node_modules/@silurus/ooxml/dist/xlsx_parser_bg.wasm \
      /app/bundles/runtime/workers/xlsx_parser_bg.wasm && \
    cp node_modules/@silurus/ooxml/dist/pptx_parser_bg.wasm \
      /app/bundles/runtime/workers/pptx_parser_bg.wasm && \
    cp node_modules/@embedpdf/pdfium/dist/pdfium.wasm \
      /app/bundles/runtime/workers/pdfium.wasm && \
    cp apps/api/src/lib/ocr-local/latin-v5-dict.txt \
      /app/bundles/runtime/workers/latin-v5-dict.txt
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
RUN DATABASE_URL=postgres://smoke:smoke@localhost:5432/smoke \
    S3_ENDPOINT=http://localhost \
    S3_BUCKET=smoke \
    S3_REGION=eu-central-1 \
    bun apps/legal-atlas-runner/dist/index.js run eu-ecj-refetch --help
# Exercise the model guard as a JS bundle on the runner filesystem, where
# native addons load from sidecars.
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming image-smoke-model-ingress.js \
    apps/api/src/scripts/image-smoke-model-ingress.ts
# Runtime-asset smoke probe: initializes the anonymize and QuickJS runtimes,
# plus the external YARA rules, worker bundles, OCR model, and font. Bundled
# like the server, so its native addons and WASM load from the same sidecar
# layout, and run by the verification stage below.
RUN bun build \
    --define __STELLA_RELEASE__=true \
    --target bun \
    --outdir /app/bundles \
    --public-path /app/ \
    --entry-naming image-smoke.js \
    apps/api/src/scripts/image-smoke.ts

# Run the API as non-root. Built from the bare base image: every entrypoint is
# a self-contained `bun build --target bun` bundle run by the image's Bun, so
# the runtime image ships one runtime plus those outputs and the asset trees
# they read at runtime; the workspace install (node_modules, manifest tree)
# stays in the build stages.
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
ENV REQUIRE_PERSONAL_AI_KEY=true
ENV STELLA_WORKER_DIR=/app/runtime/workers
ENV STELLA_OCR_PDF_FONT_PATH=/app/runtime/fonts/CabinetGrotesk-Regular.otf
ENV STELLA_YARA_RULES_DIR=/app/yara
ENV DOCUMENT_OCR_MODEL_DIR=/app/ocr-models
ENV TEMPLATE_PACKS_CONTENT_DIR=/app/template-packs-content
RUN groupadd --system --gid 1001 stella && \
    useradd --system --uid 1001 --gid stella --no-create-home stella
COPY --chown=stella:stella --from=builder /app/bundles/ /app/
# The collab task definition runs ["/app/collab"]: a launcher for the bundle.
COPY --chown=stella:stella --from=install-inputs /app/apps/api/docker/collab /app/collab
# The snippet report reads its query set from a file passed with `--queries`.
COPY --chown=stella:stella --from=builder /app/apps/api/src/scripts/corpus-snippet-compare.sample.json /app/corpus-snippet-compare.sample.json
COPY --chown=stella:stella --from=builder /app/apps/legal-atlas-runner/dist/index.js /app/legal-atlas.js
COPY --chown=stella:stella --from=builder /app/apps/legal-atlas-runner/dist/eu-ecj-refetch.js /app/eu-ecj-refetch.js
# The bundled entrypoint reads migration SQL from this external folder.
COPY --chown=stella:stella --from=builder /app/apps/api/drizzle /app/apps/api/drizzle
# ONNX Runtime is the one native exception: its binding dynamically links a
# sibling shared library, so Bun cannot embed it as one standalone asset. The
# bundled worker resolves this package-owned directory as `../bin`; the image
# smoke executes a real model so a broken native closure fails the build.
COPY --chown=stella:stella --from=builder /app/runtime-onnx/bin /app/runtime/bin
COPY --chown=stella:stella --from=builder /app/ocr-models /app/ocr-models
COPY --chown=stella:stella --from=install-inputs \
    /app/apps/landing/public/fonts/CabinetGrotesk-Regular.otf \
    /app/runtime/fonts/CabinetGrotesk-Regular.otf
COPY --chown=stella:stella --from=builder /app/apps/api/src/lib/file-scan/yara /app/yara
# Bundled template packs: the manifest is compiled into the binary, the DOCX
# bytes are read from TEMPLATE_PACKS_CONTENT_DIR when a pack is installed.
# Copied from the unpruned context stage. A build whose context has no content
# submodule fails the runtime-asset smoke below.
COPY --chown=stella:stella --from=install-inputs \
    /app/packages/template-packs/content/ \
    /app/template-packs-content/
WORKDIR /app/apps/api

USER stella
EXPOSE 3001 3002
# --no-env-file: a release never reads a .env from its working directory.
CMD ["bun", "--no-env-file", "/app/server.js"]

# Throwaway verification stage: run the runtime-asset probe on the exact
# runner filesystem, so a missing or unloadable hand-copied asset fails the
# image build instead of the first request that reaches it. The final stage
# below re-selects the runner and forces this stage into the build by copying
# its marker.
FROM runner AS runtime-asset-smoke
RUN bun --no-env-file /app/image-smoke.js && touch /tmp/image-smoke-ok

FROM runner
COPY --chown=stella:stella --from=runtime-asset-smoke /tmp/image-smoke-ok /tmp/image-smoke-ok
