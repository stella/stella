import { EventType } from "@tanstack/ai";
import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  VISUAL_PREVIEW_TOOL_NAME,
  visualPreviewToolOutputSchema,
} from "@stll/api-contract/visual-preview";

import {
  toolCallEndOutputOf,
  toolCallNameOf,
} from "@/api/lib/chat/tanstack-chat-runtime";
import type { PublicStreamChunk } from "@/api/lib/chat/tanstack-chat-runtime";
import { isRecord } from "@/api/lib/type-guards";

const historyContent = (value: unknown) => {
  const parsed = v.safeParse(visualPreviewToolOutputSchema, value);
  if (!parsed.success) {
    return panic("Visual preview tool returned unsupported content parts");
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
    return panic("Visual preview history diagnostics exceed their bounds");
  }
  return projected.output;
};

const historyWireContent = (content: string) => {
  const parsed = Result.try((): unknown => JSON.parse(content));
  // SDK tool failures are ordinary text or JSON error objects, not parts.
  if (Result.isError(parsed) || !Array.isArray(parsed.value)) {
    return content;
  }
  return JSON.stringify(historyContent(parsed.value));
};

const historyMetadata = (metadata: unknown) => {
  if (!isRecord(metadata) || !isRecord(metadata["tanstack"])) {
    return metadata;
  }
  const tanstack = { ...metadata["tanstack"] };
  if (Array.isArray(tanstack["output"])) {
    tanstack["output"] = historyContent(tanstack["output"]);
  }
  const toolResult = tanstack["toolResult"];
  if (isRecord(toolResult) && Array.isArray(toolResult["content"])) {
    tanstack["toolResult"] = {
      ...toolResult,
      content: historyContent(toolResult["content"]),
    };
  }
  return { ...metadata, tanstack };
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
      const projected = { ...chunk };
      if (Array.isArray(output)) {
        Object.assign(projected, { output: historyContent(output) });
      }
      if (chunk.metadata !== undefined) {
        Object.assign(projected, { metadata: historyMetadata(chunk.metadata) });
      }
      yield projected;
      continue;
    }
    if (
      chunk.type === EventType.TOOL_CALL_RESULT &&
      previewCallIds.has(chunk.toolCallId)
    ) {
      if (typeof chunk.content !== "string") {
        return panic("The engine emits preview wire results as strings");
      }
      const projected = {
        ...chunk,
        content: historyWireContent(chunk.content),
      };
      if (chunk.metadata !== undefined) {
        Object.assign(projected, { metadata: historyMetadata(chunk.metadata) });
      }
      yield projected;
      continue;
    }
    if (chunk.type === EventType.MESSAGES_SNAPSHOT) {
      // Snapshots fan tool results out as AG-UI role:tool messages. Seed all
      // identities first, because a snapshot can arrive without prior events.
      const messages = structuredClone(chunk.messages);
      for (const message of messages) {
        if (message.role !== "assistant") {
          continue;
        }
        for (const call of message.toolCalls ?? []) {
          if (call.function.name === VISUAL_PREVIEW_TOOL_NAME) {
            previewCallIds.add(call.id);
          }
        }
      }
      for (const message of messages) {
        if (
          message.role !== "tool" ||
          !previewCallIds.has(message.toolCallId)
        ) {
          continue;
        }
        message.content =
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
        if (message.metadata !== undefined) {
          Object.assign(message, {
            metadata: historyMetadata(message.metadata),
          });
        }
      }
      yield { ...chunk, messages };
      continue;
    }
    yield chunk;
  }
};
