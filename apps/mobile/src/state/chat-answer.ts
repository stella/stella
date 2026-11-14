// An assistant message as the thread draws it, built the same way from a
// stored message and from an answer still streaming, so the answer does not
// change shape when the stored copy replaces it. The steps the model took
// read as the web shows them (`@stll/api-contract/chat-tool-activity`):
// each run of steps between two texts is one summary of what it got done,
// opening onto each step's translated title, never a tool's internal name.
// A coding agent's subagent is a row of its own holding the steps it took
// (`@stll/api-contract/chat-local-run-steps`, which the web reads too).

import {
  isLocalRunInterruptedOutput,
  type LocalRunStepCall,
  localRunStepFailed,
  localRunStepOutputKind,
  type LocalRunStepStanding,
  localRunSubagentGroups,
  type LocalRunSubagentStatus,
  localRunSubagentStatus,
  localRunSubagentType,
  type LocalRunToolSubtitle,
  type LocalRunToolTitleKind,
  localRunToolView,
} from "@stll/api-contract/chat-local-run-steps";
import { chatLocalRunParentCallId } from "@stll/api-contract/chat-local-run-tool";
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

/**
 * A message part as an answer reads it: a tool call also by id and input,
 * and by its metadata, where a call of a coding agent's subagent names the
 * subagent's own step (`chatLocalRunParentCallId`).
 */
type AnswerPart = ChatActivityPart & {
  readonly id?: unknown;
  readonly input?: unknown;
  readonly metadata?: unknown;
};

type StepStatus = "running" | "done" | "failed";

/**
 * One step of a run: a tool call by its title, a step a coding agent took
 * on the person's computer by its kind and what it was about (a command, a
 * file's name, a search), or the model's reasoning.
 */
export type AnswerStep =
  | {
      readonly type: "tool";
      readonly label: ChatToolLabel;
      readonly status: StepStatus;
    }
  | {
      readonly type: "local";
      readonly label: ChatToolLabel;
      /** The kind the title names, or null to keep the tool's own title. */
      readonly titleKind: LocalRunToolTitleKind | null;
      readonly subtitle: LocalRunToolSubtitle | null;
      readonly status: StepStatus;
      /**
       * The step viewed an image, which stays on the computer that ran it:
       * stella desktop serves it there to a page on that computer only, so
       * the phone says where it opens instead of opening it.
       */
      readonly opensOnComputer: boolean;
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
    }
  | {
      /** A subagent a coding agent started, holding the steps it took. */
      readonly type: "subagent";
      /** The subagent's place in the message, stable while it streams. */
      readonly key: string;
      /** What it was started for, in the agent's few words. */
      readonly description: string | null;
      readonly agentType: string | null;
      readonly status: LocalRunSubagentStatus;
      /**
       * The subagent ended with a result, so what it was told, wrote and
       * reported is kept on the computer that ran it, which alone opens it.
       */
      readonly opensOnComputer: boolean;
      /** Every step it took, one that waits on an approval included. */
      readonly stepCount: number;
      /**
       * The steps that show inside. One that waits on an approval is not
       * among them: it stays in the answer's own steps, and the card under
       * the thread asks about it, so it is seen without opening this row.
       */
      readonly steps: readonly AnswerStep[];
    };

const toStep = (part: AnswerPart): AnswerStep => {
  if (part.type === "thinking") {
    return {
      type: "reasoning",
      text: typeof part.content === "string" ? part.content.trim() : "",
    };
  }
  const name = typeof part.name === "string" ? part.name : "";
  const label = chatToolLabel(name);
  const status = stepStatus(part);
  const local = localRunToolView({
    name,
    input: part.input,
    output: part.output,
  });
  return local === null
    ? { type: "tool", label, status }
    : {
        type: "local",
        label,
        status,
        ...local,
        opensOnComputer:
          status !== "running" &&
          localRunStepOutputKind({ name, input: part.input }) === "image",
      };
};

/** A call runs until it completes; it failed when it errored or said so. */
const stepStatus = (part: AnswerPart): StepStatus => {
  if (part.state === "error") {
    return "failed";
  }
  if (part.state !== "complete") {
    return "running";
  }
  return isFailedToolOutput(part.output) ||
    localRunStepFailed(
      typeof part.name === "string" ? part.name : "",
      part.output,
    )
    ? "failed"
    : "done";
};

/**
 * How a step stands for its subagent's one status. A call its turn cut off
 * ended with no result, or with the run's cancellation result: it reads as
 * stopped, not as the step failing.
 */
const stepStanding = (part: AnswerPart): LocalRunStepStanding => {
  if (part.state === "approval-requested") {
    return "awaiting_approval";
  }
  const status = stepStatus(part);
  if (status !== "failed") {
    return status;
  }
  return part.state === "error" &&
    (part.output === undefined || isLocalRunInterruptedOutput(part.output))
    ? "interrupted"
    : "failed";
};

