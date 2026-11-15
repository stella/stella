import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "chat-queue-system",
  capability: "Finding due chat queues across organizations",
  owner: ["apps/api/src/db/root.ts"],
  summary:
    "The chat queue's sender reads which threads have a queued message due and who queued it through the owner connection, before that member is proved again, and holds a queue whose member can no longer be proved; ids and owners only, never a message's content, and callers receive answers, never a database handle.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/root"],
    names: [
      "readDueChatQueueHead",
      "sweepThreadsWithDueChatQueue",
      "holdChatQueueOfUnavailableMember",
    ],
    allowed: [
      {
        path: "apps/api/src/handlers/chat/queue/chat-queue-drain.ts",
        reason:
          "Sends a thread's next queued message as the member who queued it, on that member's own connection once proved.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
