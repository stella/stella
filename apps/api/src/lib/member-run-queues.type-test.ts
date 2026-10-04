import type {
  QueueAuthorityEntry,
  QueueAuthorityRegistry,
} from "@/api/lib/member-run-queues";

const automation = {
  authority: "org-automation",
  worker: "apps/api/src/lib/example-queue.ts",
  reason: "Example.",
} as const satisfies QueueAuthorityEntry;

// A registry that leaves a queue unclassified does not compile.
// @ts-expect-error Every BullMQ queue needs an authority row.
export const unclassified: QueueAuthorityRegistry = { workflow: automation };

// Nor does one that classifies a queue the host table does not define.
export const unknownQueue = {
  // @ts-expect-error Only registered BullMQ queues can be classified.
  "unregistered-queue": automation,
} satisfies Partial<QueueAuthorityRegistry>;

// An authority outside the two kinds does not compile.
export const unknownAuthority: QueueAuthorityEntry = {
  // @ts-expect-error The authority is member-run or org-automation.
  authority: "system",
  worker: "apps/api/src/lib/example-queue.ts",
  reason: "Example.",
};
