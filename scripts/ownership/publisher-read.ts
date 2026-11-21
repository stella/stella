import type { OwnershipEntry } from "../ownership-types.ts";
// Case-law modules that still call the raw publisher fetch. Each migrates to
// `readPublisher` and leaves this list; nothing is added to it.
const UNMIGRATED_PUBLISHER_READERS = [
  "handlers/case-law/ingestion/adapters/at-findok-throttle.ts",
  "handlers/case-law/ingestion/adapters/at-ris-throttle.ts",
  "handlers/case-law/ingestion/adapters/eu-ecj.ts",
  "handlers/case-law/ingestion/adapters/hu-bhgy.ts",
  "handlers/case-law/ingestion/adapters/pagination.ts",
  "handlers/case-law/ingestion/adapters/pl-courts.ts",
  "handlers/case-law/ingestion/adapters/pl-kio.ts",
  "handlers/case-law/ingestion/adapters/pl-kis.ts",
  "handlers/case-law/ingestion/adapters/pl-ncourt.ts",
  "handlers/case-law/ingestion/adapters/pl-nsa-dataset.ts",
  "handlers/case-law/ingestion/adapters/pl-sn.ts",
  "handlers/case-law/ingestion/adapters/pl-tk.ts",
  "handlers/case-law/ingestion/adapters/pl-uodo.ts",
  "handlers/case-law/ingestion/adapters/pl-uokik.ts",
  "handlers/case-law/ingestion/adapters/sk-collections.ts",
] as const;

export default {
  id: "publisher-read",
  capability: "Reading a case-law publisher response",
  owner: [
    "apps/api/src/lib/errors/read-outcome.ts",
    "apps/api/src/handlers/case-law/ingestion/adapters/publisher-read.ts",
    "apps/api/src/handlers/case-law/ingestion/adapters/retry.ts",
  ],
  summary:
    "readPublisher sends the gated publisher request and returns a ReadOutcome: " +
    "the response, an absence only the publisher stated (404 or 410), or a " +
    "failure to read, so no helper can return a failed read as an empty " +
    "result. Raw fetchPublisher and fetchWithRetry callers are the adapters " +
    "not yet migrated; the list only shrinks. The read-fault guard drives " +
    "every enrolled adapter's reads with failures.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/handlers/case-law/ingestion/adapters/retry"],
    names: ["fetchPublisher", "fetchWithRetry"],
    allowed: [
      ...UNMIGRATED_PUBLISHER_READERS.map((file) => ({
        path: `apps/api/src/${file}`,
        reason: "Reads its publisher raw; pending migration to readPublisher.",
      })),
      {
        path: "apps/api/src/handlers/case-law/ingestion/adapters/at-courts.ts",
        reason:
          "Types the injected publisher fetch of its RIS walk; sends no request itself.",
      },
      {
        path: "apps/api/src/handlers/case-law/ingestion/adapters/at-findok.ts",
        reason:
          "Types the injected publisher fetch of its document reads; sends no request itself.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
