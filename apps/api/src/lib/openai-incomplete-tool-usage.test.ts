import { chat, EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { createOpenaiChat } from "@tanstack/ai-openai";
import { expect, test } from "bun:test";

import { tokenUsageFromTerminalChunk } from "@/api/lib/tanstack-ai-usage";

test.each([true, false])(
  "preserves reported usage without inventing it on an incomplete OpenAI tool call (reported: %s)",
  async (reported) => {
    const usage = reported
      ? {
          input_tokens: 13,
          output_tokens: 7,
          total_tokens: 20,
          input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 5 },
        }
      : undefined;
    const event = {
      type: "response.completed",
      sequence_number: 0,
      response: {
        id: "resp_incomplete_tool",
        object: "response",
        created_at: 0,
        status: "completed",
        model: "gpt-5.2",
        output: [
          {
            type: "apply_patch_call",
            id: "item_incomplete_tool",
            call_id: "call_incomplete_tool",
            status: "in_progress",
            operation: { type: "create_file", path: "draft.txt", diff: "" },
          },
        ],
        usage,
      },
    };
    let requests = 0;
    const adapter = createOpenaiChat("gpt-5.2", "test-openai-key", {
      fetch: Object.assign(
        async () => {
          requests++;
          return new Response(
            `event: response.completed\ndata: ${JSON.stringify(event)}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    });
    const chunks: StreamChunk[] = [];
    // Exercise the real SDK's SSE parser and the published adapter. No tool
    // implementation is registered: an unfinished call must never execute.
    for await (const chunk of chat({
      adapter,
      threadId: "incomplete-tool-usage",
      messages: [{ role: "user", content: "Prepare a draft." }],
      stream: true,
      debug: false,
    })) {
      chunks.push(chunk);
    }

    expect(requests).toBe(1);
    const terminals = chunks.filter(
      (chunk) =>
        chunk.type === EventType.RUN_ERROR ||
        chunk.type === EventType.RUN_FINISHED,
    );
    expect(terminals).toHaveLength(1);
    const terminal = terminals.at(0);
    expect(terminal).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "incomplete-tool-call",
    });
    expect(chunks.some((chunk) => chunk.type === EventType.TOOL_CALL_END)).toBe(
      false,
    );
    expect(
      terminal === undefined
        ? undefined
        : tokenUsageFromTerminalChunk(terminal),
    ).toEqual(
      reported
        ? {
            promptTokens: 13,
            completionTokens: 7,
            totalTokens: 20,
            promptTokensDetails: { cachedTokens: 3, cacheWriteTokens: 2 },
            completionTokensDetails: { reasoningTokens: 5 },
          }
        : undefined,
    );
  },
);
