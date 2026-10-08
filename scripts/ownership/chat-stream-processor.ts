import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "chat-stream-processor",
  capability: "Accumulating a TanStack stream into the message it produced",
  owner: ["apps/api/src/lib/chat/stream-message-capture.ts"],
  summary:
    "A chat turn's persisted message is folded from its stream by a " +
    "`StreamProcessor` inside `processTurnForPersistence`. A second " +
    "construction with its own event wiring could accumulate something other " +
    "than what production stores, so `createStreamMessageCapture` is the one " +
    "constructor and callers only choose what to keep from the finished message.",
  enforcement: {
    kind: "import",
    specifiers: ["@tanstack/ai"],
    names: ["StreamProcessor"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
