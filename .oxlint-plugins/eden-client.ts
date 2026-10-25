// The browser's Eden clients, shared by the capability-request rule and the
// undeclared-write ratchet so both recognise the same writes. Modules are
// canonical ids (`canonicalModuleId`), so aliases and relative imports match.
export const EDEN_CLIENT_MODULES = [
  "apps/web/src/lib/api",
  "apps/web/src/lib/eden-client",
];

export const EDEN_CLIENT_EXPORTS = new Set([
  "api",
  "linkIconsApi",
  "correspondenceApi",
  "memoriesApi",
  "myTimeEntriesApi",
  "publicFeedbackApi",
]);

export const EDEN_WRITE_METHODS = new Set(["post", "put", "patch", "delete"]);

// Eden writes take `(body, options)`; request options travel second, even
// for a body-less `delete(undefined, request)`.
export const EDEN_WRITE_OPTIONS_INDEX = 1;
