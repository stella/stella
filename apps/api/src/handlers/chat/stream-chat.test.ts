import type { InferUIMessageChunk } from "ai";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { createChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import type { ChatMessage } from "@/api/handlers/chat/types";
import { toUserFileUrl } from "@/api/handlers/user-files/types";
import { toSafeId } from "@/api/lib/branded-types";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { hydrateMessages, resolveRefsInTextStream } from "./stream-chat";

const collectChunks = async (
  stream: ReadableStream<InferUIMessageChunk<ChatMessage>>,
) => {
  const chunks: InferUIMessageChunk<ChatMessage>[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
};

const collectText = (chunks: InferUIMessageChunk<ChatMessage>[]) => {
  let text = "";
  for (const chunk of chunks) {
    if (chunk.type === "text-delta") {
      text += chunk.delta;
    }
  }
  return text;
};

describe("chat stream refs", () => {
  test("resolves assistant text refs across streamed chunk boundaries", async () => {
    const chunks: InferUIMessageChunk<ChatMessage>[] = [
      { id: "text_1", type: "text-start" },
      {
        delta: "Open [Document](",
        id: "text_1",
        type: "text-delta",
      },
      {
        delta: "#stella-entity-ref=",
        id: "text_1",
        type: "text-delta",
      },
      {
        delta: "ent_1) now.",
        id: "text_1",
        type: "text-delta",
      },
      { id: "text_1", type: "text-end" },
    ];

    const stream = new ReadableStream<InferUIMessageChunk<ChatMessage>>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });

    const resolvedChunks = await collectChunks(
      resolveRefsInTextStream(stream, (text) =>
        text.replace(
          "#stella-entity-ref=ent_1",
          "#stella-entity=workspace_1:entity_1",
        ),
      ),
    );

    expect(collectText(resolvedChunks)).toBe(
      "Open [Document](#stella-entity=workspace_1:entity_1) now.",
    );
  });

  test("resolves newly created document mentions in assistant text", async () => {
    const registry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">(
      "0dc54d0c-10d7-501d-897e-e801dbd0998c",
    );
    const entityId = toSafeId<"entity">("c09ec856-d945-5ecc-82e3-bb5382165f34");
    const mention = registry.toEntityMention({
      entityId,
      label: "Mzuri_Umowa_Strona_1.docx",
      workspaceId,
    });

    const chunks: InferUIMessageChunk<ChatMessage>[] = [
      { id: "text_1", type: "text-start" },
      {
        delta: `Utworzyłem nowy dokument ${mention}.`,
        id: "text_1",
        type: "text-delta",
      },
      { id: "text_1", type: "text-end" },
    ];

    const stream = new ReadableStream<InferUIMessageChunk<ChatMessage>>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });

    const resolvedChunks = await collectChunks(
      resolveRefsInTextStream(
        stream,
        registry.resolveAssistantTextRefs,
        registry.resolveAssistantValueRefs,
      ),
    );

    expect(collectText(resolvedChunks)).toBe(
      "Utworzyłem nowy dokument " +
        "[Mzuri_Umowa_Strona_1.docx](#stella-entity=0dc54d0c-10d7-501d-897e-e801dbd0998c:c09ec856-d945-5ecc-82e3-bb5382165f34).",
    );
  });

  test("resolves refs in streamed tool outputs for the live UI", async () => {
    const registry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">(
      "0dc54d0c-10d7-501d-897e-e801dbd0998c",
    );
    const entityId = toSafeId<"entity">("c09ec856-d945-5ecc-82e3-bb5382165f34");
    const mention = registry.toEntityMention({
      entityId,
      label: "Mzuri_Umowa_Strona_1.docx",
      workspaceId,
    });

    const chunks: InferUIMessageChunk<ChatMessage>[] = [
      {
        type: "tool-output-available",
        toolCallId: "tool_1",
        output: {
          fileName: "Mzuri_Umowa_Strona_1.docx",
          href: "#stella-entity-ref=ent_1",
          mention,
          success: true,
        },
      },
    ];

    const stream = new ReadableStream<InferUIMessageChunk<ChatMessage>>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });

    const [resolvedChunk] = await collectChunks(
      resolveRefsInTextStream(
        stream,
        registry.resolveAssistantTextRefs,
        registry.resolveAssistantValueRefs,
      ),
    );

    expect(resolvedChunk).toEqual({
      type: "tool-output-available",
      toolCallId: "tool_1",
      output: {
        fileName: "Mzuri_Umowa_Strona_1.docx",
        href: "#stella-entity=0dc54d0c-10d7-501d-897e-e801dbd0998c:c09ec856-d945-5ecc-82e3-bb5382165f34",
        mention:
          "[Mzuri_Umowa_Strona_1.docx](#stella-entity=0dc54d0c-10d7-501d-897e-e801dbd0998c:c09ec856-d945-5ecc-82e3-bb5382165f34)",
        success: true,
      },
    });
  });
});

describe("chat message hydration", () => {
  test("refuses stored DOCX attachments for anonymized third-party sends", async () => {
    const userFileId = toSafeId<"userFile">(
      "11111111-1111-4111-8111-111111111111",
    );
    const threadId = toSafeId<"chatThread">(
      "22222222-2222-4222-8222-222222222222",
    );
    const userId = toSafeId<"user">("33333333-3333-4333-8333-333333333333");
    const { safeDb } = createScopedDbMock({
      query: {
        userFiles: {
          findMany: async () => [
            {
              id: userFileId,
              userId,
              threadId,
              fileName: "draft.docx",
              mimeType: DOCX_MIME_TYPE,
              s3Key: "user/file",
            },
          ],
        },
      },
    });

    const result = await hydrateMessages({
      messages: [
        {
          id: "msg_1",
          role: "user",
          parts: [
            {
              type: "file",
              filename: "draft.docx",
              mediaType: DOCX_MIME_TYPE,
              url: toUserFileUrl(userFileId),
            },
          ],
        },
      ],
      refuseNonPlainTextFiles: true,
      safeDb,
      userId,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("Expected DOCX hydration refusal");
    }

    if (!("status" in result.error)) {
      throw result.error;
    }

    expect(result.error.status).toBe(422);
  });
});
