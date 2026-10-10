import { panic } from "better-result";

import type { AppliedProvisionVersion } from "./provision-applied-version";

/** How the linked consolidation was selected, independently of extraction status. */
export type ProvisionVersionBasis =
  | { type: "inferred"; kind: "decision_date" }
  | { type: "not_stated" }
  | (Exclude<AppliedProvisionVersion, { type: "not_stated" }> & {
      expression: { date: string; eli: string } | null;
    });

export type InferredProvisionVersionCandidate = {
  type: "inferred";
  kind: "decision_date";
  versionValidFrom: string | null;
};

/** Existing writers select consolidations at the decision date. */
export const DECISION_DATE_VERSION_BASIS = {
  type: "inferred",
  kind: "decision_date",
} as const satisfies ProvisionVersionBasis;

type ProvisionVersionSelection = {
  versionBasis: ProvisionVersionBasis;
  versionValidFrom: string | null;
};

type StatedDateRelation = Extract<
  ProvisionVersionBasis,
  { type: "stated_date" }
>["relation"];

// "In force until D" names the wording that ends at D; whether D itself is the
// last day or the next expression's first day is ambiguous, so an unresolved
// "until" selects nothing rather than possibly the following expression.
const statedDateAsOf = (date: string, relation: StatedDateRelation) => {
  switch (relation) {
    case "on":
    case "from":
      return date;
    case "until":
      return null;
    default: {
      relation satisfies never;
      return panic("Unknown stated date relation");
    }
  }
};

/** Only legacy links may use the decision date as a version selection. */
export const provisionVersionAsOf = (
  { versionBasis, versionValidFrom }: ProvisionVersionSelection,
  decisionDate: string | null,
): string | null => {
  switch (versionBasis.type) {
    case "inferred":
      return versionValidFrom ?? decisionDate;
    case "not_stated":
      return null;
    case "stated_date":
      return (
        versionBasis.expression?.date ??
        statedDateAsOf(versionBasis.date, versionBasis.relation)
      );
    case "stated_version":
      return versionBasis.expression?.date ?? null;
    default: {
      versionBasis satisfies never;
      return panic("Unknown provision version basis");
    }
  }
};
