import type { SafeId } from "@/api/lib/branded-types";

import type { AggregateLockDefinition } from "../aggregate-lock-definition";

export default {
  rank: 90,
  kind: "row",
  holder: "application",
} as const satisfies AggregateLockDefinition;

export type Identity = SafeId<"organization">;
