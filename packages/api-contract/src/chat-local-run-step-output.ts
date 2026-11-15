import { Result } from "better-result";
import * as v from "valibot";

/**
 * What a coding agent's step produced on the member's computer (a command's
 * output, a change's diff, a subagent's own conversation, an image it
 * viewed), as the computer cuts and names it: the step's chat call id, which
 * names its run, the caps a step's content is kept under, which bytes make an
 * image, and how a subagent's conversation is written. The computer sends it
 * to stella, which stores it beside the call (`chat-local-run-step-content`).
 */

/**
 * A harness mints call ids unique only within its own run, so chat keeps
 * every call of a local run under an id that starts with the run: stable
 * across the turn's pause and resume, and unique across the thread.
 */
export const CHAT_LOCAL_RUN_CALL_ID_MAX_LENGTH = 256;

const RUN_OF_CALL = /^([0-9a-f]{32})_./u;

/**
 * The chat call id of a harness call in run `runId`. An id too long for the
 * budget keeps its identity as `digest` (SHA-256 hex) of the harness id, so
 * two long ids never collapse into one call.
 */
export const chatLocalRunCallId = (
  runId: string,
  toolCallId: string,
  digest: (text: string) => string,
): string => {
  const run = runId.replaceAll("-", "");
  const prefixed = `${run}_${toolCallId}`;
  return prefixed.length <= CHAT_LOCAL_RUN_CALL_ID_MAX_LENGTH
    ? prefixed
    : `${run}_${digest(toolCallId)}`;
};

/** The run a local run's chat call id names, or `null` for any other id. */
export const chatLocalRunOfCall = (callId: string): string | null => {
  const run = RUN_OF_CALL.exec(callId)?.[1];
  if (run === undefined) {
    return null;
  }
  return [
    run.slice(0, 8),
    run.slice(8, 12),
    run.slice(12, 16),
    run.slice(16, 20),
    run.slice(20),
  ].join("-");
};

/**
 * The most of one step's output the computer keeps, in bytes, by what the
 * output is. Past it, the rest of a text (a command's output, a diff, a
 * subagent's conversation) is left out and the step says how much there
 * was; an image past it is not kept at all, since part of one shows
 * nothing, and its cap is the larger so that an ordinary screenshot is kept.
 */
export const CHAT_LOCAL_RUN_STEP_MAX_BYTES = {
  text: 1024 * 1024,
  image: 10 * 1024 * 1024,
} as const;
export type ChatLocalRunStepKind = keyof typeof CHAT_LOCAL_RUN_STEP_MAX_BYTES;

/**
 * The kinds of image a viewed image is kept and shown as. A vector image is
 * not among them: it can carry script.
 */
export const CHAT_LOCAL_RUN_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;
export type ChatLocalRunImageType = (typeof CHAT_LOCAL_RUN_IMAGE_TYPES)[number];

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0) =>
  bytes.length >= at + signature.length &&
  signature.every((byte, index) => bytes[at + index] === byte);

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG = [0xff, 0xd8, 0xff] as const;
const GIF = [0x47, 0x49, 0x46, 0x38] as const;
const RIFF = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP = [0x57, 0x45, 0x42, 0x50] as const;
/** Where a RIFF file names what it holds. */
const RIFF_FORM_OFFSET = 8;

/**
 * The kind of image `bytes` begin as, read from the bytes themselves, never
 * from a file's name; `null` for anything else. The computer keeps an image
 * only when this names one, and a page shows what it read only as the kind
 * this names, so a file merely called an image is never shown as one.
 */
export const chatLocalRunImageType = (
  bytes: Uint8Array,
): ChatLocalRunImageType | null => {
  if (startsWith(bytes, PNG)) {
    return "image/png";
  }
  if (startsWith(bytes, JPEG)) {
    return "image/jpeg";
  }
  if (startsWith(bytes, GIF)) {
    return "image/gif";
  }
  return startsWith(bytes, RIFF) && startsWith(bytes, WEBP, RIFF_FORM_OFFSET)
    ? "image/webp"
    : null;
};

/**
 * Who wrote a piece of a subagent's conversation: `prompt` is what the
 * agent told it, `message` what it wrote while it worked, `report` what it
 * returned at the end.
 */
export const CHAT_LOCAL_RUN_CONVERSATION_ROLES = [
  "prompt",
  "message",
  "report",
] as const;

const conversationEntrySchema = v.object({
  role: v.picklist(CHAT_LOCAL_RUN_CONVERSATION_ROLES),
  text: v.string(),
});
export type ChatLocalRunConversationEntry = v.InferOutput<
  typeof conversationEntrySchema
>;

/**
 * A subagent's conversation as the computer keeps it: one line of JSON per
 * entry, so the kept text may end anywhere (the cap cuts it) and every
 * whole line before the cut still reads.
 */
export const chatLocalRunConversationText = (
  entries: readonly ChatLocalRunConversationEntry[],
): string =>
  entries
    .map(({ role, text }) => `${JSON.stringify({ role, text })}\n`)
    .join("");

/**
 * The entries of a kept conversation. A line that is not an entry (the one
 * the cap cut, or anything else a file holds) is left out, never shown.
 */
export const parseChatLocalRunConversation = (
  text: string,
): ChatLocalRunConversationEntry[] =>
  text.split("\n").flatMap((line) => {
    if (line === "") {
      return [];
    }
    const json = Result.try((): unknown => JSON.parse(line));
    const entry = v.safeParse(
      conversationEntrySchema,
      json.isOk() ? json.value : null,
    );
    return entry.success ? [entry.output] : [];
  });
