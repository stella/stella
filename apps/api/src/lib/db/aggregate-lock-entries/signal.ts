import type { SafeId } from "@/api/lib/branded-types";

import type { AggregateLockDefinition } from "../aggregate-lock-definition";

export default {
  rank: 600,
  kind: "row",
} as const satisfies AggregateLockDefinition;

export type Identity = {
  id: SafeId<"signal">;
  organizationId: SafeId<"organization">;
};
