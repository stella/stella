import type { ContentPart, ModelMessage } from "@tanstack/ai";
import { panic, Result } from "better-result";

import { HarnessStartError } from "./adapter";

/**
 * Turning the portable stella transcript (the `ModelMessage`s a run starts
 * with) into the prompt that opens a harness session. A conversation may
 * change engine or harness between turns, so a session that cannot be
 * resumed starts from this text alone.
 *
 * Approach adapted from t3code (MIT): provider switches hand over a bounded
 * summary of the history instead of the native session.
 */

/** Whole-handoff budget; the newest history is kept, the oldest dropped. */
const HANDOFF_MAX_BYTES = 64 * 1024;
/** Per-message budget, so the newest message always fits. */
const MESSAGE_MAX_BYTES = 16 * 1024;
/** Per tool-call budget so one large call cannot crowd out the turns. */
const TOOL_MAX_BYTES = 2 * 1024;

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).byteLength;

const truncateBytes = (text: string, maxBytes: number): string => {
  if (byteLength(text) <= maxBytes) {
    return text;
  }
  const kept = new TextDecoder().decode(
    encoder.encode(text).slice(0, maxBytes),
  );
  // A cut inside a multi-byte character decodes to U+FFFD; drop it.
  let end = kept.length;
  while (end > 0 && kept[end - 1] === "\uFFFD") {
    end -= 1;
  }
  return `${kept.slice(0, end)} [truncated]`;
};

/** Attachments are named but not transferred; the prompt is text only. */
const contentPartText = (part: ContentPart): string => {
  switch (part.type) {
    case "text":
      return part.content;
    case "image":
    case "audio":
    case "video":
    case "document":
      return `[${part.type} attachment not carried over]`;
    default:
      part satisfies never;
      return panic("Unhandled content part in a harness transcript");
  }
};

const contentText = (content: ModelMessage["content"]): string => {
  if (content === null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content.map(contentPartText).join("\n");
};

/**
 * Text a message contributes to the handoff. Provider reasoning (`thinking`)
 * belongs to the session that produced it and is never handed to another
 * harness.
 */
const messageBlock = (message: ModelMessage): string | null => {
  const text = contentText(message.content).trim();
  switch (message.role) {
    case "user":
      return text === "" ? null : `User: ${text}`;
    case "assistant": {
      const calls = (message.toolCalls ?? []).map(
        ({ function: call }) =>
          `[tool ${call.name} ${truncateBytes(call.arguments, TOOL_MAX_BYTES)}]`,
      );
      const body = [text, ...calls].filter((line) => line !== "").join("\n");
      return body === "" ? null : `Assistant: ${body}`;
    }
    case "tool":
      return text === ""
        ? null
        : `[tool result ${truncateBytes(text, TOOL_MAX_BYTES)}]`;
    default:
      message.role satisfies never;
      return panic("Unhandled message role in a harness transcript");
  }
};

const renderHistory = (history: readonly ModelMessage[]): string | null => {
  const blocks: string[] = [];
  let used = 0;
  let omitted = false;
  for (const message of history.toReversed()) {
    const block = messageBlock(message);
    if (block === null) {
      continue;
    }
    const bounded = truncateBytes(block, MESSAGE_MAX_BYTES);
    const size = byteLength(bounded);
    if (used + size > HANDOFF_MAX_BYTES) {
      omitted = true;
      break;
    }
    used += size;
    blocks.push(bounded);
  }
  if (blocks.length === 0) {
    return null;
  }
  if (omitted) {
    blocks.push("[earlier messages omitted]");
  }
  return blocks.toReversed().join("\n\n");
};

/**
 * `resumed`: the native session already holds the history, so only the new
 * user message is sent. `standalone`: the history travels in the prompt.
 */
type TurnPromptMode = "resumed" | "standalone";

type BuildTurnPromptOptions = {
  transcript: readonly ModelMessage[];
  mode: TurnPromptMode;
};

export const buildTurnPrompt = ({
  transcript,
  mode,
}: BuildTurnPromptOptions): Result<string, HarnessStartError> => {
  const last = transcript.at(-1);
  const request = last?.role === "user" ? contentText(last.content).trim() : "";
  if (request === "") {
    return Result.err(
      new HarnessStartError({
        reason: "invalid_transcript",
        message:
          "A harness turn needs a transcript that ends with a user message with text.",
      }),
    );
  }
  if (mode === "resumed") {
    return Result.ok(request);
  }
  const history = renderHistory(transcript.slice(0, -1));
  if (history === null) {
    return Result.ok(request);
  }
  return Result.ok(
    `The conversation so far:\n\n${history}\n\nCurrent request:\n${request}`,
  );
};
