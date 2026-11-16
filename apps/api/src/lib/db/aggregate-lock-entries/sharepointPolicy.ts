import type { SafeId } from "@/api/lib/branded-types";

import type { AggregateLockDefinition } from "../aggregate-lock-definition";

// The organization's SharePoint and Microsoft 365 capability policy row.
// Taken before a member's connection row, so consent, refresh and revocation
// serialize on one order.
export default {
  rank: 6,
  kind: "row",
  holder: "application",
} as const satisfies AggregateLockDefinition;

export type Identity = SafeId<"organization">;
