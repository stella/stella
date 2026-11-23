import type { SafeId } from "@/api/lib/branded-types";

import type { AggregateLockDefinition } from "../aggregate-lock-definition";

/** The writers of one organization's dictation words, so its cap holds. */
export default {
  rank: 700,
  kind: "advisory",
} as const satisfies AggregateLockDefinition;

export type Identity = { organizationId: SafeId<"organization"> };
