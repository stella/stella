FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS bun
FROM node:26.12.1-bookworm-slim@sha256:88e480776c6149ff1d098cd304f44bf18057fb5d284a3329b78162d29821e28c AS node
FROM rust:1.99.1-bookworm@sha256:48b7f435b8fc6378ce43b44f15e3a47fd8919b2825f835c39bd4bd3da50af5b8 AS tools

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx
ENV RUSTUP_TOOLCHAIN=1.99.1
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
