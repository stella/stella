/**
 * Path prefix shared by the REST router and direct-fetch clients. Its own
 * module so bundles that need only the prefix (the desktop's harness
 * sidecar) do not pull in the whole contract.
 */
export const STELLA_API_VERSION_PREFIX = "/v1" as const;
