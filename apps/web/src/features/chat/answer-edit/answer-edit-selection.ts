import type { ChatUIMessage } from "@/components/chat/chat-ui-tools";
import { mapMarkdownSelection } from "@/components/chat/markdown-selection.logic";

import type { AnswerEditAnchor } from "./answer-edit-api";

type AnswerSelectionOptions = {
  message: ChatUIMessage;
  baseRevision: number;
  messageRoot: Element;
  range: Range;
};

type AnswerSelectionEdit =
  | { status: "available"; anchor: AnswerEditAnchor }
  | { status: "unsupported" };

export const mapAnswerSelection = ({
  message,
  baseRevision,
  messageRoot,
  range,
}: AnswerSelectionOptions): AnswerSelectionEdit => {
  if (!messageRoot.contains(range.endContainer)) {
    return { status: "unsupported" };
  }
  const startNode =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const partRoot = startNode?.closest("[data-text-part-index]");
  if (!(partRoot instanceof HTMLElement)) {
    return { status: "unsupported" };
  }
  const partIndex = Number(partRoot.dataset.textPartIndex);
  const part = message.parts.at(partIndex);
  if (part?.type !== "text") {
    return { status: "unsupported" };
  }
  const mapped = mapMarkdownSelection({
    range,
    root: partRoot,
    source: part.content,
  });
  if (mapped.status !== "mapped") {
    return { status: "unsupported" };
  }
  let offset = 0;
  for (const previous of message.parts.slice(0, partIndex)) {
    if (previous.type === "text") {
      offset += previous.content.length;
    }
  }
  return {
    status: "available",
    anchor: {
      messageId: message.id,
      baseRevision,
      start: offset + mapped.start,
      end: offset + mapped.end,
      selectedSource: part.content.slice(mapped.start, mapped.end),
    },
  };
};
