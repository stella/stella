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
  return preservesMarkdownOutsideSpan({ source, start, end, replacement });
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
