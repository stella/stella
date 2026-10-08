import type { OwnershipEntry } from "../ownership-types.ts";

const CLASSES = [
  "receipts",
  "claims",
  "grant-state",
  "scheduler",
  "notices",
  "search",
] as const;

export default {
  id: "recovery-bookkeeping",
  capability: "Persisting derived recovery bookkeeping",
  owner: CLASSES.map(
    (kind) => `apps/api/src/lib/db/recovery-bookkeeping/${kind}.ts`,
  ),
  summary:
    "Closed operations retain receipt identities, exact claim tokens, admission parking, scheduler slots, deferred notices and search projections. Callers keep their authoritative admission, tenant and resource locks; each class owns its derived writes.",
  enforcement: {
    kind: "import",
    specifiers: CLASSES.map(
      (kind) => `@/api/lib/db/recovery-bookkeeping/${kind}`,
    ),
    allowed: [
      {
        path: "apps/api/src/lib/flows/automated-run-cap.ts",
        reason:
          "Delegates derived state writes after its source authorization and ordered resource locks.",
      },
      {
        path: "apps/api/src/lib/flows/flow-run-actor.ts",
        reason:
          "Delegates derived state writes after its source authorization and ordered resource locks.",
      },
      {
        path: "apps/api/src/lib/flows/maybe-start-upload-triggered-flows.ts",
        reason:
          "Delegates derived state writes after its source authorization and ordered resource locks.",
      },
      {
        path: "apps/api/src/lib/flows/sync-flow-schedule-trigger.ts",
        reason:
          "Delegates derived state writes after its source authorization and ordered resource locks.",
      },
      {
        path: "apps/api/src/lib/scheduler/tasks/flow-run.ts",
        reason:
          "Delegates derived state writes after its source authorization and ordered resource locks.",
      },
      {
        path: "apps/api/src/lib/scheduler/tasks/scout-emission-recovery.ts",
        reason:
          "Delegates derived state writes after its source authorization and ordered resource locks.",
      },
      {
        path: "apps/api/src/lib/scheduler/tasks/upload-flow-trigger-recovery.ts",
        reason:
          "Delegates derived state writes after its source authorization and ordered resource locks.",
      },
      {
        path: "apps/api/src/lib/scheduler/upsert-job.ts",
        reason:
          "Delegates derived state writes after its source authorization and ordered resource locks.",
      },
      {
        path: "apps/api/src/lib/scouts/document-deadline-recovery.ts",
        reason:
          "Delegates derived state writes after its source authorization and ordered resource locks.",
      },
      {
        path: "apps/api/src/lib/scouts/document-deadlines.ts",
        reason:
          "Delegates derived state writes after its source authorization and ordered resource locks.",
      },
      {
        path: "apps/api/src/lib/scouts/document-review.ts",
        reason:
          "Delegates derived state writes after its source authorization and ordered resource locks.",
      },
      {
        path: "apps/api/src/lib/scouts/infosoud-hearings.ts",
        reason:
          "Delegates derived state writes after its source authorization and ordered resource locks.",
      },
      {
        path: "apps/api/src/lib/search/pg-fts-maintenance.ts",
        reason:
          "Delegates derived state writes after its source authorization and ordered resource locks.",
      },
      {
        path: "apps/api/src/lib/search/workspace-search-activity.ts",
        reason:
          "Delegates derived state writes after its source authorization and ordered resource locks.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
