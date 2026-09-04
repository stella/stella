import { panic } from "better-result";
import * as v from "valibot";

import { stripDangerousChars } from "./text-sanitize.js";

export const DECISION_IDENTIFIER_TYPES = {
  CASE_NUMBER: "case-number",
  ECLI: "ecli",
  NEUTRAL_CITATION: "neutral-citation",
  REPORTER_CITATION: "reporter-citation",
} as const;

export type DecisionIdentifierType =
  (typeof DECISION_IDENTIFIER_TYPES)[keyof typeof DECISION_IDENTIFIER_TYPES];

export type CaseNumberIdentifier = {
  type: typeof DECISION_IDENTIFIER_TYPES.CASE_NUMBER;
  value: string;
};

export type EcliIdentifier = {
  type: typeof DECISION_IDENTIFIER_TYPES.ECLI;
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
  | CaseNumberIdentifier
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
  stripDangerousChars(value)
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[\p{P}\p{Z}\s]+/gu, "")
    .trim();

const identifierValueSchema = v.pipe(
  v.string(),
  v.maxLength(DECISION_IDENTIFIER_MAX_LENGTH),
  v.check(
    (value) => /\S/u.test(stripDangerousChars(value)),
    "Identifier values must contain visible content",
  ),
);

const structuredIdentifierValueSchema = v.pipe(
  identifierValueSchema,
  v.check(
    (value) => normalizeStructuredCitation(value).length > 0,
    "Structured identifier values must contain searchable content",
  ),
);

export const decisionIdentifierSchema: v.GenericSchema<DecisionIdentifier> =
  v.variant("type", [
    v.strictObject({
      type: v.literal(DECISION_IDENTIFIER_TYPES.CASE_NUMBER),
      value: identifierValueSchema,
    }),
    v.strictObject({
      type: v.literal(DECISION_IDENTIFIER_TYPES.ECLI),
      value: structuredIdentifierValueSchema,
    }),
    v.strictObject({
      type: v.literal(DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION),
      value: structuredIdentifierValueSchema,
    }),
    v.strictObject({
      type: v.literal(DECISION_IDENTIFIER_TYPES.REPORTER_CITATION),
      value: structuredIdentifierValueSchema,
    }),
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
  identifier: Exclude<DecisionIdentifier, CaseNumberIdentifier>,
): string => {
  switch (identifier.type) {
    case DECISION_IDENTIFIER_TYPES.ECLI:
      return normalizeStructuredCitation(identifier.value).replace(
        /^ecli/u,
        "",
      );
    case DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION:
    case DECISION_IDENTIFIER_TYPES.REPORTER_CITATION:
      return normalizeStructuredCitation(identifier.value);
    default: {
      identifier satisfies never;
      return panic(`Unhandled identifier: ${String(identifier)}`);
    }
  }
};
