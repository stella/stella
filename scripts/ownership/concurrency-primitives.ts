import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "concurrency-primitives",
  capability: "Sleeping, computing retry delays, and partitioning arrays",
  owner: ["packages/concurrency/"],
  summary:
    "`sleep` owns promise delays and cancellation rejection, `backoffDelay` " +
    "owns retry arithmetic with explicit jitter policies, and `chunk` owns " +
    "consecutive array partitions. Use their explicit package subpaths. " +
    "The `no-hand-rolled-concurrency` rule guards direct resolver timers " +
    "and named duplicate helpers. Native timers, atomic SQL retries, " +
    "overlapping windows, and token-budget slicing retain their contracts.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
