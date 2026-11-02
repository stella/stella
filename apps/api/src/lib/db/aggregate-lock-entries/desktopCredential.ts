import type { SafeId } from "@/api/lib/branded-types";

import type { AggregateLockDefinition } from "../aggregate-lock-definition";

export default {
  rank: 80,
  kind: "row",
  holder: "owner",
} as const satisfies AggregateLockDefinition;

export type Identity = { id: string; userId: SafeId<"user"> };
