import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "chat-turn-handover-system",
  capability: "Finding handed-over chat turns across organizations",
  owner: ["apps/api/src/db/root.ts"],
  summary:
    "The chat turn adopter reads which handed-over turns another task may still take, and whose they are, through the owner connection, before that member is proved again; ids and owners only, and callers receive answers, never a database handle. The adoption itself runs on the member's own connection under the thread lock.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/root"],
    names: ["sweepHandedOverChatTurns"],
    allowed: [
      {
        path: "apps/api/src/handlers/chat/turns/adopt.ts",
        reason:
          "Adopts a handed-over turn as the member whose turn it is, on that member's own connection once proved.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
