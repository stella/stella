import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";

// A short finished turn whose footer holds everything a footer can: the turn's
// duration, the actions, and a source the answer consulted without linking.
export const CHAT_ANSWER_FOOTER_CASSETTE = [
  {
    createdAt: new Date("2026-10-15T16:27:07.174Z"),
    edited: false,
    id: "01a14063-8701-7101-8768-774f6e586a70",
    role: "user",
    revision: 0,
    parts: [
      { type: "text", content: "What does the notice period depend on?" },
    ],
  },
  {
    createdAt: new Date("2026-10-15T16:27:26.143Z"),
    edited: false,
    id: "01a14063-899e-72ff-9165-ae0a26f7a85b",
    metadata: {
      sourceDocuments: [
        {
          entityId: "01a14063-899e-72ff-9165-ae0a26f7a85c",
          kind: "document",
          mimeType: "application/pdf",
          title: "Sample lease agreement",
          workspaceId: "01a14063-899e-72ff-9165-ae0a26f7a85d",
        },
      ],
      turnTiming: { status: "finished", durationMs: 19_000 },
    },
    parts: [
      {
        type: "text",
        content: "The notice period depends on how long the lease has run.",
      },
    ],
    revision: 0,
    role: "assistant",
  },
] satisfies readonly PersistedChatMessage[];
