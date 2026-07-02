import { describe, expect, test } from "bun:test";

import {
  clientMessageFromPageRow,
  decodeMessagePageCursor,
  encodeMessagePageCursor,
} from "@/api/handlers/chat/message-page";
import type { ChatMessageContent } from "@/api/handlers/chat/types";
import { brandPersistedChatMessageId } from "@/api/lib/safe-id-boundaries";

const MESSAGE_ID = brandPersistedChatMessageId(
  "018f4ad2-3a6d-7000-8b1d-44f76f5df001",
);

const encodeParts = (parts: unknown): string =>
  Buffer.from(JSON.stringify(parts)).toString("base64url");

describe("chat message page cursor", () => {
  test("roundtrips the message id", () => {
    expect(decodeMessagePageCursor(encodeMessagePageCursor(MESSAGE_ID))).toBe(
      MESSAGE_ID,
    );
  });

  test("rejects a cursor that is not valid base64url JSON", () => {
    expect(decodeMessagePageCursor("not-a-cursor")).toBeNull();
  });

  test("rejects a cursor whose array shape is wrong", () => {
    expect(
      decodeMessagePageCursor(encodeParts([MESSAGE_ID, MESSAGE_ID])),
    ).toBeNull();
    expect(decodeMessagePageCursor(encodeParts({ id: MESSAGE_ID }))).toBeNull();
  });

  // A tampered cursor whose id is a valid string but not a uuid must be
  // rejected here so it never reaches the DB's uuid cast (a 400, not a 500).
  test("rejects a tampered id that is not a uuid", () => {
    expect(decodeMessagePageCursor(encodeParts(["not-a-uuid"]))).toBeNull();
  });

  test("rejects a non-string id", () => {
    expect(decodeMessagePageCursor(encodeParts([42]))).toBeNull();
  });
});

describe("clientMessageFromPageRow", () => {
  test("preserves persisted message metadata", () => {
    const message = clientMessageFromPageRow(
      {
        id: MESSAGE_ID,
        role: "assistant",
        content: {
          version: 2,
          data: [{ type: "text", content: "Done" }],
          metadata: {
            anonRestorations: {
              pairs: [{ placeholder: "[PERSON_1]", original: "Ada Lovelace" }],
            },
            sourceDocuments: [
              {
                entityId: "doc_1",
                kind: "document",
                mimeType: "application/pdf",
                title: "Source memo",
                workspaceId: "workspace_1",
              },
            ],
            usage: {
              completionTokens: 3,
              promptTokens: 2,
              totalTokens: 5,
            },
          },
        } satisfies ChatMessageContent,
      },
      new Map(),
    );

    expect(message.metadata).toEqual({
      anonRestorations: {
        pairs: [{ placeholder: "[PERSON_1]", original: "Ada Lovelace" }],
      },
      sourceDocuments: [
        {
          entityId: "doc_1",
          kind: "document",
          mimeType: "application/pdf",
          title: "Source memo",
          workspaceId: "workspace_1",
        },
      ],
      usage: {
        completionTokens: 3,
        promptTokens: 2,
        totalTokens: 5,
      },
    });
  });
});
