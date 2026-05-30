export type { RegistryAdapterShape, RegistryDescriptor } from "./adapter.js";
export type { CanonicalId, KnownCanonicalIdScheme } from "./canonical-id.js";
export { CANONICAL_ID_SCHEMES, unsafeBrand } from "./canonical-id.js";
export {
  isEntityNotFound,
  RegistryAuthRequiredError,
  RegistryDataPaywalledError,
  RegistryError,
  RegistryLicenceIncompatibleError,
  RegistryRateLimitedError,
  RegistryUnavailableError,
} from "./errors.js";
export type { EntityNotFound } from "./errors.js";
export type { EntityStatus } from "./status.js";
export { mapEntityStatus } from "./status.js";
