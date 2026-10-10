import type {
  EntityType,
  FieldComparison,
  IdentityField,
  SanctionsSource,
} from "@stll/sanctions";

import type { SANCTIONS_REPLACEMENT_GUARD_CODES } from "@/api/db/schema";

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
  // The stored edition could not be read or its screening could not complete.
  "load-failed",
  // A company ID was given without a name and the register holds no company
  // under it, so there was no name to screen.
  "company-not-found",
  // A company ID was given without a name and the register did not answer.
  "registry-unavailable",
] as const;

/**
 * The public search's reasons: also "warming", while an edition loads into
 * its matcher and the caller should ask again shortly. Only the public
 * matcher produces it, so signed-in output schemas leave it out.
 */
export const SANCTIONS_PUBLIC_UNAVAILABLE_REASONS = [
  ...SANCTIONS_UNAVAILABLE_REASONS,
  "warming",
] as const;

export type SanctionsUnavailableReason =
  (typeof SANCTIONS_PUBLIC_UNAVAILABLE_REASONS)[number];

/** The reasons a signed-in screening can give: never "warming". */
export type SanctionsSignedInUnavailableReason =
  (typeof SANCTIONS_UNAVAILABLE_REASONS)[number];

// Value lists of the matcher's closed vocabularies, for output schemas.
export const SANCTIONS_SOURCE_IDS = [
  "eu",
  "un",
  "cz",
  "us-sdn",
  "us-non-sdn",
  "uk",
  "ch",
] as const satisfies readonly SanctionsSource[];
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

/**
 * Why a newer edition of a list is held back from screening until it is
 * reviewed: the replacement guard that stopped it. The list keeps answering
 * from the edition it already had.
 */
export const SANCTIONS_PENDING_UPDATE_CODES = [
  // A first edition with fewer entries than the list's minimum.
  "below-minimum",
  // Shrank by more than a normal update removes.
  "contracted",
  // Not newer than the edition in use.
  "stale",
  // The file is an edition of a different list.
  "source-mismatch",
] as const;

export type SanctionsPendingUpdateCode =
  (typeof SANCTIONS_PENDING_UPDATE_CODES)[number];

type GuardCode = (typeof SANCTIONS_REPLACEMENT_GUARD_CODES)[number];

// A value the matcher or the refresh guard adds must be listed, or its output
// fails the schema; a listed value neither produces is dead.
true satisfies [
  Exclude<SanctionsSource, (typeof SANCTIONS_SOURCE_IDS)[number]>,
  Exclude<EntityType, (typeof SANCTIONS_ENTITY_TYPES)[number]>,
  Exclude<FieldComparison, (typeof SANCTIONS_FIELD_COMPARISONS)[number]>,
  Exclude<IdentityField, (typeof SANCTIONS_IDENTITY_FIELDS)[number]>,
  Exclude<GuardCode, SanctionsPendingUpdateCode>,
  Exclude<SanctionsPendingUpdateCode, GuardCode>,
] extends [never, never, never, never, never, never]
  ? true
  : never;
