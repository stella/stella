import { flowUploadTriggerIntents } from "@/api/db/schema";
import { defineScopedTransitions } from "@/api/lib/db/transitions";

export const UPLOAD_TRIGGER_TRANSITIONS = defineScopedTransitions({
  table: flowUploadTriggerIntents,
  key: "entityId",
  scope: ["definitionId"],
  stateColumn: "status",
  edges: {
    pending: ["awaiting_grant", "skipped"],
    awaiting_grant: ["pending"],
    skipped: [],
  },
  initial: [],
});
