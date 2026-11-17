import type { SafeId } from "@/api/lib/branded-types";

import type { AggregateLockDefinition } from "../aggregate-lock-definition";

export default {
  rank: -10,
  kind: "row",
  holder: "application",
} as const satisfies AggregateLockDefinition;

export type Identity = {
  id: SafeId<"requestIdempotencyReceipt">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};
