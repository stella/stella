import { EventType } from "@tanstack/ai";
import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  VISUAL_PREVIEW_TOOL_NAME,
  visualPreviewToolOutputSchema,
  type VisualPreviewToolOutput,
} from "@stll/api-contract/visual-preview";

import {
  toolCallEndInputOf,
  toolCallEndOutputOf,
  toolCallNameOf,
} from "@/api/lib/chat/tanstack-chat-runtime";
import type { PublicStreamChunk } from "@/api/lib/chat/tanstack-chat-runtime";
import { isRecord } from "@/api/lib/type-guards";

const incompleteHistoryContent = () =>
  [
    {
      type: "text",
      content:
        "Visual preview diagnostics incomplete.\nscreenshot omitted from history",
    },
  ] satisfies VisualPreviewToolOutput;

const historyContent = (value: unknown) => {
  const parsed = v.safeParse(visualPreviewToolOutputSchema, value);
  if (!parsed.success) {
    return incompleteHistoryContent();
  }
  const parts = parsed.output;
  if (parts.length === 1) {
    return parts;
  }
  const projected = v.safeParse(visualPreviewToolOutputSchema, [
    {
      type: "text",
      content: `${parts[0].content}\nscreenshot omitted from history`,
    },
  ]);
  if (!projected.success) {
    return incompleteHistoryContent();
  }
  return projected.output;
};

