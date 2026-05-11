import type { InferUIMessageChunk } from "ai";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { createPipelineContext } from "@stll/anonymize-wasm";

import type { ScopedDb } from "@/api/db";
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import { createChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import type { ChatMessage } from "@/api/handlers/chat/types";
import { toUserFileUrl } from "@/api/handlers/user-files/types";
import { toSafeId } from "@/api/lib/branded-types";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import {
  deanonymizeOutgoingStream,
  hydrateMessages,
  resolveRefsInTextStream,
} from "./stream-chat";

type ChatChunk = InferUIMessageChunk<ChatMessage>;

const collectChunks = async (
  stream: ReadableStream<ChatChunk>,
): Promise<ChatChunk[]> => {
  const chunks: ChatChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
};

const collectText = (chunks: readonly ChatChunk[]) => {
  let text = "";
  for (const chunk of chunks) {
    if (chunk.type === "text-delta") {
      text += chunk.delta;
    }
  }
  return text;
};

const scopedDb: ScopedDb = async () => {
  throw new Error("Expected stream deanonymization test not to access DB");
};

const createBoundary = (
  pairs: readonly (readonly [string, string])[],
): Extract<ChatThirdPartyBoundary, { type: "anonymized" }> => ({
  anonymizationScopeId: "workspace-A",
  gazetteerEntries: Promise.resolve([]),
  organizationId: toSafeId<"organization">("org_test"),
  pipelineContext: createPipelineContext(),
  redactionMap: new Map(pairs),
  scopedDb,
  type: "anonymized",
});

const streamChunks = (
  chunks: readonly ChatChunk[],
): ReadableStream<ChatChunk> =>
  new ReadableStream<ChatChunk>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

describe("chat stream refs", () => {
  test("resolves assistant text refs across streamed chunk boundaries", async () => {
    const chunks: ChatChunk[] = [
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

    const resolvedChunks = await collectChunks(
      resolveRefsInTextStream(streamChunks(chunks), (text) =>
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

    const chunks: ChatChunk[] = [
      { id: "text_1", type: "text-start" },
      {
        delta: `Utworzyłem nowy dokument ${mention}.`,
        id: "text_1",
        type: "text-delta",
      },
      { id: "text_1", type: "text-end" },
    ];

    const resolvedChunks = await collectChunks(
      resolveRefsInTextStream(
        streamChunks(chunks),
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

    const chunks: ChatChunk[] = [
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

    const [resolvedChunk] = await collectChunks(
      resolveRefsInTextStream(
        streamChunks(chunks),
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

describe("anonymized outgoing chat stream", () => {
  test("does not emit system-context-only restoration pairs", async () => {
    const boundary = createBoundary([
      ["[PERSON_1]", "System Only"],
      ["[PERSON_2]", "Jan Novak"],
    ]);
    const stream = deanonymizeOutgoingStream(
      streamChunks([
        { type: "text-delta", id: "text-1", delta: "Hello" },
        { type: "text-end", id: "text-1" },
      ]),
      boundary,
      {
        initialRestorationPlaceholders: new Set(["[PERSON_2]"]),
      },
    );

    expect(await collectChunks(stream)).toEqual([
      {
        type: "data-stella-anon-restorations",
        data: { pairs: [{ placeholder: "[PERSON_2]", original: "Jan Novak" }] },
      },
      { type: "text-delta", id: "text-1", delta: "Hello" },
      { type: "text-end", id: "text-1" },
    ]);
  });

  test("emits a restoration pair when assistant text uses a placeholder", async () => {
    const boundary = createBoundary([["[PERSON_1]", "Jan Novak"]]);
    const stream = deanonymizeOutgoingStream(
      streamChunks([
        { type: "text-delta", id: "text-1", delta: "[PERSON_1]" },
        { type: "text-end", id: "text-1" },
      ]),
      boundary,
    );

    expect(await collectChunks(stream)).toEqual([
      {
        type: "data-stella-anon-restorations",
        data: { pairs: [{ placeholder: "[PERSON_1]", original: "Jan Novak" }] },
      },
      { type: "text-delta", id: "text-1", delta: "Jan Novak" },
      { type: "text-end", id: "text-1" },
    ]);
  });
});
