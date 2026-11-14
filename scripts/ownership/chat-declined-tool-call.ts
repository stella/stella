import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "chat-declined-tool-call",
  capability: "Deciding whether the user declined a chat tool call",
  owner: ["packages/api-contract/src/chat.ts"],
  summary:
    "A declined call is stored in one shape, the one the chat engine writes on a denial: an `error` call whose output is the engine's denial, keeping `approval.approved: false`, and a `denied` tool result. The API's own writer (`declineToolCall`) stores the same shape. Settlement, revisions, request validation, the stream's snapshots, the post-deploy smoke and the web cards read the decision through `isDeclinedChatToolCall`, never through a tool-call state, so a call declined before that shape existed reads the same.",
  enforcement: {
    // Ownership marker: the denial text is declared once, so a second writer
    // of a denial imports it rather than spelling its own.
    kind: "literal-pattern",
    pattern: "^User declined tool execution$",
    allowed: [],
  },
} as const satisfies OwnershipEntry;
