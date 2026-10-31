import type { SafeId } from "@/api/lib/branded-types";

import type { AggregateLockDefinition } from "../aggregate-lock-definition";

export default {
  rank: 50,
  kind: "row",
} as const satisfies AggregateLockDefinition;

export type Identity = {
  definitionId: SafeId<"flowDefinition">;
  entityId: SafeId<"entity">;
  organizationId: SafeId<"organization">;
};
