import type { SafeId } from "@/api/lib/branded-types";

import type { AggregateLockDefinition } from "../aggregate-lock-definition";

export default {
  rank: 140,
  kind: "row",
} as const satisfies AggregateLockDefinition;

export type Identity = {
  id: string;
  threadId: SafeId<"chatThread">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};
