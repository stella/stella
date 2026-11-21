import { sessionSignIns } from "@/api/db/schema";
import { defineScopedTransitions } from "@/api/lib/db/transitions";

// A sign-in starts not needing review. The new-device email moves it to
// pending once; the account holder confirms it and may undo that. Signing
// the device out deletes the session and, with it, this row.
export const SESSION_SIGN_IN_REVIEW_TRANSITIONS = defineScopedTransitions({
  table: sessionSignIns,
  key: "sessionId",
  scope: [],
  stateColumn: "review",
  edges: {
    not_required: ["pending"],
    pending: ["confirmed"],
    confirmed: ["pending"],
  },
  initial: ["not_required"],
});
