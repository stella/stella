// Passive regression fixture for require-safe-route-handlers.

declare const app: {
  get: (path: string, handler: unknown) => unknown;
  post: (path: string, handler: unknown, options?: unknown) => unknown;
};
declare const rawHandler: unknown;
declare const endpoint: { handler: unknown };
declare const endpointWithConfig: {
  config: { body: unknown; permissions: unknown };
  handler: unknown;
};

// oxlint-disable-next-line require-safe-route-handlers/require-safe-route-handlers -- fixture: raw handler bypasses the safe endpoint boundary
export const rawRoute = app.get("/raw", rawHandler);

export const safeRoute = app.post("/safe", endpoint.handler);

export const mutableConfigRoute = app.post(
  "/mutable-config",
  endpointWithConfig.handler,
  // oxlint-disable-next-line require-safe-route-handlers/no-direct-handler-config -- fixture: Elysia must not receive the mutable endpoint config object
  endpointWithConfig.config,
);

export const projectedConfigRoute = app.post(
  "/projected-config",
  endpointWithConfig.handler,
  {
    body: endpointWithConfig.config.body,
    permissions: endpointWithConfig.config.permissions,
  },
);
