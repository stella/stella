import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  CHAT_LOCAL_RUN_STEER_TOOL,
  chatLocalRunSteerInputSchema,
} from "@stll/api-contract/chat-run-target";

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

const contentPartSchema = v.union([
  v.object({ type: v.literal("text"), content: v.string() }),
  v.object({ type: v.picklist(["image", "audio", "video", "document"]) }),
]);

const transcriptMessageSchema = v.object({
  role: v.picklist(["user", "assistant", "tool"]),
  content: v.nullable(v.union([v.string(), v.array(contentPartSchema)])),
  toolCalls: v.optional(
    v.array(
      v.object({
        id: v.optional(v.string()),
        function: v.object({ name: v.string(), arguments: v.string() }),
      }),
    ),
  ),
  /** On a tool message: the call it answers. */
  toolCallId: v.optional(v.string()),
});

/**
 * What a turn reads of each transcript message: a TanStack `ModelMessage`
 * satisfies it, and a transcript that arrives over a wire is checked against
 * it before a turn starts, so nothing the handoff reads is assumed.
 */
export const harnessTranscriptSchema = v.array(transcriptMessageSchema);
export type HarnessTranscriptMessage = v.InferOutput<
  typeof transcriptMessageSchema
>;
type ContentPart = v.InferOutput<typeof contentPartSchema>;
type MessageContent = HarnessTranscriptMessage["content"];

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
  // Streaming decode holds back a character the cut split, instead of
  // replacing it with U+FFFD; a U+FFFD already in the text is kept.
  const kept = new TextDecoder().decode(
    encoder.encode(text).subarray(0, maxBytes),
    { stream: true },
  );
  return `${kept} [truncated]`;
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

const contentText = (content: MessageContent): string => {
  if (content === null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content.map(contentPartText).join("\n");
};

/** Only what the user typed, without the attachment placeholders. */
const typedText = (content: MessageContent): string => {
  if (content === null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content
    .flatMap((part) => (part.type === "text" ? [part.content] : []))
    .join("\n");
};

type ToolCall = NonNullable<HarnessTranscriptMessage["toolCalls"]>[number];

const steerArgumentsSchema = v.pipe(
  v.string(),
  v.parseJson(),
  chatLocalRunSteerInputSchema,
);

/**
 * What the member wrote, when the call is a message they steered a running
 * turn with (`CHAT_LOCAL_RUN_STEER_TOOL`); `null` for any other call.
 */
const steeredText = ({ function: call }: ToolCall): string | null => {
  if (call.name !== CHAT_LOCAL_RUN_STEER_TOOL) {
    return null;
  }
  const parsed = v.safeParse(steerArgumentsSchema, call.arguments);
  return parsed.success ? parsed.output.text.trim() : null;
};

/**
 * Text a message contributes to the handoff, as one or more blocks.
 * Provider reasoning (`thinking`) belongs to the session that produced it and
 * is never handed to another harness. A message the member steered the turn
 * with is theirs, so it reads as a `User:` block where the turn took it,
 * between what the assistant had done by then and what it did after, not as
 * a call the assistant made.
 */
const messageBlocks = (
  message: HarnessTranscriptMessage,
  steerCallIds: ReadonlySet<string>,
): string[] => {
  const text = contentText(message.content).trim();
  switch (message.role) {
    case "user":
      return text === "" ? [] : [`User: ${text}`];
    case "assistant": {
      const blocks: string[] = [];
      let lines: string[] = text === "" ? [] : [text];
      const flush = () => {
        if (lines.length > 0) {
          blocks.push(`Assistant: ${lines.join("\n")}`);
          lines = [];
        }
      };
      for (const toolCall of message.toolCalls ?? []) {
        const said = steeredText(toolCall);
        if (said === null) {
          const { name, arguments: args } = toolCall.function;
          lines.push(`[tool ${name} ${truncateBytes(args, TOOL_MAX_BYTES)}]`);
        } else if (said !== "") {
          flush();
          blocks.push(`User: ${said}`);
        }
      }
      flush();
      return blocks;
    }
    case "tool":
      // A steered message's delivery receipt says nothing the block above
      // did not.
      if (
        message.toolCallId !== undefined &&
        steerCallIds.has(message.toolCallId)
      ) {
        return [];
      }
      return text === ""
        ? []
        : [`[tool result ${truncateBytes(text, TOOL_MAX_BYTES)}]`];
    default:
      message.role satisfies never;
      return panic("Unhandled message role in a harness transcript");
  }
};

/** The ids of every steered-message call in the history. */
const steerCallIdsOf = (
  history: readonly HarnessTranscriptMessage[],
): Set<string> =>
  new Set(
    history.flatMap((message) =>
      (message.toolCalls ?? []).flatMap((toolCall) =>
        toolCall.id !== undefined && steeredText(toolCall) !== null
          ? [toolCall.id]
          : [],
      ),
    ),
  );

const BLOCK_SEPARATOR = "\n\n";
const OMITTED_MARKER = "[earlier messages omitted]";

/** The history, newest kept first; the whole string fits the budget. */
const renderHistory = (
  history: readonly HarnessTranscriptMessage[],
): string | null => {
  const blocks: string[] = [];
  const separatorBytes = byteLength(BLOCK_SEPARATOR);
  // Reserved up front, so the marker fits whenever it is needed.
  const budget =
    HANDOFF_MAX_BYTES - byteLength(OMITTED_MARKER) - separatorBytes;
  let used = 0;
  let omitted = false;
  const steerCallIds = steerCallIdsOf(history);
  // Rendered newest first, so a long history stops rendering at the budget.
  for (const message of history.toReversed()) {
    if (omitted) {
      break;
    }
    for (const block of messageBlocks(message, steerCallIds).toReversed()) {
      const bounded = truncateBytes(block, MESSAGE_MAX_BYTES);
      const size =
        byteLength(bounded) + (blocks.length === 0 ? 0 : separatorBytes);
      if (used + size > budget) {
        omitted = true;
        break;
      }
      used += size;
      blocks.push(bounded);
    }
  }
  if (blocks.length === 0) {
    return null;
  }
  if (omitted) {
    blocks.push(OMITTED_MARKER);
  }
  return blocks.toReversed().join(BLOCK_SEPARATOR);
};

/**
 * `resumed`: the native session already holds the history, so only the new
 * user message is sent. `standalone`: the history travels in the prompt.
 */
type TurnPromptMode = "resumed" | "standalone";

type BuildTurnPromptOptions = {
  transcript: readonly HarnessTranscriptMessage[];
  mode: TurnPromptMode;
};

export const buildTurnPrompt = ({
  transcript,
  mode,
}: BuildTurnPromptOptions): Result<string, HarnessStartError> => {
  const last = transcript.at(-1);
  // Attachments are only named in the prompt, so they cannot be the request.
  if (last?.role !== "user" || typedText(last.content).trim() === "") {
    return Result.err(
      new HarnessStartError({
        reason: "invalid_transcript",
        message:
          "A harness turn needs a transcript that ends with a user message with text.",
      }),
    );
  }
  const request = contentText(last.content).trim();
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
