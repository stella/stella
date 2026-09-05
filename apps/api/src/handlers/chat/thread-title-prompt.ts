import type { ChatMessage } from "@/api/handlers/chat/types";
import type { TanStackTextFinishPolicy } from "@/api/lib/tanstack-ai-generate";

export const TITLE_MAX_LENGTH = 60;
export const TITLE_CONTEXT_MAX_LENGTH = 500;
export const TITLE_MAX_OUTPUT_TOKENS = 32;

// A title is a label, not content: `cleanGeneratedTitle` bounds it to
// TITLE_MAX_LENGTH anyway, and the 32-token ceiling above is what a verbose
// model spends before the run reports a `length` finish. A title cut at that
// ceiling still names the thread, so grading it as a failure would turn a
// wordy model into a 502 and leave the thread on its placeholder. A moderated,
// tool-bearing, or unfinished run stays a failure.
export const TITLE_FINISH_POLICY =
  "allow-output-ceiling" satisfies TanStackTextFinishPolicy;

export type TitleContextMessage = Pick<ChatMessage, "parts" | "role">;

export const extractTitleContext = (message: TitleContextMessage): string =>
  message.parts
    .map((part) => (part.type === "text" ? part.content : ""))
    .join(" ")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, TITLE_CONTEXT_MAX_LENGTH);

const TITLE_ROLE_LABELS = {
  assistant: "Assistant",
  system: "System",
  user: "User",
} as const satisfies Record<TitleContextMessage["role"], string>;

/**
 * One prompt for both titling paths: the fire-and-forget generator on thread
 * creation and the on-demand suggest endpoint. Shared so the two can never
 * drift in wording, context caps, or output cleanup.
 */
export const buildThreadTitlePrompt = (
  messages: readonly TitleContextMessage[],
): string => {
  const transcript = messages
    .map(
      (message) =>
        `${TITLE_ROLE_LABELS[message.role]}: ${extractTitleContext(message)}`,
    )
    .join("\n");

  return `Given this conversation, reply with a short thread title (max 6 words). Reply with the title only, nothing else.

${transcript}`;
};

const isWrappingQuote = (char: string): boolean => char === '"' || char === "'";

const trimWrappingQuotes = (value: string): string => {
  let start = 0;
  let end = value.length;

  while (start < end && isWrappingQuote(value.charAt(start))) {
    start += 1;
  }
  while (end > start && isWrappingQuote(value.charAt(end - 1))) {
    end -= 1;
  }

  return value.slice(start, end);
};

const stripTitlePrefix = (value: string): string => {
  const prefix = "title:";
  if (value.slice(0, prefix.length).toLowerCase() !== prefix) {
    return value;
  }

  return value.slice(prefix.length).trimStart();
};

const stripTitleWrapper = (value: string): string => {
  const unquoted = trimWrappingQuotes(value.trim()).trim();
  return trimWrappingQuotes(stripTitlePrefix(unquoted).trim()).trim();
};

export const cleanGeneratedTitle = (text: string): string =>
  stripTitleWrapper(text).slice(0, TITLE_MAX_LENGTH);