const historyWireContent = (content: string) => {
  const parsed = Result.try((): unknown => JSON.parse(content));
  if (Result.isError(parsed)) {
    // A truncated JSON result must not forward a partially encoded image.
    return /^[[{]/u.test(content.trimStart())
      ? JSON.stringify(incompleteHistoryContent())
      : content;
  }
  if (Array.isArray(parsed.value)) {
    return JSON.stringify(historyContent(parsed.value));
  }
  // SDK failures may be ordinary text or a single error field. Other JSON
  // values are incomplete preview payloads, never safe history diagnostics.
  if (
    isRecord(parsed.value) &&
    Object.keys(parsed.value).length === 1 &&
    typeof parsed.value["error"] === "string"
  ) {
    return content;
  }
  return JSON.stringify(incompleteHistoryContent());
};

const historyMetadata = (metadata: unknown) => {
  if (!isRecord(metadata) || !isRecord(metadata["tanstack"])) {
    return undefined;
  }
  const tanstack = metadata["tanstack"];
  const toolResult = tanstack["toolResult"];
  // SDK metadata is an open bag. Only diagnostics and reconstruction fields
  // belong in history; aliases and future payload fields must drop by default.
  return {
    tanstack: {
      ...(typeof tanstack["createdAt"] === "string" && {
        createdAt: tanstack["createdAt"],
      }),
      ...(typeof tanstack["model"] === "string" && {
        model: tanstack["model"],
      }),
      ...(typeof tanstack["runId"] === "string" && {
        runId: tanstack["runId"],
      }),
      ...((tanstack["state"] === "output-available" ||
        tanstack["state"] === "output-error") && {
        state: tanstack["state"],
      }),
      ...(tanstack["output"] !== undefined && {
        output: historyContent(tanstack["output"]),
      }),
      ...(isRecord(toolResult) && {
        toolResult: {
          ...(typeof toolResult["id"] === "string" && {
            id: toolResult["id"],
          }),
          ...(typeof toolResult["createdAt"] === "string" && {
            createdAt: toolResult["createdAt"],
          }),
          ...(toolResult["content"] !== undefined && {
            content:
              typeof toolResult["content"] === "string"
                ? historyWireContent(toolResult["content"])
                : historyContent(toolResult["content"]),
          }),
        },
      }),
    },
  };
};

// Project only the engine's wire copy. The SDK retains the original parts for
// its next model iteration; logs, processors and clients receive diagnostics.
export const projectVisualPreviewStream = async function* (
  source: AsyncIterable<PublicStreamChunk>,
): AsyncIterable<PublicStreamChunk> {
  const previewCallIds = new Set<string>();
  for await (const chunk of source) {
    if (
      (chunk.type === EventType.TOOL_CALL_START ||
        chunk.type === EventType.TOOL_CALL_END) &&
      toolCallNameOf(chunk) === VISUAL_PREVIEW_TOOL_NAME
    ) {
      previewCallIds.add(chunk.toolCallId);
    }
    if (
      chunk.type === EventType.TOOL_CALL_END &&
      previewCallIds.has(chunk.toolCallId)
    ) {
      const output = toolCallEndOutputOf(chunk);
      const projected = {
        type: chunk.type,
        toolCallId: chunk.toolCallId,
        metadata: {
          tanstack: {
            toolName: VISUAL_PREVIEW_TOOL_NAME,
            input: toolCallEndInputOf(chunk),
            output: output === undefined ? undefined : historyContent(output),
          },
        },
      } satisfies PublicStreamChunk;
      if (chunk.timestamp !== undefined) {
        Object.assign(projected, { timestamp: chunk.timestamp });
      }
      if (chunk.subagentRunId !== undefined) {
        Object.assign(projected, { subagentRunId: chunk.subagentRunId });
      }
      yield projected;
      continue;
    }
    if (
      chunk.type === EventType.TOOL_CALL_RESULT &&
      previewCallIds.has(chunk.toolCallId)
    ) {
      if (typeof chunk.content !== "string") {
        panic("The engine emits preview wire results as strings");
      }
      const projected = {
        type: chunk.type,
        toolCallId: chunk.toolCallId,
        messageId: chunk.messageId,
        content: historyWireContent(chunk.content),
      } satisfies PublicStreamChunk;
      if (chunk.timestamp !== undefined) {
        Object.assign(projected, { timestamp: chunk.timestamp });
      }
      if (chunk.subagentRunId !== undefined) {
        Object.assign(projected, { subagentRunId: chunk.subagentRunId });
      }
      if (chunk.role !== undefined) {
        Object.assign(projected, { role: chunk.role });
      }
      if (chunk.metadata !== undefined) {
        Object.assign(projected, { metadata: historyMetadata(chunk.metadata) });
      }
      yield projected;
      continue;
    }
    if (chunk.type === EventType.MESSAGES_SNAPSHOT) {
      // Snapshots fan tool results out as AG-UI role:tool messages. Seed all
      // identities first, because a snapshot can arrive without prior events.
      for (const message of chunk.messages) {
        if (message.role !== "assistant") {
          continue;
        }
        for (const call of message.toolCalls ?? []) {
          if (call.function.name === VISUAL_PREVIEW_TOOL_NAME) {
            previewCallIds.add(call.id);
          }
        }
      }
      const messages = chunk.messages.map((message) => {
        if (
          message.role === "assistant" &&
          message.toolCalls?.some((call) => previewCallIds.has(call.id))
        ) {
          return {
            role: message.role,
            id: message.id,
            ...(message.content !== undefined && { content: message.content }),
            ...(message.name !== undefined && { name: message.name }),
            ...(message.encryptedValue !== undefined && {
              encryptedValue: message.encryptedValue,
            }),
            ...(message.subagentRunId !== undefined && {
              subagentRunId: message.subagentRunId,
            }),
            toolCalls: message.toolCalls.map((call) =>
              previewCallIds.has(call.id)
                ? {
                    id: call.id,
                    type: call.type,
                    function: {
                      name: call.function.name,
                      arguments: call.function.arguments,
                    },
                    ...(call.encryptedValue !== undefined && {
                      encryptedValue: call.encryptedValue,
                    }),
                  }
                : call,
            ),
            ...(message.metadata !== undefined && {
              metadata: historyMetadata(message.metadata),
            }),
          };
        }
        if (
          message.role !== "tool" ||
          !previewCallIds.has(message.toolCallId)
        ) {
          return message;
        }
        const content =
          typeof message.content === "string"
            ? historyWireContent(message.content)
            : JSON.stringify(
                historyContent(
                  message.content.map((part) =>
                    part.type === "text"
                      ? { type: "text", content: part.text }
                      : part,
                  ),
                ),
              );
        return {
          role: message.role,
          id: message.id,
          toolCallId: message.toolCallId,
          content,
          ...(message.name !== undefined && { name: message.name }),
          ...(message.error !== undefined && { error: message.error }),
          ...(message.subagentRunId !== undefined && {
            subagentRunId: message.subagentRunId,
          }),
          ...(message.metadata !== undefined && {
            metadata: historyMetadata(message.metadata),
          }),
        };
      });
      const projected = {
        type: chunk.type,
        messages,
      } satisfies PublicStreamChunk;
      if (chunk.timestamp !== undefined) {
        Object.assign(projected, { timestamp: chunk.timestamp });
      }
      if (chunk.subagentRunId !== undefined) {
        Object.assign(projected, { subagentRunId: chunk.subagentRunId });
      }
      yield projected;
      continue;
    }
    yield chunk;
  }
};
