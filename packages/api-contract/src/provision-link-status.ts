/** First-match order for the stored provision links of a decision. */
export const PROVISION_LINK_STATUS_TYPES = [
  "out_of_scope",
  "withheld",
  "unavailable",
  "unplaceable",
  "failed",
  "current",
  "stale",
  "legacy",
  "pending",
] as const;

type ProvisionLinkStatusType = (typeof PROVISION_LINK_STATUS_TYPES)[number];

export type ProvisionLinkStatus = {
  [Type in ProvisionLinkStatusType]: { type: Type };
}[ProvisionLinkStatusType];
