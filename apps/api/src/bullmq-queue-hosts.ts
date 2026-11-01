// Side-effect-free leaf: the release gate imports this without the queue runtime.

/**
 * Every BullMQ queue and the process that hosts its worker. The union this
 * table defines is what `createLazyBullMqQueue` accepts and what each host's
 * worker set must cover exactly (see `createBullMqWorkerHost`), so a queue
 * cannot be added without deciding where its worker runs, and a host cannot
 * start without it.
 */
export const BULLMQ_QUEUE_HOSTS = {
  "account-deletion-cleanup": "api",
  "account-exports": "api",
  "bilingual-translation-runs": "api",
  "document-deadline-scouts": "api",
  "document-processing": "document-processing-worker",
  "document-review-runs-v2": "api",
  "document-translation-runs": "api",
  "entity-deletion-cleanup": "api",
  "file-derivatives": "file-derivative-worker",
  "flow-run": "api",
  "legal-list-verification-runs": "api",
  "push-notifications": "api",
  "report-exports": "api",
  "style-set-package-cleanup": "api",
  "uploaded-mail-correspondence": "api",
  workflow: "api",
  "workflow-flex": "api",
} as const satisfies Record<string, BullMqWorkerHost>;

export type BullMqWorkerHost =
  "api" | "document-processing-worker" | "file-derivative-worker";

export type BullMqQueueName = keyof typeof BULLMQ_QUEUE_HOSTS;
