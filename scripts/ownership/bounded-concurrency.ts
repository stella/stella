import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "bounded-concurrency",
  capability:
    "Running an async operation over a list with a bounded number in flight",
  owner: ["packages/concurrency/"],
  summary:
    "A windowed `Promise.all` over slices is the shape everyone reaches for " +
    "and it is not a concurrency bound: the window refills only once its " +
    "slowest member settles, so effective concurrency decays to each slice's " +
    "tail and drops to zero for whatever the caller does between slices. " +
    "`mapWithConcurrency` returns every result and keeps the pool full " +
    "throughout. `streamWithConcurrency` yields each result in input order " +
    "as it is ready, and its `lookAhead` decides whether the pool refills " +
    "on completion or on consumption: at the default of zero a settled " +
    "result holds its slot, so the pool slides and residency stays at " +
    "`limit`; a caller that wants work to continue through a slow item and " +
    "through its own per-result work has to ask for look-ahead and pay for " +
    "up to `limit + lookAhead` resident results. The stream observes each " +
    "settlement at the pool, so a rejection behind a slower item cannot " +
    "surface as an unhandled rejection, and nothing it started outlives " +
    "its consumer: closing the stream starts nothing more and waits for " +
    "what is already running.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
