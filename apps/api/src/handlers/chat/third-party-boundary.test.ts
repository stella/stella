import type { ToolSet } from "ai";
import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { TEXT_PLAIN_MIME_TYPE } from "@/api/handlers/chat/attachment-validation";
import type { ChatMessage } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import { toDataUrl } from "@/api/lib/data-url";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const anonymizeTextFieldsMock = mock(
  async ({ fields }: { fields: string[] }) => ({
    entityCount: fields.length,
    fields: fields.map((field) =>
      field
        .replaceAll("Jan Novák", "[PERSON_1]")
        .replaceAll("Secret", "[CUSTOM_1]"),
    ),
  }),
);

const {
  createChatThirdPartyBoundary,
  prepareMessagesForThirdParty,
  prepareTextForThirdParty,
  prepareToolsForThirdParty,
} = await import("@/api/handlers/chat/third-party-boundary");

const createBoundary = () => {
  const { scopedDb } = createScopedDbMock({});

  return createChatThirdPartyBoundary({
    anonymized: true,
    anonymizeFields: anonymizeTextFieldsMock,
    organizationId: toSafeId<"organization">(
      "11111111-1111-4111-8111-111111111111",
    ),
    scopedDb,
  });
};

describe("chat third-party anonymization boundary", () => {
  beforeEach(() => {
    anonymizeTextFieldsMock.mockClear();
  });

  test("anonymizes system text and message text before provider use", async () => {
    const boundary = createBoundary();
    const system = await prepareTextForThirdParty({
      boundary,
      text: "System context mentions Jan Novák and Secret.",
    });

    expect(Result.isOk(system)).toBe(true);
    if (Result.isError(system)) {
      throw system.error;
    }

    expect(system.value).toBe(
      "System context mentions [PERSON_1] and [CUSTOM_1].",
    );

    const messages: ChatMessage[] = [
      {
        id: "msg_1",
        role: "user",
        parts: [
          {
            type: "text",
            text: "Does Jan Novák appear in Secret contract?",
          },
        ],
      },
    ];

    const prepared = await prepareMessagesForThirdParty({
      boundary,
      messages,
    });

    expect(Result.isOk(prepared)).toBe(true);
    if (Result.isError(prepared)) {
      throw prepared.error;
    }

    expect(prepared.value?.at(0)?.parts.at(0)).toEqual({
      type: "text",
      text: "Does [PERSON_1] appear in [CUSTOM_1] contract?",
    });
  });

  test("refuses attachments that cannot be safely anonymized as text", async () => {
    const boundary = createBoundary();
    const messages: ChatMessage[] = [
      {
        id: "msg_1",
        role: "user",
        parts: [
          {
            type: "file",
            filename: "Jan Novák draft.docx",
            mediaType: DOCX_MIME_TYPE,
            url: toDataUrl(new Uint8Array([1, 2, 3]), DOCX_MIME_TYPE),
          },
        ],
      },
    ];

    const prepared = await prepareMessagesForThirdParty({
      boundary,
      messages,
    });

    expect(Result.isError(prepared)).toBe(true);
    if (Result.isOk(prepared)) {
      throw new Error("Expected attachment refusal");
    }

    expect(prepared.error.status).toBe(422);
    expect(anonymizeTextFieldsMock).not.toHaveBeenCalled();
  });

  test("rewrites plain-text attachment data URLs with anonymized content", async () => {
    const boundary = createBoundary();
    const messages: ChatMessage[] = [
      {
        id: "msg_1",
        role: "user",
        parts: [
          {
            type: "file",
            filename: "Jan Novák notes.txt",
            mediaType: TEXT_PLAIN_MIME_TYPE,
            url: toDataUrl(
              Buffer.from("Secret notes for Jan Novák", "utf-8"),
              TEXT_PLAIN_MIME_TYPE,
            ),
          },
        ],
      },
    ];

    const prepared = await prepareMessagesForThirdParty({
      boundary,
      messages,
    });

    expect(Result.isOk(prepared)).toBe(true);
    if (Result.isError(prepared)) {
      throw prepared.error;
    }

    const part = prepared.value?.at(0)?.parts.at(0);

    expect(part).toMatchObject({
      type: "file",
      filename: "[PERSON_1] notes.txt",
      mediaType: TEXT_PLAIN_MIME_TYPE,
    });
    expect(part?.type === "file" ? part.url : "").toContain(
      Buffer.from("[CUSTOM_1] notes for [PERSON_1]", "utf-8").toString(
        "base64",
      ),
    );
  });

  test("returns anonymized live tool output values", async () => {
    const boundary = createBoundary();
    const tools = {
      "read-secret": {
        execute: async () => ({ text: "Secret notes for Jan Novák" }),
      },
    };
    const prepared = prepareToolsForThirdParty({
      boundary,
      // SAFETY: the helper only reads and wraps execute() in this unit test.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      tools: tools as unknown as ToolSet,
    });
    // SAFETY: the test fixture above defines this execute signature.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion
    const executable = prepared["read-secret"] as
      | { execute?: (() => Promise<unknown>) | undefined }
      | undefined;

    expect(await executable?.execute?.()).toEqual({
      text: "[CUSTOM_1] notes for [PERSON_1]",
    });
  });
});
