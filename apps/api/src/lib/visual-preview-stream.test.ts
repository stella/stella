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

const stringFields = function* (value: unknown): Generator<string> {
  if (typeof value === "string") {
    yield value;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      yield* stringFields(item);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      yield* stringFields(item);
    }
  }
};

describe("transient preview wire projection", () => {
  test("rebuilds preview events carrying output and result without mutating the model copy", async () => {
    const chunk = {
      type: EventType.TOOL_CALL_END,
      toolCallId: "preview-call",
      toolName: VISUAL_PREVIEW_TOOL_NAME,
      output,
      result: output,
      timestamp: 1,
      subagentRunId: "preview-run",
      input: { title: "Example" },
      metadata: {
        tanstack: { output, result: output, state: "output-available" },
      },
    } satisfies AdapterYieldChunk;
    const projected = await project([chunk]);
    expect(JSON.stringify(projected)).not.toContain("iVBORw0KGgo=");
    expect(JSON.stringify(projected)).toContain(
      "screenshot omitted from history",
    );
    expect(JSON.stringify(chunk)).toContain("iVBORw0KGgo=");
    expect(await project(projected)).toEqual(projected);
    expect(projected.at(0)).toMatchObject({
      type: EventType.TOOL_CALL_END,
      toolCallId: "preview-call",
      timestamp: 1,
      subagentRunId: "preview-run",
      metadata: {
        tanstack: {
          toolName: VISUAL_PREVIEW_TOOL_NAME,
          input: { title: "Example" },
        },
      },
    });
    for (const value of stringFields(projected)) {
      expect(value).not.toContain("iVBOR");
    }
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

  test("replaces unsupported preview parts with incomplete diagnostics", async () => {
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
    const projected = await project(chunks);
    expect(JSON.stringify(projected)).not.toContain(
      "https://preview.invalid/example.png",
    );
    expect(JSON.stringify(projected)).toContain(
      "Visual preview diagnostics incomplete",
    );
  });

  test.each(["error-event", "source-error", "abort"] as const)(
    "keeps partial preview bytes private when the source ends with %s",
    async (fault) => {
      const terminalError = {
        type: EventType.RUN_ERROR,
        message: "Preview source failed",
        code: "fixture_failure",
      } as const;
      const failure =
        fault === "abort"
          ? new DOMException("Preview source aborted", "AbortError")
          : new Error("Preview source failed");
      const emitted: PublicStreamChunk[] = [];
      const lifecycle = { closed: false };
      const source = async function* (): AsyncIterable<PublicStreamChunk> {
        try {
          yield* normalizeStreamChunk({
            type: EventType.TOOL_CALL_END,
            toolCallId: "preview-call",
            toolName: VISUAL_PREVIEW_TOOL_NAME,
            output: [
              {
                type: "image",
                source: { type: "data", value: "iVBORw0KGgo=" },
              },
            ],
          });
          yield {
            type: EventType.TOOL_CALL_RESULT,
            toolCallId: "preview-call",
            messageId: "assistant",
            content: JSON.stringify(output).slice(0, -1),
          };
          if (fault === "error-event") {
            yield terminalError;
            return;
          }
          throw failure;
        } finally {
          lifecycle.closed = true;
        }
      };
      const consume = async () => {
        for await (const chunk of projectVisualPreviewStream(source())) {
          emitted.push(chunk);
        }
      };
      if (fault === "error-event") {
        await consume();
        expect(emitted.at(-1)).toBe(terminalError);
      } else {
        expect(await rejectionOf(consume())).toBe(failure);
      }
      expect(lifecycle.closed).toBe(true);
      expect(JSON.stringify(emitted)).not.toContain("iVBORw0KGgo=");
      expect(JSON.stringify(emitted)).toContain(
        "screenshot omitted from history",
      );
      const cleanTurn = normalizeStreamChunk({
        type: EventType.TOOL_CALL_END,
        toolCallId: "preview-call",
        toolName: "example_image",
        output,
        result: output,
      });
      expect(await project(cleanTurn)).toEqual(cleanTurn);
    },
  );
});
