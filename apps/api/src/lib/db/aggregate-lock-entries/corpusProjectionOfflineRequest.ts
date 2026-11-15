import type { AggregateLockDefinition } from "../aggregate-lock-definition";

// One offline projection request, held by each of its start transactions from
// reading what earlier ones started until it commits its own starts.
export default {
  rank: 47,
  kind: "advisory",
} as const satisfies AggregateLockDefinition;

/** The request's identity (`append_request_id`). */
export type Identity = string;
