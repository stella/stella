import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "agent-harness-adapters",
  capability:
    "Running a coding-agent harness on the user's computer and turning its events into stream chunks",
  owner: ["packages/agent-engine/src/harness/"],
  summary:
    "A local agent turn runs the harness's own CLI behind one adapter " +
    "contract (`HarnessAdapter`). Adapters translate native events into " +
    "`HarnessEvent`s, and `harnessEventsToChunks` is the one mapping to " +
    "TanStack chunks, so local and cloud turns persist the same message. " +
    "The same directory owns the harness compatibility policy and the " +
    "transcript handoff that lets a conversation change harness between turns.",
  enforcement: {
    kind: "literal-pattern",
    pattern: "^app-server$",
    allowed: [],
  },
} as const satisfies OwnershipEntry;
