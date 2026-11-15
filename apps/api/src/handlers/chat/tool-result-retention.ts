import type { ModelMessage } from "@tanstack/ai";
import { Result } from "better-result";

import {
  type RetainableToolResult,
  supersededToolResults,
} from "@stll/api-contract/chat-tool-result-retention";

import type { ChatMessage, ChatPart } from "@/api/handlers/chat/types";
import { arrayOrEmpty } from "@/api/lib/array";

/**
 * Applies each tool's declared result retention
 * (`@stll/api-contract/chat-tool-result-retention`) at every seam a result
 * crosses: the model's view before each model call, the parts a message
 * stores, and the parts a stream snapshot carries. Each seam projects the same
 * results the same way, so what the model read, what the page showed live and
 * what a reload serves agree.
 */

const parseJsonContent = (content: unknown): unknown => {
  if (typeof content !== "string") {
    return undefined;
  }
  const parsed = Result.try((): unknown => JSON.parse(content));
  return Result.isError(parsed) ? undefined : parsed.value;
};

/**
 * The model's view: each superseded tool result message reads as its
 * projection. Returns the same array when nothing changed, so callers can
 * tell a projection from a no-op by reference.
 */
export const retainToolResultsForModel = (
  messages: ModelMessage[],
): ModelMessage[] => {
  const toolNames = new Map(
    messages.flatMap((message) =>
      message.role === "assistant"
        ? arrayOrEmpty(message.toolCalls).map(
            (call) => [call.id, call.function.name] as const,
          )
        : [],
    ),
  );
  const superseded = supersededToolResults(messages, (message) => {
    if (message.role !== "tool" || message.toolCallId === undefined) {
      return null;
    }
    const toolName = toolNames.get(message.toolCallId);
    return toolName === undefined
      ? null
      : { output: parseJsonContent(message.content), toolName };
  });
  if (superseded.size === 0) {
    return messages;
  }
  return messages.map((message) => {
    const projection = superseded.get(message);
    return projection === undefined
      ? message
      : { ...message, content: JSON.stringify(projection) };
  });
};

/** A call's output: on the call once it has one, else in its result part. */
const readCallResult = (
  part: ChatPart,
  results: ReadonlyMap<string, unknown>,
): RetainableToolResult | null =>
  part.type === "tool-call" &&
  (part.output !== undefined || results.has(part.id))
    ? {
        output: part.output === undefined ? results.get(part.id) : part.output,
        toolName: part.name,
      }
    : null;

/**
 * Projections for one ordered run of parts, keyed by tool call id. Each call
 * counts once, however many parts carry its output (the call's `output` and
 * its `tool-result`). A stream snapshot also carries each result as a `tool`
 * message beside the parts; it reads the same ids.
 */
export const supersededCallOutputs = (
  parts: readonly ChatPart[],
): ReadonlyMap<string, unknown> => {
  const results = new Map(
    parts.flatMap((part) =>
      part.type === "tool-result"
        ? [[part.toolCallId, parseJsonContent(part.content)] as const]
        : [],
    ),
  );
  const superseded = supersededToolResults(parts, (part) =>
    readCallResult(part, results),
  );
  return new Map(
    [...superseded].flatMap(([part, projection]) =>
      part.type === "tool-call" ? [[part.id, projection] as const] : [],
    ),
  );
};

// A call part's output type depends on its tool name; the projection is a
// declared variant of that output, so the call keeps its own part type.
const withOutput = <TPart extends { output?: unknown }>(
  part: TPart,
  output: unknown,
): TPart => ({ ...part, output });

/** `part` with the projection `projections` holds for its call, if any. */
export const projectSupersededPart = (
  part: ChatPart,
  projections: ReadonlyMap<string, unknown>,
): ChatPart => {
  if (part.type === "tool-call" && part.output !== undefined) {
    const projection = projections.get(part.id);
    return projection === undefined ? part : withOutput(part, projection);
  }
  if (part.type === "tool-result" && typeof part.content === "string") {
    const projection = projections.get(part.toolCallId);
    return projection === undefined
      ? part
      : { ...part, content: JSON.stringify(projection) };
  }
  return part;
};

/**
 * One message's parts with every superseded result projected, on the call
 * and on its result part alike. Returns the same array when nothing changed.
 * `onProjected` lets a caller carry a stored part's provenance to its
 * projection.
 */
export const retainToolResultsInParts = <T extends ChatPart>(
  parts: readonly T[],
  onProjected: (source: T, projected: ChatPart) => ChatPart = (
    _source,
    projected,
  ) => projected,
): readonly ChatPart[] => {
  const projections = supersededCallOutputs(parts);
  if (projections.size === 0) {
    return parts;
  }
  return parts.map((part) => {
    const projected = projectSupersededPart(part, projections);
    return projected === part ? part : onProjected(part, projected);
  });
};

/**
 * The same rule over a stored thread, for estimates of what the next send
 * gives the model (the context meter, the compaction trigger): each stored
 * part the model reads projected, mapped to its projection. Stored parts stay
 * as they are.
 */
export const supersededToolResultParts = (
  messages: readonly ChatMessage[],
): ReadonlyMap<ChatPart, ChatPart> => {
  const parts = messages.flatMap((message) => message.parts);
  const projections = supersededCallOutputs(parts);
  const projected = new Map<ChatPart, ChatPart>();
  if (projections.size === 0) {
    return projected;
  }
  for (const part of parts) {
    const replacement = projectSupersededPart(part, projections);
    if (replacement !== part) {
      projected.set(part, replacement);
    }
  }
  return projected;
};
