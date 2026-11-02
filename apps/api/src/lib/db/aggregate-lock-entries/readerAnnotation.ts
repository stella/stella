import type { SafeId } from "@/api/lib/branded-types";

import type { AggregateLockDefinition } from "../aggregate-lock-definition";

export default {
  rank: 120,
  kind: "advisory",
} as const satisfies AggregateLockDefinition;

export type Identity = {
  id: SafeId<"legalReaderAnnotation">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};
