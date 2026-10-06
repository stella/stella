import {
  EventType,
  normalizeStreamChunk,
  uiMessagesToWire,
} from "@tanstack/ai";
import type { AdapterYieldChunk } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import { VISUAL_PREVIEW_TOOL_NAME } from "@stll/api-contract/visual-preview";
import { rejectionOf } from "@stll/property-testing/rejection";

import type { PublicStreamChunk } from "@/api/lib/chat/tanstack-chat-runtime";
import { visualPreviewModelContent } from "@/api/lib/visual-preview";
import { projectVisualPreviewStream } from "@/api/lib/visual-preview-stream";

const output = visualPreviewModelContent({
  title: "Example",
  preview: {
    png: "iVBORw0KGgo=",
    consoleErrors: [],
    blockedRequests: 0,
    size: { width: 1200, height: 200 },
    readyFired: true,
  },
});

const project = async (chunks: PublicStreamChunk[]) => {
  const source = async function* () {
    yield* chunks;
  };
  return await Array.fromAsync(projectVisualPreviewStream(source()));
};

describe("transient preview wire projection", () => {
  test("replaces both top-level and metadata output without mutating the model copy", async () => {
    const chunk = {
      type: EventType.TOOL_CALL_END,
      toolCallId: "preview-call",
      toolName: VISUAL_PREVIEW_TOOL_NAME,
      output,
      metadata: { tanstack: { output, state: "output-available" } },
    } satisfies AdapterYieldChunk;
    const projected = await project([chunk]);
    expect(JSON.stringify(projected)).not.toContain("iVBORw0KGgo=");
    expect(JSON.stringify(projected)).toContain(
      "screenshot omitted from history",
    );
    expect(JSON.stringify(chunk)).toContain("iVBORw0KGgo=");
    expect(await project(projected)).toEqual(projected);
  });

  test("projects SDK snapshot content and its metadata copy without prior tool events", async () => {
    const messages = uiMessagesToWire([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "preview-call",
            type: "function",
            function: { name: VISUAL_PREVIEW_TOOL_NAME, arguments: "{}" },
          },
        ],
      },
      { role: "tool", toolCallId: "preview-call", content: output },
    ]);
    expect(JSON.stringify(messages)).toContain("iVBORw0KGgo=");
    const projected = await project([
      { type: EventType.MESSAGES_SNAPSHOT, messages },
    ]);
    expect(JSON.stringify(projected)).not.toContain("iVBORw0KGgo=");
    expect(JSON.stringify(projected)).toContain(
      "screenshot omitted from history",
    );
    expect(JSON.stringify(messages)).toContain("iVBORw0KGgo=");
  });

  test("preserves text-only previews and SDK error envelopes", async () => {
    const start = {
      type: EventType.TOOL_CALL_START,
      toolCallId: "preview-call",
      toolCallName: VISUAL_PREVIEW_TOOL_NAME,
    } as const;
    for (const content of [
      JSON.stringify([{ type: "text", content: "Preview unavailable" }]),
      "Preview failed",
      JSON.stringify({ error: "Preview failed" }),
    ]) {
      const result = {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "preview-call",
        messageId: "assistant",
        content,
      } as const;
      expect(await project([start, result])).toEqual([start, result]);
    }
  });

  test("preserves unrelated tool images", async () => {
    const chunks = normalizeStreamChunk({
      type: EventType.TOOL_CALL_END,
      toolCallId: "other-call",
      toolName: "example_image",
      output,
      result: output,
    });
    expect(await project(chunks)).toEqual(chunks);
  });

  test("rejects unsupported preview parts before forwarding", async () => {
    const chunks = normalizeStreamChunk({
      type: EventType.TOOL_CALL_END,
      toolCallId: "preview-call",
      toolName: VISUAL_PREVIEW_TOOL_NAME,
      output: [
        {
          type: "image",
          source: { type: "url", value: "https://preview.invalid/example.png" },
        },
      ],
    });
    expect(await rejectionOf(project(chunks))).toMatchObject({
      message: "Visual preview tool returned unsupported content parts",
    });
  });
});
