import { sha256Hex } from "@stll/sha256/bun";

import { preservesMarkdownOutsideSpan } from "@/api/handlers/chat/messages/revisions/span-markdown";
import type { PersistedChatMessageContentV3 } from "@/api/handlers/chat/types";

const MAX_SPAN_REPLACEMENT_LENGTH = 32_000;

type FindAnchoredSpanOptions = {
  content: PersistedChatMessageContentV3;
  start: number;
  end: number;
  selectedTextHash: string;
};

export const findAnchoredSpan = ({
  content,
  start,
  end,
  selectedTextHash,
}: FindAnchoredSpanOptions) => {
  if (start < 0 || start >= end) {
    return null;
  }
  let offset = 0;
  for (const [partIndex, part] of content.data.entries()) {
    if (part.type !== "text") {
      continue;
    }
    const localStart = start - offset;
    const localEnd = end - offset;
    offset += part.content.length;
    if (localStart < 0 || localEnd > part.content.length) {
      continue;
    }
    const selected = part.content.slice(localStart, localEnd);
    if (sha256Hex(selected) !== selectedTextHash) {
      return null;
    }
    return {
      partIndex,
      source: part.content,
      start: localStart,
      end: localEnd,
      selected,
    };
  }
  return null;
};

// A partial-line edit must not introduce block or table boundaries. Fence
// delimiters in a complete-block replacement must close with the same marker.
export const isSpanReplacementBalanced = ({
  source,
  start,
  end,
  replacement,
}: {
  source: string;
  start: number;
  end: number;
  replacement: string;
}) => {
  if (replacement.length > MAX_SPAN_REPLACEMENT_LENGTH) {
    return false;
  }
  const wholeLines =
    (start === 0 || source[start - 1] === "\n") &&
    (end === source.length || source[end] === "\n");
  if (!wholeLines && /[\r\n]/u.test(replacement)) {
    return false;
  }
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const followingNewline = source.indexOf("\n", end);
  const line = source.slice(
    lineStart,
    followingNewline === -1 ? source.length : followingNewline,
  );
  if (!wholeLines && line.includes("|") && replacement.includes("|")) {
    return false;
  }
  return (
    isReplacementMarkdownBalanced(replacement) &&
    preservesMarkdownOutsideSpan({ source, start, end, replacement })
  );
};

const isReplacementMarkdownBalanced = (replacement: string) => {
  let fence: { marker: string; length: number } | null = null;
  const inlineLines: string[] = [];
  for (const candidate of replacement.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(candidate);
    if (!match) {
      if (fence === null) {
        inlineLines.push(candidate);
      }
      continue;
    }
    const marker = match.at(1);
    if (!marker) {
      return false;
    }
    if (fence === null) {
      fence = { marker: marker.charAt(0), length: marker.length };
      continue;
    }
    if (
      marker.charAt(0) === fence.marker &&
      marker.length >= fence.length &&
      match.at(2)?.trim() === ""
    ) {
      fence = null;
    }
  }
  if (fence !== null) {
    return false;
  }
  // Inline code delimiters must pair; escaped delimiters are literal text.
  const inline = inlineLines.join("\n").replace(/\\./gu, "");
  const runs = inline.match(/`+/gu) ?? [];
  const openRuns = new Set<number>();
  for (const run of runs) {
    if (openRuns.has(run.length)) {
      openRuns.delete(run.length);
    } else {
      openRuns.add(run.length);
    }
  }
  if (openRuns.size > 0) {
    return false;
  }
  const prose = inline
    .replace(/(`+)[\s\S]*?\1/gu, "")
    .replace(/^[ \t]*(?:[-+*]|\d+[.)]) /gmu, "");
  const delimiters =
    prose
      .replace(/(?<=[\p{L}\p{N}])_(?=[\p{L}\p{N}])/gu, "")
      .match(/\*+|_+|~~/gu) ?? [];
  const openDelimiters = new Set<string>();
  for (const delimiter of delimiters) {
    if (openDelimiters.has(delimiter)) {
      openDelimiters.delete(delimiter);
    } else {
      openDelimiters.add(delimiter);
    }
  }
  if (openDelimiters.size > 0) {
    return false;
  }
  // CommonMark treats ordinary unmatched punctuation as literal prose. Only
  // an actual link opener is required to carry a closed destination.
  return !/\[[^\]]*\]\([^)]*$/u.test(prose);
};

export const spliceSpanProposal = ({
  content,
  anchor,
  replacement,
}: {
  content: PersistedChatMessageContentV3;
  anchor: NonNullable<ReturnType<typeof findAnchoredSpan>>;
  replacement: string;
}) => ({
  version: 3 as const,
  data: content.data.map((part, index) =>
    part.type === "text" && index === anchor.partIndex
      ? {
          ...part,
          content:
            anchor.source.slice(0, anchor.start) +
            replacement +
            anchor.source.slice(anchor.end),
        }
      : part,
  ),
  ...(content.metadata === undefined ? {} : { metadata: content.metadata }),
});
