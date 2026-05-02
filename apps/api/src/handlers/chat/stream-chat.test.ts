import type { InferUIMessageChunk } from "ai";
import { describe, expect, test } from "bun:test";

import { createChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import type { ChatMessage } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";

import { resolveRefsInTextStream } from "./stream-chat";

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
