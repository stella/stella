import { describe, expect, test } from "bun:test";

import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import {
  findCreateDocumentArtifactForMessage,
  hasMessageExportCitations,
} from "@/components/chat/message-export-menu.logic";

describe("message export menu", () => {
  test("only offers citation styles when the message has citations", () => {
    const plain = {
      id: "plain",
      role: "assistant",
      parts: [{ type: "text", content: "A plain answer." }],
    } satisfies PersistedChatMessage;
    const cited = {
      id: "cited",
      role: "assistant",
      parts: [
        {
          type: "text",
          content: "A supported [claim](https://example.com/source).",
        },
      ],
    } satisfies PersistedChatMessage;
    const officeCited = {
      id: "office-cited",
      role: "assistant",
      parts: [
        {
          type: "text",
          content:
            "A supported [cell](#office:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:xlsx-0123456789abcdef).",
        },
      ],
    } satisfies PersistedChatMessage;

    expect(hasMessageExportCitations(plain)).toBe(false);
    expect(hasMessageExportCitations(cited)).toBe(true);
    expect(hasMessageExportCitations(officeCited)).toBe(true);
  });

  test("associates a created draft with the final answer in the same turn", () => {
    const input = {
      name: "Power of attorney",
      source: "@doc kind=other locale=en page=A4\n@title Power of attorney",
    };
    const messages = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", content: "Create a power of attorney" }],
      },
      {
        id: "assistant-tool",
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "tool-draft",
            name: "create-document",
            arguments: JSON.stringify(input),
            state: "complete",
            input,
            output: {
              success: true,
              destination: "draft",
              fileName: "Power of attorney.docx",
            },
          },
        ],
      },
      {
        id: "assistant-final",
        role: "assistant",
        parts: [{ type: "text", content: "The draft is ready." }],
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", content: "Thanks" }],
      },
    ] satisfies PersistedChatMessage[];

    expect(findCreateDocumentArtifactForMessage(messages, 2)).toMatchObject({
      name: "Power of attorney",
      toolCallId: "tool-draft",
    });
    expect(findCreateDocumentArtifactForMessage(messages, 3)).toBeNull();
  });
});
