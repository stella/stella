import type { BullMqQueueName } from "@/api/lib/bullmq-queue";
import type { RegisteredSchedulerTaskName } from "@/api/lib/scheduler/registry";

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
  {
    queue: "workflow",
    module: "apps/api/src/lib/workflow-queue.ts",
  },
  {
    queue: "workflow-flex",
    module: "apps/api/src/lib/workflow-queue.ts",
  },
] as const satisfies readonly { queue: BullMqQueueName; module: string }[];

/**
 * Scheduler tasks that act for one member per item they process, through a
 * `createRootRunActor` built for that member each time. `scripts/ownership.ts`
 * allows `createRootRunActor` in these modules too.
 */
export const MEMBER_RUN_SCHEDULER_TASKS = [
  {
    task: "memory.extractor",
    module: "apps/api/src/lib/scheduler/tasks/memory-extractor.ts",
  },
] as const satisfies readonly {
  task: RegisteredSchedulerTaskName;
  module: string;
}[];

/**
 * Whose authority a queued job runs under.
 *
 * - `member-run`: the job acts for one member (who queued it, or who owns
 *   the definition it runs), so it reads only what that member can read when
 *   it executes. It belongs in `MEMBER_RUN_QUEUES`.
 * - `org-automation`: the job acts for no member; it does the organization's
 *   or the platform's own work and returns nothing to a member that the
 *   member could not already read.
 */
export type QueueAuthority = "member-run" | "org-automation";

export type QueueAuthorityEntry = {
  authority: QueueAuthority;
  /** The module that constructs this queue's BullMQ `Worker`. */
  worker: string;
  /** Modules the worker hands the job to that open its database handles. */
  executors?: readonly string[];
  /** Member runs: the integration test that removes the requester's access
   *  after the run was queued and expects the run to read nothing. */
  revocationTest?: string;
  /** Why the job runs under this authority. */
  reason: string;
};

/** Every queue, classified. A queue added to the BullMQ host table without a
 *  row here does not compile; `scripts/queue-authority.ts` checks the rest. */
export type QueueAuthorityRegistry = Record<
  BullMqQueueName,
  QueueAuthorityEntry
>;

/** The test titles a member run's `revocationTest` must contain. */
export const MEMBER_RUN_REVOCATION_CASES = [
  "a run stops when its requester no longer has access to the matter",
  "a run stops when its requester has left the organization",
] as const;

const WORKFLOW_RUN = {
  authority: "member-run",
  worker: "apps/api/src/lib/workflow-queue.ts",
  revocationTest: "apps/api/src/lib/workflow-queue.integration.test.ts",
  reason:
    "Started by a member (workflow start, cell retry, playbook run, MCP); follow-up runs reuse that member.",
} as const satisfies QueueAuthorityEntry;

export const QUEUE_AUTHORITY = {
  "account-deletion-cleanup": {
    authority: "org-automation",
    worker: "apps/api/src/lib/account-deletion-cleanup-queue.ts",
    reason: "Platform cleanup after an account deletion request.",
  },
  "bilingual-translation-runs": {
    authority: "member-run",
    worker: "apps/api/src/lib/bilingual/run-queue.ts",
    revocationTest:
      "apps/api/src/lib/bilingual/run-worker-inputs.integration.test.ts",
    reason: "A translation the requesting member started.",
  },
  "document-deadline-scouts": {
    authority: "org-automation",
    worker: "apps/api/src/lib/document-deadline-scout-worker.ts",
    reason: "Scheduled scan the organization runs over its own documents.",
  },
  "document-processing": {
    authority: "org-automation",
    worker: "apps/api/src/lib/document-processing-queue.ts",
    reason:
      "Processes an uploaded document for its workspace; the job carries no member.",
  },
  "document-review-runs-v2": {
    authority: "member-run",
    worker: "apps/api/src/lib/document-review/run-queue.ts",
    revocationTest:
      "apps/api/src/lib/document-review/run-worker-inputs.integration.test.ts",
    reason: "A review the requesting member started.",
  },
  "document-translation-runs": {
    authority: "member-run",
    worker: "apps/api/src/lib/document-translation/run-queue.ts",
    revocationTest:
      "apps/api/src/lib/document-translation/run-worker-inputs.integration.test.ts",
    reason: "A translation the requesting member started.",
  },
  "entity-deletion-cleanup": {
    authority: "org-automation",
    worker: "apps/api/src/lib/entity-deletion-cleanup-queue.ts",
    reason: "Platform cleanup after an entity deletion.",
  },
  "file-derivatives": {
    authority: "org-automation",
    worker: "apps/api/src/lib/file-derivative-queue.ts",
    reason: "Derived renditions stored back on the workspace's own file.",
  },
  "flow-run": {
    authority: "member-run",
    worker: "apps/api/src/lib/flows/flow-run-worker.ts",
    executors: ["apps/api/src/lib/flows/flow-executor.ts"],
    reason:
      "Acts as the member who launched the run, or for an automated run the definition's author.",
  },
  "legal-list-verification-runs": {
    authority: "member-run",
    worker: "apps/api/src/lib/lists/verification/run-queue.ts",
    revocationTest:
      "apps/api/src/lib/lists/verification/run-worker-inputs.integration.test.ts",
    reason: "A verification the requesting member started.",
  },
  "report-exports": {
    authority: "member-run",
    worker: "apps/api/src/handlers/reports/report-export-queue.ts",
    revocationTest:
      "apps/api/src/handlers/reports/report-export-queue.integration.test.ts",
    reason: "An export the requesting member started.",
  },
  "style-set-package-cleanup": {
    authority: "org-automation",
    worker: "apps/api/src/lib/style-set-package-cleanup-queue.ts",
    reason: "Platform cleanup of stored style-set packages.",
  },
  "uploaded-mail-correspondence": {
    authority: "org-automation",
    worker: "apps/api/src/lib/email/inbound/upload-queue.ts",
    reason:
      "Retries filing a stored email file as correspondence; the filing transaction rechecks the uploader's current matter access.",
  },
  workflow: WORKFLOW_RUN,
  "workflow-flex": WORKFLOW_RUN,
} as const satisfies QueueAuthorityRegistry;
