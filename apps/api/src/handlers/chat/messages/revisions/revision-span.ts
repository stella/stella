import { deepEquals } from "bun";

import type { ChatMessageAcceptedEdit } from "@stll/api-contract/chat-message-revisions";

import type { PersistedChatMessageContentV3 } from "@/api/handlers/chat/types";

type RevisionEditSpanOptions = {
  originalParts: PersistedChatMessageContentV3["data"];
  candidateParts: PersistedChatMessageContentV3["data"];
  edit: ChatMessageAcceptedEdit;
};

export const isRevisionEditSpanValid = ({
  originalParts,
  candidateParts,
  edit,
}: RevisionEditSpanOptions) => {
  if (
    edit.start < 0 ||
    edit.start >= edit.end ||
    originalParts.length !== candidateParts.length
  ) {
    return false;
  }
  let offset = 0;
  for (const [index, original] of originalParts.entries()) {
    const candidate = candidateParts.at(index);
    if (original.type !== "text") {
      if (!deepEquals(original, candidate)) {
        return false;
      }
      continue;
    }
    if (candidate?.type !== "text") {
      return false;
    }
    const start = Math.max(0, edit.start - offset);
    const end = Math.min(original.content.length, edit.end - offset);
    offset += original.content.length;
    if (start >= end) {
      if (!deepEquals(original, candidate)) {
        return false;
      }
      continue;
    }
    if (
      !deepEquals({ ...original, content: candidate.content }, candidate) ||
      candidate.content.length < start + original.content.length - end ||
      candidate.content.slice(0, start) !== original.content.slice(0, start) ||
      !candidate.content.endsWith(original.content.slice(end))
    ) {
      return false;
    }
  }
  return edit.end <= offset;
};
