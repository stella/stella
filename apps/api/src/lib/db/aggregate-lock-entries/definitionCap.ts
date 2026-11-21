import type { SafeId } from "@/api/lib/branded-types";

import type { AggregateLockDefinition } from "../aggregate-lock-definition";

// Fence per-definition schedule reconciliation even before creation or after deletion.
export default {
  rank: 15,
  kind: "advisory",
} as const satisfies AggregateLockDefinition;

export type Identity = { definitionId: SafeId<"flowDefinition"> };
