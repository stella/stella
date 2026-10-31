import type { SafeId } from "@/api/lib/branded-types";

import type { AggregateLockDefinition } from "../aggregate-lock-definition";

export default {
  rank: 40,
  kind: "row",
} as const satisfies AggregateLockDefinition;

export type Identity = {
  id: SafeId<"flowDefinition">;
  organizationId: SafeId<"organization">;
};
