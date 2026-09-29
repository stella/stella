import type {
  EntityType,
  FieldComparison,
  IdentityField,
} from "@stll/sanctions";

// Closed vocabularies of sanctions screening results, kept apart from the
// service so output schemas can name them without loading the service.

export const SANCTIONS_CLASSIFICATIONS = ["binding", "informational"] as const;

export type SanctionsClassification =
  (typeof SANCTIONS_CLASSIFICATIONS)[number];

export const SANCTIONS_SCREENING_STATUSES = [
  "clear",
  "possible-match",
  "unavailable",
] as const;

export type SanctionsScreeningStatus =
  (typeof SANCTIONS_SCREENING_STATUSES)[number];

export const SANCTIONS_UNAVAILABLE_REASONS = [
  // No edition of the list has been loaded yet.
  "not-loaded",
  // The publisher refused the download.
  "access-denied",
  // The list has not been verified against its publisher within its limit.
  "stale",
  // The stored edition could not be read.
  "load-failed",
  // A company ID was given without a name and the register holds no company
  // under it, so there was no name to screen.
  "company-not-found",
  // A company ID was given without a name and the register did not answer.
  "registry-unavailable",
] as const;

export type SanctionsUnavailableReason =
  (typeof SANCTIONS_UNAVAILABLE_REASONS)[number];

// Value lists of the matcher's closed vocabularies, for output schemas.
export const SANCTIONS_ENTITY_TYPES = [
  "person",
  "organisation",
  "vessel",
  "aircraft",
  "unknown",
] as const satisfies readonly EntityType[];
export const SANCTIONS_FIELD_COMPARISONS = [
  "match",
  "mismatch",
  "not-compared",
] as const satisfies readonly FieldComparison[];
export const SANCTIONS_IDENTITY_FIELDS = [
  "birth-date",
  "nationality",
  "entity-type",
] as const satisfies readonly IdentityField[];

// A value the matcher adds must be listed, or its output fails the schema.
true satisfies [
  Exclude<EntityType, (typeof SANCTIONS_ENTITY_TYPES)[number]>,
  Exclude<FieldComparison, (typeof SANCTIONS_FIELD_COMPARISONS)[number]>,
  Exclude<IdentityField, (typeof SANCTIONS_IDENTITY_FIELDS)[number]>,
] extends [never, never, never]
  ? true
  : never;