/** A stretch of a run of steps: steps of the answer's own, or a subagent. */
type Stretch =
  | {
      readonly type: "run";
      readonly start: number;
      readonly items: AnswerPart[];
    }
  | {
      readonly type: "subagent";
      readonly id: string;
      readonly part: AnswerPart;
    };

/** A tool call the grouping can name: one with an id. */
type IdentifiedCall = { readonly id: string; readonly part: AnswerPart };

const identifiedCalls = (parts: readonly AnswerPart[]): IdentifiedCall[] =>
  parts.flatMap((part) =>
    part.type === "tool-call" && typeof part.id === "string" && isStep(part)
      ? [{ id: part.id, part }]
      : [],
  );

// The phone has no sources tray, so a finished search stays a step.
const isStep = (part: AnswerPart): boolean =>
  isVisibleProcessStep(part, { searchesShownApart: false });

/**
 * A message's parts as blocks: its texts, and between them each run of
 * steps. A run with nothing to show (only a finished web search, a result,
 * a skill that failed to load) draws nothing, as on the web; so do parts
 * that are neither text nor steps (files, and the cards a person answers).
 * A subagent's step is a block of its own, where the step stood, with the
 * steps it took inside, wherever in the answer they were taken.
 */
export const answerBlocks = (parts: readonly AnswerPart[]): AnswerBlock[] => {
  const blocks: AnswerBlock[] = [];
  // A text with nothing in it (a stream opens one before its first word)
  // must not split a run of steps.
  const drawn = parts.filter(
    (part) =>
      part.type !== "text" ||
      (typeof part.content === "string" && part.content.trim() !== ""),
  );
  const calls = identifiedCalls(drawn.filter(isProcessPart));
  const partOf = new Map(calls.map(({ id, part }) => [id, part]));
  const groups = localRunSubagentGroups(
    calls.map(({ id, part }): LocalRunStepCall => ({
      id,
      name: typeof part.name === "string" ? part.name : "",
      input: part.input,
      parentCallId: chatLocalRunParentCallId(part.metadata),
      // The card under the thread asks about a call that waits on the
      // person; every other call is a row.
      shownAs: part.state === "approval-requested" ? "card" : "row",
    })),
  );
  const subagentBlock = (id: string, own: AnswerPart): AnswerBlock => {
    const taken = (groups.stepsOf.get(id) ?? []).flatMap((step) => {
      const part = partOf.get(step);
      return part === undefined ? [] : [{ id: step, part }];
    });
    const call = {
      name: typeof own.name === "string" ? own.name : "",
      input: own.input,
    };
    const description = localRunToolView({
      ...call,
      output: undefined,
    })?.subtitle;
    const ownStanding = stepStanding(own);
    return {
      type: "subagent",
      key: `subagent:${id}`,
      description: description?.type === "text" ? description.text : null,
      agentType: localRunSubagentType(call),
      status: localRunSubagentStatus({
        own: ownStanding,
        steps: taken.map(({ part }) => stepStanding(part)),
      }),
      opensOnComputer:
        own.output !== undefined &&
        (ownStanding === "done" || ownStanding === "failed"),
      stepCount: taken.length,
      steps: taken
        .filter((step) => groups.rowIn.has(step.id))
        .map(({ part }) => toStep(part)),
    };
  };
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
    // The run's parts between its subagents, each stretch a run of its own.
    const stretches: Stretch[] = [];
    for (const [offset, part] of group.items.entries()) {
      const id = typeof part.id === "string" && isStep(part) ? part.id : null;
      if (id !== null && groups.rowIn.has(id)) {
        continue;
      }
      if (id !== null && groups.stepsOf.has(id)) {
        stretches.push({ type: "subagent", id, part });
        continue;
      }
      const last = stretches.at(-1);
      if (last?.type === "run") {
        last.items.push(part);
      } else {
        stretches.push({ type: "run", start: offset, items: [part] });
      }
    }
    for (const stretch of stretches) {
      if (stretch.type === "subagent") {
        blocks.push(subagentBlock(stretch.id, stretch.part));
        continue;
      }
      const steps = stretch.items.filter(isStep).map(toStep);
      if (steps.length > 0) {
        blocks.push({
          type: "steps",
          key: String(group.startIndex + stretch.start),
          steps,
          work: countProcessWork(stretch.items),
        });
      }
    }
  }
  return blocks;
};

/** A message's text parts joined, as copying it gives them. */
export const messageText = (parts: readonly AnswerPart[]): string =>
  parts
    .flatMap((part) =>
      part.type === "text" && typeof part.content === "string"
        ? [part.content.trim()]
        : [],
    )
    .filter((content) => content !== "")
    .join("\n\n");
