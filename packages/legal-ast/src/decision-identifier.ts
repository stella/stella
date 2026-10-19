// parser-output-unchanged: Unicode owner migration retains native normalization forms, mark classes and operation order; no folding is added.
// parser-output-unchanged: Identifier checks are named for schema publication; accepted values are identical.
// parser-output-unchanged: [cz-ns] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [cz-nss] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [cz-us] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [cz-regional] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [sk-courts] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [sk-us] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [pl-courts] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [pl-sn] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [pl-kio] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [pl-tk] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [pl-nsa] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [pl-ncourt] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [at-courts] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [at-vfgh] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [at-vwgh] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [at-bvwg] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [at-lvwg] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [at-asylgh] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [at-ubas] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [at-uvs] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [at-verg] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [at-umse] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [at-bks] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [at-findok] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [eu-ecj] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [hu-bhgy] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [pl-kis] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: [pl-uodo] adding the Commission identifier variant does not change this adapter’s emitted identifiers.
// parser-output-unchanged: the authority decision number type adds a union member; parsers that never emit it produce identical output.
import { panic } from "better-result";
import * as v from "valibot";

import { normalizeUnicode } from "@stll/text-normalize";

import { stripDangerousChars } from "./text-sanitize.js";

export const DECISION_IDENTIFIER_TYPES = {
  AUTHORITY_DECISION_NUMBER: "authority-decision-number",
  CASE_NUMBER: "case-number",
  COMMISSION_CASE_NUMBER: "commission-case-number",
  ECLI: "ecli",
  NEUTRAL_CITATION: "neutral-citation",
  REPORTER_CITATION: "reporter-citation",
} as const;

export type DecisionIdentifierType =
  (typeof DECISION_IDENTIFIER_TYPES)[keyof typeof DECISION_IDENTIFIER_TYPES];

/**
 * The kinds of reference a decision's primary one can be. An ECLI is never
 * the primary: decisions carry it in a field of its own.
 */
export const DECISION_PRIMARY_REFERENCE_TYPES = [
  DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION,
  DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
] as const;

export type DecisionPrimaryReferenceType =
  (typeof DECISION_PRIMARY_REFERENCE_TYPES)[number];

export type AuthorityDecisionNumberIdentifier = {
  type: typeof DECISION_IDENTIFIER_TYPES.AUTHORITY_DECISION_NUMBER;
  value: string;
};

export type CaseNumberIdentifier = {
  type: typeof DECISION_IDENTIFIER_TYPES.CASE_NUMBER;
  value: string;
};

export type EcliIdentifier = {
  type: typeof DECISION_IDENTIFIER_TYPES.ECLI;
  value: string;
};

export type CommissionCaseNumberIdentifier = {
  type: typeof DECISION_IDENTIFIER_TYPES.COMMISSION_CASE_NUMBER;
  value: string;
};

export type NeutralCitationIdentifier = {
  type: typeof DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION;
  value: string;
};

export type ReporterCitationIdentifier = {
  type: typeof DECISION_IDENTIFIER_TYPES.REPORTER_CITATION;
  value: string;
};

export type DecisionIdentifier =
  | AuthorityDecisionNumberIdentifier
  | CaseNumberIdentifier
  | CommissionCaseNumberIdentifier
  | EcliIdentifier
  | NeutralCitationIdentifier
  | ReporterCitationIdentifier;

/** A decision has one or more identifiers; parallel citations are separate items. */
export type DecisionIdentifiers = readonly [
  DecisionIdentifier,
  ...DecisionIdentifier[],
];

/** Shared storage boundary for every identifier spelling. */
export const DECISION_IDENTIFIER_MAX_LENGTH = 256;
export const DECISION_IDENTIFIER_MAX_COUNT = 32;

const normalizeStructuredCitation = (value: string): string =>
  normalizeUnicode(stripDangerousChars(value), "NFKC")
    .toLocaleLowerCase("und")
    .replace(/[\p{P}\p{Z}\s]+/gu, "")
    .trim();

const visibleContentCheck = v.check(
  (value: string) => /\S/u.test(stripDangerousChars(value)),
  "Identifier values must contain visible content",
);
const searchableContentCheck = v.check(
  (value: string) => normalizeStructuredCitation(value).length > 0,
  "Structured identifier values must contain searchable content",
);

/**
 * Checks JSON Schema cannot express. A converter publishes the remaining
 * bounded string and leaves these to runtime validation.
 */
export const DECISION_IDENTIFIER_RUNTIME_ONLY_CHECKS = [
  visibleContentCheck,
  searchableContentCheck,
] as const;

const identifierValueSchema = v.pipe(
  v.string(),
  v.maxLength(DECISION_IDENTIFIER_MAX_LENGTH),
  visibleContentCheck,
);

const structuredIdentifierValueSchema = v.pipe(
  identifierValueSchema,
  searchableContentCheck,
);

/** One branch of the identifier schema, for a field that holds only this kind. */
export const reporterCitationIdentifierSchema = v.strictObject({
  type: v.literal(DECISION_IDENTIFIER_TYPES.REPORTER_CITATION),
  value: structuredIdentifierValueSchema,
});

export const decisionIdentifierSchema: v.GenericSchema<DecisionIdentifier> =
  v.variant("type", [
    v.strictObject({
      type: v.literal(DECISION_IDENTIFIER_TYPES.AUTHORITY_DECISION_NUMBER),
      value: identifierValueSchema,
    }),
    v.strictObject({
      type: v.literal(DECISION_IDENTIFIER_TYPES.CASE_NUMBER),
      value: identifierValueSchema,
    }),
    v.strictObject({
      type: v.literal(DECISION_IDENTIFIER_TYPES.COMMISSION_CASE_NUMBER),
      value: structuredIdentifierValueSchema,
    }),
    v.strictObject({
      type: v.literal(DECISION_IDENTIFIER_TYPES.ECLI),
      value: structuredIdentifierValueSchema,
    }),
    v.strictObject({
      type: v.literal(DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION),
      value: structuredIdentifierValueSchema,
    }),
    reporterCitationIdentifierSchema,
  ]);

export const isDecisionIdentifier = (
  value: unknown,
): value is DecisionIdentifier =>
  v.safeParse(decisionIdentifierSchema, value).success;

/**
 * Canonical lookup spelling for identifiers whose syntax is globally stable.
 *
 * Case numbers are intentionally excluded: their meaningful separators and
 * prefixes are jurisdiction-specific, so the owning ingestion adapter must
 * normalize them with its case-number policy.
 */
export const normalizeStructuredDecisionIdentifier = (
  identifier: Exclude<
    DecisionIdentifier,
    AuthorityDecisionNumberIdentifier | CaseNumberIdentifier
  >,
): string => {
  switch (identifier.type) {
    case DECISION_IDENTIFIER_TYPES.ECLI:
      return normalizeStructuredCitation(identifier.value).replace(
        /^ecli/u,
        "",
      );
    case DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION:
    case DECISION_IDENTIFIER_TYPES.COMMISSION_CASE_NUMBER:
    case DECISION_IDENTIFIER_TYPES.REPORTER_CITATION:
      return normalizeStructuredCitation(identifier.value);
    default: {
      identifier satisfies never;
      return panic(`Unhandled identifier: ${String(identifier)}`);
    }
  }
};
