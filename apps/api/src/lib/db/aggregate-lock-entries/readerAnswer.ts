import type { SafeId } from "@/api/lib/branded-types";

import type { AggregateLockDefinition } from "../aggregate-lock-definition";

export default {
  rank: 120,
  kind: "row",
} as const satisfies AggregateLockDefinition;

export type Identity = {
  id: SafeId<"legalReaderAnswer">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};
