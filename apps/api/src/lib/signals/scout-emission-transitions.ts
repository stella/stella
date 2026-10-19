import { pendingScoutEmissions } from "@/api/db/schema";
import { defineScopedTransitions } from "@/api/lib/db/transitions";

export const SCOUT_EMISSION_TRANSITIONS = defineScopedTransitions({
  table: pendingScoutEmissions,
  key: "sourceId",
  scope: ["organizationId", "sourceKind"],
  stateColumn: "status",
  edges: { pending: ["awaiting_grant"], awaiting_grant: ["pending"] },
  initial: ["pending"],
});
