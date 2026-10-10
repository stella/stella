import { panic } from "better-result";

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
    const delimiter = readFenceDelimiter(candidate);
    if (!delimiter) {
      if (fence === null) {
        inlineLines.push(candidate);
      }
      continue;
    }
    if (fence === null) {
      fence = { marker: delimiter.marker, length: delimiter.length };
      continue;
    }
    if (
      delimiter.marker === fence.marker &&
      delimiter.length >= fence.length &&
      delimiter.tail.trim() === ""
    ) {
      fence = null;
    }
  }
  if (fence !== null) {
    return false;
  }
  const prose = inlineProseWithoutCode(inlineLines.join("\n"));
  if (prose === null) {
    return false;
  }
  const delimiters = prose
    .replace(/^[ \t]*(?:[-+*]|\d+[.)]) /gmu, "")
    .replace(/(?<=[\p{L}\p{N}])_(?=[\p{L}\p{N}])/gu, "");
  const openDelimiters = new Set<string>();
  for (const match of delimiters.matchAll(/\*+|_+|~~/gu)) {
    const delimiter = match[0];
    if (openDelimiters.has(delimiter)) {
      openDelimiters.delete(delimiter);
    } else {
      openDelimiters.add(delimiter);
    }
  }
  return openDelimiters.size === 0 && hasClosedLinkDestinations(prose);
};

const readFenceDelimiter = (line: string) => {
  let start = 0;
  while (start < 4 && line.charAt(start) === " ") {
    start += 1;
  }
  if (start > 3) {
    return null;
  }
  const marker = line.charAt(start);
  if (marker !== "`" && marker !== "~") {
    return null;
  }
  let end = start + 1;
  while (line.charAt(end) === marker) {
    end += 1;
  }
  const length = end - start;
  return length < 3 ? null : { marker, length, tail: line.slice(end) };
};

// Each backtick run is consumed once. Runs of a different length inside a
// code span are literal code; only the opening length can close that span.
const inlineProseWithoutCode = (inline: string) => {
  const unescaped = inline.replace(/\\./gu, "");
  const prose: string[] = [];
  let cursor = 0;
  let codeStart = 0;
  let codeLength: number | null = null;
  for (const match of unescaped.matchAll(/`+/gu)) {
    const length = match[0].length;
    if (codeLength === null) {
      codeStart = match.index;
      codeLength = length;
      continue;
    }
    if (length !== codeLength) {
      continue;
    }
    prose.push(unescaped.slice(cursor, codeStart), " ");
    cursor = match.index + length;
    codeLength = null;
  }
  if (codeLength !== null) {
    return null;
  }
  prose.push(unescaped.slice(cursor));
  return prose.join("");
};

// CommonMark treats ordinary unmatched punctuation as literal prose. Track
// destinations only after a closed link label, including nested parentheses.
const hasClosedLinkDestinations = (prose: string) => {
  let labelDepth = 0;
  let destinationDepth = 0;
  let region: "bare" | "angle" | "single-quoted-title" | "double-quoted-title" =
    "bare";
  for (let index = 0; index < prose.length; index += 1) {
    const character = prose[index];
    if (destinationDepth > 0) {
      switch (region) {
        case "angle":
          if (character === ">") {
            region = "bare";
          }
          continue;
        case "single-quoted-title":
          if (character === "'") {
            region = "bare";
          }
          continue;
        case "double-quoted-title":
          if (character === '"') {
            region = "bare";
          }
          continue;
        case "bare":
          break;
        default:
          region satisfies never;
          return panic("Unhandled Markdown link destination region");
      }
      const previous = prose.charAt(index - 1);
      const followsWhitespace = /\s/u.test(previous);
      if (destinationDepth === 1) {
        if (character === "<" && (previous === "(" || followsWhitespace)) {
          region = "angle";
          continue;
        }
        if (followsWhitespace && character === "'") {
          region = "single-quoted-title";
          continue;
        }
        if (followsWhitespace && character === '"') {
          region = "double-quoted-title";
          continue;
        }
      }
      if (character === "(") {
        destinationDepth += 1;
      } else if (character === ")") {
        destinationDepth -= 1;
      }
      continue;
    }
    if (character === "[") {
      labelDepth += 1;
      continue;
    }
    if (character !== "]" || labelDepth === 0) {
      continue;
    }
    labelDepth -= 1;
    if (prose[index + 1] === "(") {
      destinationDepth = 1;
      region = "bare";
      index += 1;
    }
  }
  return destinationDepth === 0;
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
