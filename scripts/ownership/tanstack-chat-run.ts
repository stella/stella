import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "tanstack-chat-run",
  capability: "Starting a TanStack `chat()` run and reading its chunks",
  owner: ["apps/api/src/lib/chat/tanstack-chat-runtime.ts"],
  summary:
    "`chat()` emits AG-UI spec-shaped chunks: the engine keeps only the spec " +
    "keys of each event type and moves the rest into `metadata.tanstack`. " +
    "Two defects came from reading a moved key at the top level, so the owner " +
    "returns `PublicStreamChunk` — the same union without those keys — and " +
    "holds the readers that look in both places. A caller that reaches for " +
    "`chat()` itself gets the raw union back and the compile error with it.",
  enforcement: {
    kind: "import",
    specifiers: ["@tanstack/ai"],
    names: ["chat"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
