// An assistant message as the thread draws it, built the same way from a
// stored message and from an answer still streaming, so the answer does not
// change shape when the stored copy replaces it. The steps the model took
// read as the web shows them (`@stll/api-contract/chat-tool-activity`):
// each run of steps between two texts is one summary of what it got done,
// opening onto each step's translated title, never a tool's internal name.

import {
  chatToolLabel,
  countProcessWork,
  groupProcessParts,
  isFailedToolOutput,
  isProcessPart,
  isVisibleProcessStep,
} from "@stll/api-contract/chat-tool-activity";
import type {
  ChatActivityPart,
  ChatToolLabel,
  ProcessSummaryKind,
} from "@stll/api-contract/chat-tool-activity";

/** One step of a run: a tool call by its title, or the model's reasoning. */
export type AnswerStep =
  | {
      readonly type: "tool";
      readonly label: ChatToolLabel;
      readonly status: "running" | "done" | "failed";
    }
  | { readonly type: "reasoning"; readonly text: string };

/** A piece of an answer, in the order it was written. */
export type AnswerBlock =
  | {
      readonly type: "text";
      /** The block's place in the message, stable while it streams. */
      readonly key: string;
      readonly markdown: string;
    }
  | {
      readonly type: "steps";
      /** The run's place in the message, stable while it streams. */
      readonly key: string;
      readonly steps: readonly AnswerStep[];
      /** What the run got done, by kind, for its settled summary. */
      readonly work: ReadonlyMap<ProcessSummaryKind, number>;
    };

const toStep = (part: ChatActivityPart): AnswerStep => {
  if (part.type === "thinking") {
    return {
      type: "reasoning",
      text: typeof part.content === "string" ? part.content.trim() : "",
    };
  }
  return {
    type: "tool",
    label: chatToolLabel(typeof part.name === "string" ? part.name : ""),
    status: stepStatus(part),
  };
};

/** A call runs until it completes; it failed when it errored or said so. */
const stepStatus = (part: ChatActivityPart): "running" | "done" | "failed" => {
  if (part.state === "error") {
    return "failed";
  }
  if (part.state !== "complete") {
    return "running";
  }
  return isFailedToolOutput(part.output) ? "failed" : "done";
};

/**
 * A message's parts as blocks: its texts, and between them each run of
 * steps. A run with nothing to show (only a finished web search, a result,
 * a skill that failed to load) draws nothing, as on the web; so do parts
 * that are neither text nor steps (files, and the cards a person answers).
 */
export const answerBlocks = (
  parts: readonly ChatActivityPart[],
): AnswerBlock[] => {
  const blocks: AnswerBlock[] = [];
  // A text with nothing in it (a stream opens one before its first word)
  // must not split a run of steps.
  const drawn = parts.filter(
    (part) =>
      part.type !== "text" ||
      (typeof part.content === "string" && part.content.trim() !== ""),
  );
  for (const group of groupProcessParts(drawn, isProcessPart)) {
    if (group.kind === "standard") {
      const { item } = group;
      const text =
        item.type === "text" && typeof item.content === "string"
          ? item.content.trim()
          : "";
      if (text === "") {
        continue;
      }
      const previous = blocks.at(-1);
      if (previous?.type === "text") {
        blocks[blocks.length - 1] = {
          ...previous,
          markdown: `${previous.markdown}\n\n${text}`,
        };
      } else {
        blocks.push({ type: "text", key: String(group.index), markdown: text });
      }
      continue;
    }
    const steps = group.items.filter(isVisibleProcessStep).map(toStep);
    if (steps.length > 0) {
      blocks.push({
        type: "steps",
        key: String(group.startIndex),
        steps,
        work: countProcessWork(group.items),
      });
    }
  }
  return blocks;
};

/** A message's text parts joined, as copying it gives them. */
export const messageText = (parts: readonly ChatActivityPart[]): string =>
  parts
    .flatMap((part) =>
      part.type === "text" && typeof part.content === "string"
        ? [part.content.trim()]
        : [],
    )
    .filter((content) => content !== "")
    .join("\n\n");
