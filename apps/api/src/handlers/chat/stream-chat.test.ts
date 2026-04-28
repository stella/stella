import type { InferUIMessageChunk } from "ai";
import { describe, expect, test } from "bun:test";

import type { ChatMessage } from "@/api/handlers/chat/types";

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
});
