/**
 * Queues whose runs act for the member who requested them.
 *
 * Each builds its actor with `createRootRunActor` and reads what it works on
 * through the actor's `inputDb`, under the requester's membership at the time
 * the run executes. `scripts/ownership.ts` allows `createRootRunActor` in
 * exactly these modules.
 */
export const MEMBER_RUN_QUEUES = [
  {
    queue: "document-review-runs-v2",
    module: "apps/api/src/lib/document-review/run-queue.ts",
  },
  {
    queue: "document-translation-runs",
    module: "apps/api/src/lib/document-translation/run-queue.ts",
  },
  {
    queue: "bilingual-translation-runs",
    module: "apps/api/src/lib/bilingual/run-queue.ts",
  },
  {
    queue: "report-exports",
    module: "apps/api/src/handlers/reports/report-export-queue.ts",
  },
  {
    queue: "legal-list-verification-runs",
    module: "apps/api/src/lib/lists/verification/run-queue.ts",
  },
] as const;

export type MemberRunQueue = (typeof MEMBER_RUN_QUEUES)[number]["queue"];
