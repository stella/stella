import type { AggregateName } from "../aggregate-lock";

// The organization's SharePoint and Microsoft 365 capability policy row, then
// a member's connection: consent, refresh and revocation serialize in this
// order.
export default [
  "organizationSettings",
  "sharepointConnection",
] as const satisfies readonly AggregateName[];
