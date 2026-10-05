/** How the linked consolidation was selected, independently of extraction status. */
export const PROVISION_VERSION_BASIS_TYPES = ["inferred"] as const;

export type ProvisionVersionBasis = {
  [Type in (typeof PROVISION_VERSION_BASIS_TYPES)[number]]: {
    type: Type;
    kind: "decision_date";
  };
}[(typeof PROVISION_VERSION_BASIS_TYPES)[number]];

/** Existing writers select consolidations at the decision date. */
export const DECISION_DATE_VERSION_BASIS = {
  type: "inferred",
  kind: "decision_date",
} as const satisfies ProvisionVersionBasis;
