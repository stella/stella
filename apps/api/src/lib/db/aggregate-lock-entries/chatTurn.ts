import type { SafeId } from "@/api/lib/branded-types";

import type { AggregateLockDefinition } from "../aggregate-lock-definition";

export default {
  rank: 130,
  kind: "row",
} as const satisfies AggregateLockDefinition;

export type Identity = {
  threadId: SafeId<"chatThread">;
  toolCallId: string;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};
