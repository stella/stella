FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS bun
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS node
FROM rust:1.97.1-bookworm@sha256:0e2bcaef56d041a486784e54104a81aebe0da44bd03019bd70bc0401e42e4a97 AS tools

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx
ENV RUSTUP_TOOLCHAIN=1.97.1
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git python3 pkg-config libwebkit2gtk-4.1-dev \
      librsvg2-dev libayatana-appindicator3-dev patchelf \
    && rm -rf /var/lib/apt/lists/*

# Keep source, tests, toolchains and development dependencies for offline work.
# Resolve submodules from a full Git clone, then omit Git metadata from the image.
FROM tools AS install-inputs
COPY . /app
WORKDIR /app
RUN GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c protocol.allow=never \
      -c protocol.https.allow=always submodule update --init --recursive \
    && find /app -name .git -prune -exec rm -rf {} +

FROM tools
COPY --from=install-inputs /app /app
WORKDIR /app
RUN BUN_INSTALL_GLOBAL_STORE=0 bun install --frozen-lockfile --ignore-scripts --network-concurrency=8
RUN bun scripts/ci-generated-sources.ts prepare
RUN bun --filter @stll/api build && bun --filter @stll/collab build && bun --filter @stll/web build
RUN bun build --target=bun --outdir .audit-build/api apps/api/src/server.ts
RUN bun --filter @stll/desktop build:view
RUN cd apps/desktop/src-tauri && cargo fetch --locked && cargo build --locked
RUN bun --cwd apps/api run ocr:fetch-models
RUN node_modules/.bin/playwright install --with-deps chromium
RUN ln -s /app /src

WORKDIR /src

CMD ["bash"]
