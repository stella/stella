import { EventType, type StreamChunk } from "@tanstack/ai";
import { createOpenaiChat } from "@tanstack/ai-openai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { modelMessageToUIMessage, uiMessagesToWire } from "@tanstack/ai/client";
import { panic, Result } from "better-result";
import { expect, test } from "bun:test";

import {
  DOCX_SUGGEST_CHANGES_OPTIONS_BY_SURFACE,
  DOCX_SUGGESTION_SURFACE,
} from "@stll/api-contract/chat-docx-suggestions";
import { parseSuggestChangesInput } from "@stll/folio-agents";

import type { SafeDb } from "@/api/db/safe-db";
import {
  chatMessageContentFromMessage,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import { validateMessage } from "@/api/handlers/chat/chat-schema";
import {
  createSuggestChangesTools,
  SUGGEST_CHANGES_TOOL_NAME,
} from "@/api/handlers/chat/tools/folio-agent-tools";
import { toSafeId } from "@/api/lib/branded-types";

const CALL_ID = "call_seam_suggest_changes";
const MESSAGE_ID = toSafeId<"chatMessage">("msg_seam_suggest_changes");
const ACCEPTED = "accepted";
const REJECTED = "Chat continuation does not match its awaited interaction";
const OUTPUT = { ok: true, queued: ["op-1", "op-2"] };

const SURFACE = DOCX_SUGGESTION_SURFACE.fileOverlay;
const SUGGEST_CHANGES_OPTIONS =
  DOCX_SUGGEST_CHANGES_OPTIONS_BY_SURFACE[SURFACE];
/** The registration the file overlay runs with, not a stand-in for it. */
const clientTools = createSuggestChangesTools(SURFACE);
const suggestChanges = clientTools[SUGGEST_CHANGES_TOOL_NAME];

const noDbReads: SafeDb = async () => {
  throw new Error("This validation path should not read the database");
};

/**
 * A call the production contract accepts. `parseSuggestChangesInput` is the
 * parser the client executes the tool with, built from the same surface
 * options as the registered schema, so a fixture the contract would reject
 * fails here instead of sailing through a permissive stand-in.
 */
const canonicalInput = (blockIds: readonly [string, string]) => {
  const input = {
    operations: [
      {
        type: "deleteBlock",
        blockId: blockIds[0],
        severity: "medium",
        area: "Profiling",
      },
      {
        type: "replaceBlock",
        blockId: blockIds[1],
        text: "Personal data is retained for 30 days.",
        severity: "low",
        area: "Retention",
        styleId: null,
      },
    ],
  };
  const parsed = parseSuggestChangesInput(input, SUGGEST_CHANGES_OPTIONS);
  return parsed.ok
    ? input
    : panic(
        `The seam fixture is not a valid ${SUGGEST_CHANGES_TOOL_NAME} call: ${parsed.error}`,
      );
};

type ProviderToolCall = {
  /** The provider's own text for the call, whitespace and all. */
  arguments: string;
  /** The adapter's parse of that text, which is what the run persists. */
  input: unknown;
};

/**
 * Stream one tool call through the real OpenAI adapter with the real tool
 * registered. The adapter converts the tool's schema for the provider and
 * normalizes the reply against that conversion, so whether an absent optional
 * comes back as `null` is decided by the production schema rather than spelled
 * out here. (Today this schema converts non-strict, so nothing is widened and
 * the `styleId` null above is the schema's own nullable.)
 */
const streamProviderToolCall = async (
  input: unknown,
): Promise<ProviderToolCall> => {
  const argumentsText = JSON.stringify(input, null, 2);
  const adapter = createOpenaiChat("gpt-5.2", "test-key");
  Reflect.set(adapter, "client", {
    responses: {
      create: () =>
        (async function* () {
          yield {
            type: "response.created",
            response: {
              id: "response-1",
              model: "gpt-5.2",
              status: "in_progress",
            },
          };
          yield {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "function_call",
              id: CALL_ID,
              name: SUGGEST_CHANGES_TOOL_NAME,
            },
          };
          yield {
            type: "response.function_call_arguments.delta",
            item_id: CALL_ID,
            delta: argumentsText,
          };
          yield {
            type: "response.function_call_arguments.done",
            item_id: CALL_ID,
            arguments: argumentsText,
          };
          yield {
            type: "response.completed",
            response: {
              id: "response-1",
              model: "gpt-5.2",
              status: "completed",
              output: [
                {
                  type: "function_call",
                  id: CALL_ID,
                  name: SUGGEST_CHANGES_TOOL_NAME,
                  arguments: argumentsText,
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          };
        })(),
    },
  });

  const chunks: StreamChunk[] = [];
  for await (const chunk of adapter.chatStream({
    logger: resolveDebugOption(false),
    messages: [{ role: "user", content: "Suggest changes." }],
    model: adapter.model,
    tools: [suggestChanges],
  })) {
    chunks.push(chunk);
  }

  for (const chunk of chunks) {
    if (chunk.type === EventType.TOOL_CALL_END) {
      return { arguments: argumentsText, input: chunk.input };
    }
  }
  return panic("The stubbed provider stream ended without a tool call");
};

/**
 * The persisted assistant message, built the way the run builds it: the raw
 * provider text plus the adapter's parse of it, through the real v3 write path.
 */
const persistedAssistantContent = (call: ProviderToolCall) =>
  chatMessageContentFromMessage(
    toPersistableChatMessage({
      id: MESSAGE_ID,
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: CALL_ID,
          name: SUGGEST_CHANGES_TOOL_NAME,
          arguments: call.arguments,
          input: call.input,
          state: "input-complete",
        },
      ],
    }),
  );

/**
 * The continuation parts the browser sends back, derived rather than written
 * out: server UI message to AG-UI wire (`uiMessagesToWire`), wire back to a UI
 * message (`modelMessageToUIMessage`, which is what the snapshot normalizer
 * delegates to for an assistant message), then `addToolResult`'s edit. The wire
 * carries only `arguments`, so the rebuilt part's `input` is a re-parse of the
 * provider's text: that is the seam this binds.
 */
const clientContinuationParts = (rawArguments: string) => {
  const wireAnchor = uiMessagesToWire([
    {
      id: MESSAGE_ID,
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: CALL_ID,
          name: SUGGEST_CHANGES_TOOL_NAME,
          arguments: rawArguments,
          state: "input-complete",
        },
      ],
    },
  ]).at(0);
  if (wireAnchor?.role !== "assistant") {
    throw new Error("The snapshot wire message lost its assistant anchor");
  }

  const rebuiltCall = modelMessageToUIMessage(
    {
      role: "assistant",
      content: wireAnchor.content ?? null,
      ...(wireAnchor.toolCalls && { toolCalls: wireAnchor.toolCalls }),
    },
    wireAnchor.id,
  ).parts.find((part) => part.type === "tool-call");
  if (rebuiltCall === undefined) {
    throw new Error("The rebuilt UI message lost its tool call");
  }

  return [
    { ...rebuiltCall, output: OUTPUT, state: "complete" },
    {
      type: "tool-result",
      toolCallId: CALL_ID,
      content: JSON.stringify(OUTPUT),
      state: "complete",
    },
  ];
};

