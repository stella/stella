import type { SafeId } from "@/api/lib/branded-types";

import type { AggregateLockDefinition } from "../aggregate-lock-definition";

/**
 * An account's desktop runners in one organization: runner claims against the
 * account's runner cap, and commands against each run's command cap.
 */
export default {
  rank: 700,
  kind: "advisory",
} as const satisfies AggregateLockDefinition;

export type Identity = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};
