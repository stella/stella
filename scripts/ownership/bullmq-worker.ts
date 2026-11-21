import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "bullmq-worker",
  capability: "Constructing BullMQ workers with a shared failure record policy",
  owner: ["apps/api/src/lib/bullmq-queue.ts"],
  summary:
    "BullMqWorker owns persisted job failure records while retaining original errors in worker events. All queue workers use this constructor.",
  enforcement: {
    kind: "import",
    specifiers: ["bullmq"],
    names: ["Worker"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
