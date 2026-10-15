import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "failure-observation",
  capability: "Reading, grading and emitting an API failure",
  owner: [
    "packages/errors/src/failure.ts",
    "apps/api/src/lib/observability/failure-evidence.ts",
    "apps/api/src/lib/observability/failure.ts",
    "apps/api/src/lib/observability/observe-failure.ts",
    "apps/api/src/lib/observability/failure-shadow.ts",
  ],
  summary:
    "One bounded, read-once evidence snapshot per error feeds every failure " +
    "sink, so no sink can drop the cause, the SQLSTATE or the provider " +
    "status another one keeps. A finite reason decides the grade through one " +
    "policy map; boundaries classify what they know through an owned brand " +
    "rather than a property a foreign error could carry. observeFailure " +
    "composes the record, owned fields last, and owns severity, capture and " +
    "the transient metric. The direct-failure-sinks ratchet counts the " +
    "emissions still outside it, per file.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
