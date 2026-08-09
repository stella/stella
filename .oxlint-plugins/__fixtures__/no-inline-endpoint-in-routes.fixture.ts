// Passive regression fixture for
// `no-inline-endpoint-in-routes/no-inline-endpoint-in-routes`.

declare const config: unknown;
declare const createSafeHandler: (options: unknown) => unknown;
declare const createSafeRootHandler: (options: unknown) => unknown;
declare const endpointFactory: {
  createSafeHandler: (options: unknown) => unknown;
};

// MUST flag: route files must not define ordinary safe handlers inline.
// oxlint-disable-next-line no-inline-endpoint-in-routes/no-inline-endpoint-in-routes -- fixture: endpoint definitions belong in their owning module
export const inlineHandler = createSafeHandler(config);

// MUST flag: root handlers follow the same vertical-slice boundary.
// oxlint-disable-next-line no-inline-endpoint-in-routes/no-inline-endpoint-in-routes -- fixture: root endpoint definitions must also move to an endpoint module
export const inlineRootHandler = createSafeRootHandler(config);

// Allowed: member calls are not local endpoint factory definitions.
export const delegatedFactoryCall = endpointFactory.createSafeHandler(config);

// Allowed: mounting an already-created endpoint is outside this rule.
declare const endpoint: { handler: unknown };
export const mountedHandler = endpoint.handler;
