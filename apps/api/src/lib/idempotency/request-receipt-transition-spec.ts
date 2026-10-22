import { requestIdempotencyReceipts } from "@/api/db/schema";
import { defineScopedTransitions } from "@/api/lib/db/transitions";

export const REQUEST_IDEMPOTENCY_RECEIPT_TRANSITIONS = defineScopedTransitions({
  table: requestIdempotencyReceipts,
  key: "id",
  scope: [],
  stateColumn: "state",
  edges: { pending: ["completed"], completed: [] },
  initial: ["pending"],
});
