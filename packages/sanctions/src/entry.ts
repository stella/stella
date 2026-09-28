import { TaggedError } from "better-result";

import type { CountryCode } from "@stll/country-codes";

export type SanctionsSource = "eu" | "un" | "cz";

/** Which edition of a list was read; callers record it next to a screening. */
export type ListVersion = {
  source: SanctionsSource;
  /** ISO 8601 timestamp or date the publisher stamped on the edition. */
  publishedAt: string;
  /** Publisher's file identifier, when the edition carries one. */
  fileId: string | null;
};

export type EntityType = "person" | "organisation";

/** Lists mark some aliases as weak (nicknames, call signs, partial names). */
export type AliasQuality = "strong" | "weak";

export type SanctionsName = {
  name: string;
  quality: AliasQuality;
};

/**
 * A listed birth date at the precision the list states. `circa` marks dates
 * the list itself qualifies as approximate. A year range may be open at one
 * end ("born no later than 1980"), never at both.
 */
export type BirthDate =
  | {
      precision: "day";
      year: number;
      month: number;
      day: number;
      circa: boolean;
    }
  | { precision: "month"; year: number; month: number; circa: boolean }
  | { precision: "year"; year: number; circa: boolean }
  | {
      precision: "year-range";
      fromYear: number;
      toYear: number | null;
      circa: boolean;
    }
  | {
      precision: "year-range";
      fromYear: null;
      toYear: number;
      circa: boolean;
    };

/** `code` is set when the list's country resolves to an ISO 3166-1 code. */
export type Country = {
  code: CountryCode | null;
  name: string;
};

export type IdentifierKind =
  | "passport"
  | "national-id"
  | "registration"
  | "tax"
  | "imo"
  | "other";

export type Identifier = {
  kind: IdentifierKind;
  /** "known-false": the list marks the document as false; it identifies no one. */
  status: "listed" | "known-false";
  /** The list's own label for the document type. */
  label: string;
  number: string;
  country: Country | null;
};

export type Address = {
  street: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: Country | null;
};

export type SanctionsEntry = {
  source: SanctionsSource;
  /** Stable id of the entry within its source list. */
  sourceId: string;
  /** Publisher-facing reference (EU reference number, UN permanent reference). */
  referenceNumber: string | null;
  entityType: EntityType;
  /** Primary name first, then every alias the list gives. */
  names: SanctionsName[];
  birthDates: BirthDate[];
  nationalities: Country[];
  identifiers: Identifier[];
  addresses: Address[];
  /** Sanctions regime code, e.g. the EU programme or the UN committee list. */
  programme: string | null;
  /** The legal act that designated the entry. */
  legalBasis: string | null;
  /** ISO date the entry was designated. */
  listedOn: string | null;
  sourceUrl: string;
};

export type ParsedList = {
  version: ListVersion;
  entries: SanctionsEntry[];
};

export class SanctionsListParseError extends TaggedError(
  "SanctionsListParseError",
)<{
  code:
    | "malformed-input"
    | "unexpected-structure"
    | "missing-field"
    | "invalid-value"
    | "empty-list";
  message: string;
  source: SanctionsSource;
}> {}
