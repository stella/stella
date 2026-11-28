import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "publisher-read",
  capability: "Reading a case-law publisher response",
  owner: [
    "packages/case-law-ingestion-core/src/read-outcome.ts",
    "packages/case-law-adapters/src/publisher-read.ts",
    "packages/case-law-adapters/src/retry.ts",
  ],
  summary:
    "readPublisher sends the gated publisher request and returns a ReadOutcome: " +
    "the response, an absence only the publisher stated (404 or 410), or a " +
    "failure to read, so no helper can return a failed read as an empty " +
    "result. All case-law adapters now read through readPublisher. The " +
    "read-fault guard drives every enrolled adapter's reads with failures.",
  enforcement: {
    kind: "import",
    specifiers: ["@stll/case-law-adapters/retry"],
    names: ["fetchPublisher", "fetchWithRetry"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
