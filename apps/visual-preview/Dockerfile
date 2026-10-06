FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS builder
WORKDIR /app
COPY . .
# Match the API image's filtered, frozen install; materialize dependencies so
# the runtime image does not depend on the build cache's virtual store.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    BUN_INSTALL_GLOBAL_STORE=0 bun install --filter @stll/visual-preview --frozen-lockfile --ignore-scripts --network-concurrency=8
RUN bun build apps/visual-preview/src/handler.ts --target=node --format=esm \
    --external playwright-core --outfile /app/handler.mjs
RUN mkdir -p /runtime/node_modules && cp -RL node_modules/playwright-core /runtime/node_modules/
ADD --checksum=sha256:b6874fc0d7af15e16a15ef1b73177731f698c296c73d26aa4a90840c0777a338 \
    https://github.com/Sparticuz/chromium/releases/download/v153.0.0/chromium-v153.0.0-pack.arm64.tar /chromium.tar
RUN mkdir -p /chromium && tar -xf /chromium.tar -C /chromium

FROM public.ecr.aws/lambda/nodejs:22-arm64@sha256:3f965c1858f13651484a71587f2fa58717c1b906c33c26d79e1bd88783cc600b
COPY --from=builder /chromium /opt/chromium
COPY --from=builder /app/handler.mjs ${LAMBDA_TASK_ROOT}/handler.mjs
COPY --from=builder /runtime/node_modules ${LAMBDA_TASK_ROOT}/node_modules
CMD ["handler.handler"]
