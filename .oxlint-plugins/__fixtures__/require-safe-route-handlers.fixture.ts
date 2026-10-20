// Passive regression fixture for require-safe-route-handlers.

declare const app: {
  get: (path: string, handler: unknown) => unknown;
  post: (path: string, options: unknown, handler: unknown) => unknown;
};
declare const rawHandler: unknown;
declare const endpoint: { handler: unknown };
declare const endpointWithConfig: {
  config: { body: unknown; permissions: unknown };
  handler: unknown;
};

// oxlint-disable-next-line require-safe-route-handlers/require-safe-route-handlers -- fixture: raw handler skips the safe endpoint boundary
export const rawRoute = app.get("/raw", rawHandler);

// expect-clean: require-safe-route-handlers/require-safe-route-handlers
export const safeRoute = app.post("/safe", endpoint.handler);

export const mutableConfigRoute = app.post(
  "/mutable-config",
  // oxlint-disable-next-line require-safe-route-handlers/no-direct-handler-config -- fixture: Elysia must not receive the mutable endpoint config object
  endpointWithConfig.config,
  endpointWithConfig.handler,
);

export const projectedConfigRoute = app.post(
  "/projected-config",
  // expect-clean: require-safe-route-handlers/no-direct-handler-config
  {
    body: endpointWithConfig.config.body,
    permissions: endpointWithConfig.config.permissions,
  },
  endpointWithConfig.handler,
);
