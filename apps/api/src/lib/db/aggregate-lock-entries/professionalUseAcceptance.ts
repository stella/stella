import type { SafeId } from "@/api/lib/branded-types";

import type { AggregateLockDefinition } from "../aggregate-lock-definition";

export default {
  rank: 5,
  kind: "advisory",
} as const satisfies AggregateLockDefinition;

export type Identity = { userId: SafeId<"user"> };
