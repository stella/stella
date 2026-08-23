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

const identifierValueSchema = v.pipe(
  v.string(),
  v.check(
    (value) => /\S/u.test(stripDangerousChars(value)),
    "Identifier values must contain visible content",
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
      value: identifierValueSchema,
    }),
    v.strictObject({
      type: v.literal(DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION),
      value: identifierValueSchema,
    }),
    v.strictObject({
      type: v.literal(DECISION_IDENTIFIER_TYPES.REPORTER_CITATION),
      value: identifierValueSchema,
    }),
  ]);

export const isDecisionIdentifier = (
  value: unknown,
): value is DecisionIdentifier =>
  v.safeParse(decisionIdentifierSchema, value).success;
