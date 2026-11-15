import type { SafeId } from "@/api/lib/branded-types";

import type { AggregateLockDefinition } from "../aggregate-lock-definition";

// A chat interaction fences the thread, then the turn, then its receipt.
export default {
  rank: 120,
  kind: "row",
  holder: "application",
} as const satisfies AggregateLockDefinition;

export type Identity = {
  id: SafeId<"chatThread">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};
