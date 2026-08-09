// Passive regression fixture for require-safe-route-handlers.

declare const app: {
  get: (path: string, handler: unknown) => unknown;
  post: (path: string, handler: unknown) => unknown;
};
declare const rawHandler: unknown;
declare const endpoint: { handler: unknown };

// oxlint-disable-next-line require-safe-route-handlers/require-safe-route-handlers -- fixture: raw handler bypasses the safe endpoint boundary
export const rawRoute = app.get("/raw", rawHandler);

export const safeRoute = app.post("/safe", endpoint.handler);
