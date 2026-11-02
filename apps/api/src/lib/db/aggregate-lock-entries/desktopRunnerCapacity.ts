import type { SafeId } from "@/api/lib/branded-types";

import type { AggregateLockDefinition } from "../aggregate-lock-definition";

/** Admission of an account's desktop runners in one organization, against its cap. */
export default {
  rank: 700,
  kind: "advisory",
} as const satisfies AggregateLockDefinition;

export type Identity = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};
