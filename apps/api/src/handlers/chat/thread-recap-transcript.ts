import type { ChatMessage } from "@/api/handlers/chat/types";

export const RECAP_TRANSCRIPT_MAX_CHARS = 8000;

const RECAP_PRESERVED_FIRST_LINE_MAX_CHARS = 1000;
const RECAP_OMISSION_MARKER = "\n\n[...]\n\n";

export type RecapMessage = Pick<ChatMessage, "role" | "parts">;

const collapseWhitespace = (value: string): string => {
  const segments = value.trim().split(/\s/u);
  const words: string[] = [];
  for (const segment of segments) {
    if (segment) {
      words.push(segment);
    }
  }

  return words.join(" ");
};

const messageText = (message: RecapMessage): string => {
  const segments: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text" && part.text.trim()) {
      segments.push(part.text);
    }
  }
  return collapseWhitespace(segments.join("\n"));
};

const truncateLine = (line: string, maxChars: number): string => {
  if (line.length <= maxChars) {
    return line;
  }

  const suffix = " [...]";
  if (maxChars <= suffix.length) {
    return line.slice(0, maxChars);
  }

  return `${line.slice(0, maxChars - suffix.length).trimEnd()}${suffix}`;
};

const truncateLineStart = (line: string, maxChars: number): string => {
  if (line.length <= maxChars) {
    return line;
  }

  let prefix = "";
  if (line.startsWith("Assistant: ")) {
    prefix = "Assistant: ";
  } else if (line.startsWith("User: ")) {
    prefix = "User: ";
  }
  const marker = "[...] ";
  if (prefix && maxChars > prefix.length + marker.length) {
    const suffixLength = maxChars - prefix.length - marker.length;
    return `${prefix}${marker}${line.slice(line.length - suffixLength).trimStart()}`;
  }

  if (maxChars > marker.length) {
    const suffixLength = maxChars - marker.length;
    return `${marker}${line.slice(line.length - suffixLength).trimStart()}`;
  }

  return line.slice(line.length - maxChars);
};

const buildTailTranscript = (
  lines: readonly string[],
  maxChars: number,
): string => {
  const tailLines: string[] = [];
  let remaining = maxChars;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }

    const separatorLength = tailLines.length > 0 ? 2 : 0;
    if (line.length + separatorLength <= remaining) {
      tailLines.unshift(line);
      remaining -= line.length + separatorLength;
      continue;
    }

    const lineBudget = remaining - separatorLength;
    if (lineBudget > 0) {
      tailLines.unshift(truncateLineStart(line, lineBudget));
    }
    break;
  }

  return tailLines.join("\n\n");
};

/**
 * Flatten the transcript to plain `User:`/`Assistant:` lines, capped
 * to a char budget filled from the most recent end. When the budget
 * truncates the head, the original ask (first user line) is preserved
 * so the model can still tell what the thread set out to do, which is
 * what "what remains" is measured against.
 */
export const buildRecapTranscript = (
  messages: readonly RecapMessage[],
): string => {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    const text = messageText(message);
    if (!text) {
      continue;
    }
    lines.push(`${message.role === "user" ? "User" : "Assistant"}: ${text}`);
  }

  if (lines.length === 0) {
    return "";
  }

  const full = lines.join("\n\n");
  if (full.length <= RECAP_TRANSCRIPT_MAX_CHARS) {
    return full;
  }

  const firstUserLine = lines.find((line) => line.startsWith("User: "));
  const tailOnly = buildTailTranscript(lines, RECAP_TRANSCRIPT_MAX_CHARS);
  if (!firstUserLine || tailOnly.includes(firstUserLine)) {
    return tailOnly;
  }

  const firstLineBudget = Math.min(
    firstUserLine.length,
    RECAP_PRESERVED_FIRST_LINE_MAX_CHARS,
    RECAP_TRANSCRIPT_MAX_CHARS - RECAP_OMISSION_MARKER.length,
  );
  const preservedFirstLine = truncateLine(firstUserLine, firstLineBudget);
  const tailBudget =
    RECAP_TRANSCRIPT_MAX_CHARS -
    RECAP_OMISSION_MARKER.length -
    preservedFirstLine.length;
  const tail = buildTailTranscript(lines, tailBudget);
  return `${preservedFirstLine}${RECAP_OMISSION_MARKER}${tail}`;
};
