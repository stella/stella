import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "member-run-actor",
  capability: "Acting for the member who queued a run",
  owner: ["apps/api/src/lib/root-scoped-db.ts"],
  summary:
    "`createRootRunActor` splits a queued run's authority: `writeDb` keeps the " +
    "workspace pinned for the run's own rows and its output, and `inputDb` " +
    "reads under the requester's membership as it stands when the run " +
    "executes. Member-run queues and scheduler tasks are listed in " +
    "`apps/api/src/lib/member-run-queues.ts`.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/root-scoped-db"],
    names: ["createRootRunActor"],
    allowed: [
      // Kept equal to MEMBER_RUN_QUEUES by scripts/ownership.test.ts.
      ...[
        "apps/api/src/lib/document-review/run-queue.ts",
        "apps/api/src/lib/document-translation/run-queue.ts",
        "apps/api/src/lib/bilingual/run-queue.ts",
        "apps/api/src/handlers/reports/report-export-queue.ts",
        "apps/api/src/lib/lists/verification/run-queue.ts",
        "apps/api/src/lib/workflow-queue.ts",
      ].map((modulePath) => ({
        path: modulePath,
        reason: "Member run; reads its inputs through inputDb.",
      })),
      // Kept equal to MEMBER_RUN_SCHEDULER_TASKS by scripts/ownership.test.ts.
      {
        path: "apps/api/src/lib/scheduler/tasks/memory-extractor.ts",
        reason:
          "Member-run scheduler task; reads each compaction through its owner's inputDb.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
