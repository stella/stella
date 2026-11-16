import { hostedUsageWebhookEvents } from "@/api/db/schema";
import { defineScopedTransitions } from "@/api/lib/db/transitions";

// A received provider event records `ok` or `ignored`. Dispatch may ignore an
// `ok` event in the same transaction, and a replay re-dispatches only an
// ignored one; nothing writes `error`, which older receipts may hold.
export const PROVIDER_WEBHOOK_RESULT_TRANSITIONS = defineScopedTransitions({
  table: hostedUsageWebhookEvents,
  key: "eventId",
  scope: [],
  stateColumn: "result",
  edges: { ok: ["ignored"], ignored: ["ok", "ignored"], error: [] },
  initial: ["ok", "ignored"],
});
