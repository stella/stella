export type { RegistryAdapterShape, RegistryDescriptor } from "./adapter.js";
export type { CanonicalId, KnownCanonicalIdScheme } from "./canonical-id.js";
export { CANONICAL_ID_SCHEMES } from "./canonical-id.js";
export {
  isEntityNotFound,
  RegistryAuthRequiredError,
  RegistryDataPaywalledError,
  RegistryError,
  RegistryLicenceIncompatibleError,
  RegistryRateLimitedError,
  RegistryUnavailableError,
  RegistryValidationError,
} from "./errors.js";
export type { EntityNotFound } from "./errors.js";
export { clampSearchLimit } from "./search.js";
export type {
  NormalizedRegistryAddress,
  NormalizedRegistryBirthDate,
  NormalizedRegistryCapital,
  NormalizedRegistryEntity,
  NormalizedRegistryEntityFields,
  NormalizedRegistryField,
  NormalizedRegistryIdentifier,
  NormalizedRegistryKeyPeopleGroup,
  NormalizedRegistryKeyPerson,
  NormalizedRegistryRecord,
  NormalizedRegistrySearchFields,
  NormalizedRegistrySearchResult,
  NormalizedRegistryWarning,
} from "./normalized.js";
export type { EntityStatus } from "./status.js";
export { mapEntityStatus } from "./status.js";
