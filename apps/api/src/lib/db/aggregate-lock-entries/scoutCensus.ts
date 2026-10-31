import type { pendingScoutEmissions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

import type { AggregateLockDefinition } from "../aggregate-lock-definition";

export default {
  rank: 60,
  kind: "row",
} as const satisfies AggregateLockDefinition;

export type Identity =
  | {
      type: "run";
      id: SafeId<"scoutRun">;
      organizationId: SafeId<"organization">;
    }
  | (Pick<
      typeof pendingScoutEmissions.$inferSelect,
      "organizationId" | "sourceKind" | "sourceId"
    > & {
      type: "receipt";
    });
