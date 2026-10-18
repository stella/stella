import * as v from "valibot";

import type { ChatUIMessage } from "@/components/chat/chat-ui-tools";
import { mapMarkdownSelection } from "@/components/chat/markdown-selection.logic";

import type { AnswerEditAnchor } from "./answer-edit-api";

export type AnswerSourceSelection = {
  source: string;
  start: number;
  end: number;
  partIndex: number;
  partOffset: number;
};

type AnswerSelectionOptions = {
  message: ChatUIMessage;
  baseRevision: number;
  messageRoot: Element;
  range: Range;
};

type AnswerSelectionEdit =
  | {
      status: "available";
      anchor: AnswerEditAnchor;
      selection: AnswerSourceSelection;
    }
  | { status: "unsupported" };

const textPartAttributes = v.object({
  textPartIndex: v.pipe(
    v.string(),
    v.regex(/^\d+$/u),
    v.transform(Number),
    v.safeInteger(),
  ),
});

const readTextPartIndex = (element: HTMLElement) => {
  const parsed = v.safeParse(textPartAttributes, element.dataset);
  return parsed.success ? parsed.output.textPartIndex : undefined;
};

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
  const partIndex = readTextPartIndex(partRoot);
  if (partIndex === undefined) {
    return { status: "unsupported" };
  }
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
    selection: {
      source: part.content,
      start: mapped.start,
      end: mapped.end,
      partIndex,
      partOffset: offset,
    },
    anchor: {
      messageId: message.id,
      baseRevision,
      start: offset + mapped.start,
      end: offset + mapped.end,
      selectedSource: part.content.slice(mapped.start, mapped.end),
    },
  };
};
