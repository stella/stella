import { describe, expect, test } from "bun:test";

import {
  UNSCANNED_CONTENT_WARNING,
  type UnscannedContentReason,
  unscannedContentReasons,
} from "@stll/api-contract/file-scan-warnings";

import {
  createChatAttachmentPart,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import {
  clientMessageFromPageRow,
  decodeMessagePageCursor,
  encodeMessagePageCursor,
  type ServedFileDetails,
} from "@/api/handlers/chat/message-page";
import type { ChatPart } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import { brandPersistedChatMessageId } from "@/api/lib/safe-id-boundaries";
import { toUserFileUrl } from "@/api/lib/user-files/types";

const MESSAGE_ID = brandPersistedChatMessageId(
  "018f4ad2-3a6d-7000-8b1d-44f76f5df001",
);
const CREATED_AT = new Date("2026-09-02T15:06:00.000Z");

const encodeParts = (parts: unknown): string =>
  Buffer.from(JSON.stringify(parts)).toBase64({
    alphabet: "base64url",
    omitPadding: true,
  });

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
        createdAt: CREATED_AT,
        id: MESSAGE_ID,
        role: "assistant",
        revision: 0,
        content: toPersistedChatMessageContentV3({
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
        }),
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
    expect(message.createdAt).toBe(CREATED_AT.toISOString());
    expect(message.revision).toBe(0);
    expect(message.edited).toBe(false);
  });

  test.each([0, 1, 4])(
    "exposes revision %i and its edited state",
    (revision) => {
      const message = clientMessageFromPageRow(
        {
          createdAt: CREATED_AT,
          id: MESSAGE_ID,
          role: "assistant",
          revision,
          content: toPersistedChatMessageContentV3({
            data: [{ type: "text", content: "Current answer" }],
          }),
        },
        new Map(),
      );

      expect(message.revision).toBe(revision);
      expect(message.edited).toBe(revision !== 0);
      expect(message.parts).toEqual([
        { type: "text", content: "Current answer" },
      ]);
    },
  );
});

describe("a sent file's unscanned content", () => {
  const FILE_ID = toSafeId<"userFile">("018f4ad2-3a6d-7000-8b1d-44f76f5df0f1");
  const ARCHIVE_MIME_TYPE = "application/vnd.etsi.asic-e+zip";
  const userRow = (parts: ChatPart[]) => ({
    createdAt: CREATED_AT,
    id: MESSAGE_ID,
    role: "user" as const,
    revision: 0,
    content: toPersistedChatMessageContentV3({ data: parts }),
  });
  const archive = (unscannedContent: UnscannedContentReason[] = []) =>
    createChatAttachmentPart({
      filename: "bundle.asice",
      mimeType: ARCHIVE_MIME_TYPE,
      unscannedContent,
      url: toUserFileUrl(FILE_ID),
    });
  const details = (
    unscannedContent: UnscannedContentReason[],
  ): Map<string, ServedFileDetails> =>
    new Map([[FILE_ID, { placeholder: null, unscannedContent }]]);

  test("is served from the file's stored scan warnings", () => {
    const message = clientMessageFromPageRow(
      userRow([archive()]),
      details(
        unscannedContentReasons([
          UNSCANNED_CONTENT_WARNING.unsupportedCompression,
          UNSCANNED_CONTENT_WARNING.encrypted,
        ]),
      ),
    );

    expect(message.parts).toEqual([
      {
        type: "document",
        source: {
          type: "url",
          value: toUserFileUrl(FILE_ID),
          mimeType: ARCHIVE_MIME_TYPE,
        },
        metadata: {
          filename: "bundle.asice",
          unscannedContent: ["encrypted", "unsupportedCompression"],
        },
      },
    ]);
  });

  // The part the upload writes, which a live snapshot carries, is the part a
  // reload serves: both read the reasons from the same scan.
  test("reads the same as the part the upload wrote", () => {
    const uploaded = archive(["encrypted"]);

    expect(
      clientMessageFromPageRow(userRow([uploaded]), details(["encrypted"]))
        .parts,
    ).toEqual([uploaded]);
  });

  test("is never what a stored part claims when the file says otherwise", () => {
    const claimed = userRow([archive(["encrypted"])]);

    expect(clientMessageFromPageRow(claimed, details([])).parts).toEqual([
      archive(),
    ]);
    // A file that is not this member's says nothing either.
    expect(clientMessageFromPageRow(claimed, new Map()).parts).toEqual([
      archive(),
    ]);
  });

  test("keeps an image's placeholder beside it", () => {
    const image = createChatAttachmentPart({
      filename: "scan.png",
      mimeType: "image/png",
      url: toUserFileUrl(FILE_ID),
    });
    const message = clientMessageFromPageRow(
      userRow([image]),
      new Map([
        [
          FILE_ID,
          { placeholder: "data:image/png;base64,AAAA", unscannedContent: [] },
        ],
      ]),
    );

    expect(message.parts).toEqual([
      {
        ...image,
        metadata: {
          filename: "scan.png",
          placeholder: "data:image/png;base64,AAAA",
        },
      },
    ]);
  });
});
