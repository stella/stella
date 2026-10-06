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
  test.each([false, true])(
    "ordinary events remain identical after a preview=%s",
    async (afterPreview) => {
      const messages = uiMessagesToWire([
        { id: "user", role: "user", content: "Example request" },
        {
          id: "assistant",
          role: "assistant",
          content: "Example answer",
          toolCalls: [
            {
              id: "ordinary-call",
              type: "function",
              function: { name: "example_image", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "ordinary-call",
          name: "example_image",
          content: output,
          metadata: {
            tanstack: { result: output, createdAt: "2026-01-01T00:00:00Z" },
          },
        },
      ]);
      const ordinary = [
        {
          timestamp: 1,
          type: EventType.RUN_STARTED,
          threadId: "thread",
          runId: "run",
        },
        {
          timestamp: 2,
          type: EventType.TOOL_CALL_START,
          toolCallId: "ordinary-call",
          toolCallName: "example_image",
        },
        ...normalizeStreamChunk({
          timestamp: 3,
          type: EventType.TOOL_CALL_END,
          toolCallId: "ordinary-call",
          toolName: "example_image",
          input: {},
          output,
          result: output,
        }),
        {
          timestamp: 4,
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: "ordinary-call",
          messageId: "message",
          content: JSON.stringify(output),
        },
        { timestamp: 5, type: EventType.MESSAGES_SNAPSHOT, messages },
        {
          timestamp: 6,
          type: EventType.RUN_FINISHED,
          threadId: "thread",
          runId: "run",
        },
      ] satisfies PublicStreamChunk[];
      const previewStart = {
        type: EventType.TOOL_CALL_START,
        toolCallId: "preview-call",
        toolCallName: VISUAL_PREVIEW_TOOL_NAME,
      } satisfies PublicStreamChunk;
      const chunks = afterPreview ? [previewStart, ...ordinary] : ordinary;
      const serialized = JSON.stringify(chunks);
      const projected = await project(chunks);
      expect(projected).toEqual(chunks);
      expect(JSON.stringify(projected)).toBe(serialized);
      for (const [index, chunk] of chunks.entries()) {
        expect(projected.at(index)).toBe(chunk);
      }
    },
  );

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

  test("rebuilds result envelopes and metadata while preserving diagnostics and identity", async () => {
    const start = {
      type: EventType.TOOL_CALL_START,
      toolCallId: "preview-call",
      toolCallName: VISUAL_PREVIEW_TOOL_NAME,
    } as const;
    const aliases = { output, result: output };
    const chunk = {
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: "preview-call",
      messageId: "assistant",
      content: JSON.stringify(output),
      timestamp: 2,
      subagentRunId: "preview-run",
      ...aliases,
      metadata: {
        additional: output,
        tanstack: {
          state: "output-available",
          output,
          result: output,
          additional: output,
          toolResult: {
            id: "result-message",
            createdAt: "2026-01-01T00:00:00.000Z",
            content: output,
            result: output,
            additional: output,
          },
        },
      },
    } satisfies PublicStreamChunk;
    const projected = await project([start, chunk]);
    expect(projected.at(1)).toMatchObject({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: "preview-call",
      messageId: "assistant",
      timestamp: 2,
      subagentRunId: "preview-run",
      metadata: {
        tanstack: {
          state: "output-available",
          toolResult: {
            id: "result-message",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    });
    expect(JSON.stringify(projected)).toContain(
      "screenshot omitted from history",
    );
    expect(JSON.stringify(chunk)).toContain("iVBORw0KGgo=");
    for (const value of stringFields(projected)) {
      expect(value).not.toContain("iVBOR");
    }
    expect(await project(projected)).toEqual(projected);
  });

  test.each(["serialized", "parts", "named-result"] as const)(
    "projects SDK snapshot %s and metadata without prior tool events",
    async (shape) => {
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
        {
          role: "tool",
          toolCallId: "preview-call",
          name: VISUAL_PREVIEW_TOOL_NAME,
          content: output,
          metadata: {
            additional: output,
            tanstack: { result: output, output },
          },
        },
      ])
        .filter(
          (message) => shape !== "named-result" || message.role === "tool",
        )
        .map((message) => {
          if (message.role !== "assistant") {
            if (message.role !== "tool" || shape !== "parts") {
              return message;
            }
            return {
              ...message,
              result: output,
              content: output.map((part) =>
                part.type === "text"
                  ? { type: part.type, text: part.content }
                  : part,
              ),
            };
          }
          return {
            ...message,
            result: output,
            metadata: { tanstack: { result: output, output } },
            ...(message.toolCalls !== undefined && {
              toolCalls: message.toolCalls.map((call) => ({
                ...call,
                result: output,
                metadata: { result: output },
                function: { ...call.function, result: output },
              })),
            }),
          };
        });
      expect(JSON.stringify(messages)).toContain("iVBORw0KGgo=");
      const snapshotAliases = {
        result: output,
        metadata: { tanstack: { result: output } },
      };
      const projected = await project([
        {
          type: EventType.MESSAGES_SNAPSHOT,
          messages,
          ...snapshotAliases,
        },
      ]);
      expect(JSON.stringify(projected)).not.toContain("iVBORw0KGgo=");
      expect(JSON.stringify(projected)).toContain(
        "screenshot omitted from history",
      );
      expect(JSON.stringify(messages)).toContain("iVBORw0KGgo=");
      for (const value of stringFields(projected)) {
        expect(value).not.toContain("iVBOR");
      }
      expect(await project(projected)).toEqual(projected);
    },
  );

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