const continuationOutcome = async ({
  persisted,
  rawArguments,
}: {
  persisted: ProviderToolCall;
  rawArguments: string;
}): Promise<string> => {
  const result = await validateMessage({
    message: {
      id: MESSAGE_ID,
      role: "assistant",
      parts: clientContinuationParts(rawArguments),
    },
    persistedMessage: {
      role: "assistant",
      content: persistedAssistantContent(persisted),
    },
    resume: [
      {
        interruptId: `client_tool_${CALL_ID}`,
        payload: OUTPUT,
        status: "resolved",
      },
    ],
    safeDb: noDbReads,
    threadId: toSafeId<"chatThread">("thread_seam_suggest_changes"),
    tools: clientTools,
    userId: toSafeId<"user">("user_seam_suggest_changes"),
  });
  return Result.isOk(result) ? ACCEPTED : result.error.message;
};

test("accepts the continuation the client library rebuilds from the snapshot", async () => {
  const call = await streamProviderToolCall(canonicalInput(["b_42", "b_43"]));

  expect(
    await continuationOutcome({
      persisted: call,
      rawArguments: call.arguments,
    }),
  ).toBe(ACCEPTED);
});

test("rejects a continuation whose rebuilt call edits a different block", async () => {
  const call = await streamProviderToolCall(canonicalInput(["b_42", "b_43"]));
  const drifted = await streamProviderToolCall(
    canonicalInput(["b_42", "b_99"]),
  );

  expect(
    await continuationOutcome({
      persisted: call,
      rawArguments: drifted.arguments,
    }),
  ).toBe(REJECTED);
});
