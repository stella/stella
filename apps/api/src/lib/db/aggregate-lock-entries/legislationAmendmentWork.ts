import type { SafeId } from "@/api/lib/branded-types";

import type { AggregateLockDefinition } from "../aggregate-lock-definition";

// Public-corpus work fence precedes legacy projection/expression locks.
export default {
  rank: 50,
  kind: "advisory",
} as const satisfies AggregateLockDefinition;

export type Identity = {
  sourceId: SafeId<"legislationSource">;
  eli: string;
  language: string;
};
