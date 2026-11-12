FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS builder
WORKDIR /app
COPY . .
# Match the API image's filtered, frozen install; the handler bundles every
# dependency, so the runtime image carries no node_modules.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    BUN_INSTALL_GLOBAL_STORE=0 bun install --filter @stll/skill-runner --frozen-lockfile --ignore-scripts --network-concurrency=8
RUN bun build apps/skill-runner/src/handler.ts --target=node --format=esm \
    --outfile /app/handler.mjs

FROM public.ecr.aws/lambda/nodejs:22-arm64@sha256:3f965c1858f13651484a71587f2fa58717c1b906c33c26d79e1bd88783cc600b
# The languages skills' scripts are written in: Bun (TypeScript) and Python.
RUN dnf install -y python3 && dnf clean all && rm -rf /var/cache/dnf
COPY --from=builder /usr/local/bin/bun /usr/local/bin/bun
COPY --from=builder /app/handler.mjs /var/task/handler.mjs
COPY --chmod=755 apps/skill-runner/entrypoint.sh /usr/local/bin/skill-runner-entrypoint
ENTRYPOINT ["/usr/local/bin/skill-runner-entrypoint"]
CMD ["handler.handler"]
