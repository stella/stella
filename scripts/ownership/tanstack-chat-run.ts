import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "tanstack-chat-run",
  capability: "Starting a TanStack `chat()` run and reading its chunks",
  owner: ["apps/api/src/lib/chat/tanstack-chat-runtime.ts"],
  summary:
    "`chat()` emits AG-UI spec-shaped chunks: the engine keeps only the spec " +
    "keys of each event type and moves the rest into `metadata.tanstack`. " +
    "The owner returns `PublicStreamChunk`, the same union without those " +
    "top-level keys, and provides readers for both spec keys and " +
    "`metadata.tanstack`. Callers start runs and read chunks through this " +
    "owner to use that contract.",
  enforcement: {
    kind: "import",
    specifiers: ["@tanstack/ai"],
    names: ["chat"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
