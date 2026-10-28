// Passive regression fixture for require-safe-route-handlers. An imported
// endpoint is the common allowed case; the rule test covers it, since a
// fixture importing an endpoint module would load the API.

type Definition = {
  config: Record<string, unknown>;
  access: string;
  run: () => Promise<unknown>;
};
declare const routes: (
  table: Record<string, Record<string, Definition>>,
) => unknown;
declare const defineEndpoint: {
  public: (config: object, handler: () => unknown) => Definition;
};
declare const createSafeRootHandler: (
  config: object,
  handler: () => unknown,
) => Definition;
declare const run: () => Promise<unknown>;

const updateThing = createSafeRootHandler({}, () => ({}));

export const rawRoutes = routes({
  // oxlint-disable-next-line require-safe-route-handlers/require-safe-route-handlers -- fixture: a thin endpoint skips the safe-handler boundary
  "/thin": { GET: defineEndpoint.public({}, () => ({})) },
  // oxlint-disable-next-line require-safe-route-handlers/require-safe-route-handlers -- fixture: a hand-built definition skips every factory
  "/hand-built": { POST: { config: {}, access: "public", run } },
});

// expect-clean: require-safe-route-handlers/require-safe-route-handlers
export const safeRoutes = routes({ "/safe": { PATCH: updateThing } });

// oxlint-disable-next-line require-safe-route-handlers/no-direct-handler-config -- fixture: a write through Object.assign escapes the readonly config type
Object.assign(updateThing.config, { permissions: {} });

// expect-clean: require-safe-route-handlers/no-direct-handler-config
export const projectedConfig = { ...updateThing.config, access: "public" };
