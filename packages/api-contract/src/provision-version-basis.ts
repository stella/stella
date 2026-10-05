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
      return versionBasis.expression?.date ?? versionBasis.date;
    case "stated_version":
      return versionBasis.expression?.date ?? null;
    default: {
      versionBasis satisfies never;
      return panic("Unknown provision version basis");
    }
  }
};
