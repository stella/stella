// The browser's API client, shared by the capability-request rule and the
// undeclared-write ratchet so both recognise the same writes. Modules are
// canonical ids (`canonicalModuleId`), so aliases and relative imports match.
export const API_CLIENT_CLIENT_MODULES = ["apps/web/src/lib/api"];

// `api` is the versioned tree (`apiClient.v1`); `apiClient` reaches the rest.
export const API_CLIENT_CLIENT_EXPORTS = new Set(["api", "apiClient"]);

export const API_CLIENT_WRITE_METHODS = new Set([
  "post",
  "put",
  "patch",
  "delete",
]);

// Writes take `(body, options)`; request options travel second, even
// for a body-less `delete(undefined, request)`.
export const API_CLIENT_WRITE_OPTIONS_INDEX = 1;
