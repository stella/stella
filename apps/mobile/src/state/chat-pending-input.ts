import * as v from "valibot";

import {
  ASK_USER_TOOL_NAME,
  isHarnessChatToolCall,
} from "@stll/api-contract/chat";
import {
  type AskUserAnswer,
  askUserAnswersRefusal,
  askUserInputSchema,
  type AskUserQuestion,
} from "@stll/api-contract/chat-ask-user";
import {
  type ChatLocalRunQuestionReply,
  type LocalRunQuestionPause,
  localRunQuestionPauseOf,
} from "@stll/api-contract/chat-local-run-question";

/**
 * A tool call as the thread stores it. A continuation names each call it
 * answers by echoing the stored call, so every field the server keeps is
 * kept here as read, never rebuilt.
 */
const storedToolCallSchema = v.looseObject({
  type: v.literal("tool-call"),
  id: v.pipe(v.string(), v.minLength(1)),
  name: v.string(),
  state: v.string(),
  input: v.optional(v.unknown()),
  approval: v.optional(
    v.looseObject({
      id: v.pipe(v.string(), v.minLength(1)),
      needsApproval: v.boolean(),
      approved: v.optional(v.boolean()),
    }),
  ),
});

type StoredToolCall = v.InferOutput<typeof storedToolCallSchema>;

/**
 * A thread's local run target, as much of it as an answer names. The server
 * checks the target itself; the phone only passes back what the thread
 * stores, without the contract's runner protocol, which this app does not
 * load.
 */
const localRunTargetSchema = v.object({
  kind: v.literal("local"),
  harness: v.pipe(v.string(), v.minLength(1)),
  model: v.pipe(v.string(), v.minLength(1)),
  approvals: v.optional(v.string()),
  reasoningEffort: v.optional(v.nullable(v.string())),
});

export type LocalRunTarget = v.InferOutput<typeof localRunTargetSchema>;

/** One interrupt a paused turn waits on, as its resume snapshot stores it. */
const pendingInterruptSchema = v.looseObject({
  id: v.pipe(v.string(), v.minLength(1)),
  reason: v.string(),
  toolCallId: v.optional(v.string()),
  metadata: v.optional(v.record(v.string(), v.unknown())),
});

/**
 * What a stored assistant message says about a turn that waits for the
 * person: its outcome, and the snapshot the answer resumes (the run that
 * paused and the interrupts it paused on).
 */
const awaitingMetadataSchema = v.looseObject({
  turnOutcome: v.looseObject({ type: v.literal("awaiting-user") }),
  resumeSnapshot: v.looseObject({
    resumeState: v.looseObject({ runId: v.pipe(v.string(), v.minLength(1)) }),
    pendingInterrupts: v.array(pendingInterruptSchema),
  }),
});

const turnOutcomeSchema = v.looseObject({
  turnOutcome: v.looseObject({ type: v.string() }),
});

/** A tool call the turn waits for the person to allow or deny. */
export type PendingApproval = {
  readonly interruptId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly call: StoredToolCall;
};

/**
 * The model's clarifying questions (the `ask-user` tool), which the person
 * answers with an option or their own words. The browser resolves the call,
 * so its interrupt is the call's client-tool interrupt.
 */
export type PendingAsk = {
  readonly interruptId: string;
  readonly questions: readonly AskUserQuestion[];
  readonly call: StoredToolCall;
};

/**
 * Whose calls a paused turn holds: stella's own models (`cloud`), or a
 * coding agent on the person's computer (`harness`), whose answer the
 * server forwards to that computer and which a continuation must say runs
 * there.
 */
type PendingOwner =
  | { readonly type: "cloud" }
  | { readonly type: "harness"; readonly runTarget: LocalRunTarget };

type Resumable = {
  /** The paused assistant message the answer continues. */
  readonly messageId: string;
  /** The run that paused, which the answering run continues. */
  readonly parentRunId: string;
  readonly owner: PendingOwner;
};

/**
 * What a paused turn waits for: approvals of the calls it wants to run, the
 * model's clarifying questions, a question a coding agent on the person's
 * computer asked, or input this phone cannot give (a file, a browser action,
 * a saved secret), which the person gives in the web app.
 */
export type PendingInput =
  | (Resumable & {
      readonly type: "approvals";
      readonly approvals: readonly PendingApproval[];
    })
  | (Resumable & {
      readonly type: "ask-user";
      readonly asks: readonly PendingAsk[];
    })
  | (Resumable & {
      readonly type: "question";
      readonly pause: LocalRunQuestionPause;
      readonly call: StoredToolCall;
    })
  | { readonly type: "elsewhere" };

/** A stored message, as much of it as tells whether its turn waits. */
type StoredMessageView = {
  readonly id: string;
  readonly role: string;
  readonly metadata?: unknown;
  readonly parts: readonly unknown[];
};

const ELSEWHERE: PendingInput = { type: "elsewhere" };

/**
 * What the thread's latest message waits for, or null when its turn waits
 * for nothing. Read from what the server stores, so the same card shows
 * whether the turn paused while this phone streamed it or long before the
 * thread was opened. A turn this phone could only answer partly waits
 * `elsewhere`: the server takes an answer only to everything at once.
 */
export const pendingInputOf = ({
  message,
  runTarget,
}: {
  readonly message: StoredMessageView | undefined;
  /** The thread's run target as the server stores it. */
  readonly runTarget: unknown;
}): PendingInput | null => {
  if (message?.role !== "assistant") {
    return null;
  }
  const outcome = v.safeParse(turnOutcomeSchema, message.metadata);
  if (!outcome.success || outcome.output.turnOutcome.type !== "awaiting-user") {
    return null;
  }
  const awaiting = v.safeParse(awaitingMetadataSchema, message.metadata);
  if (!awaiting.success) {
    return ELSEWHERE;
  }
  const { pendingInterrupts, resumeState } = awaiting.output.resumeSnapshot;
  const calls = message.parts.flatMap((part) => {
    const call = v.safeParse(storedToolCallSchema, part);
    return call.success ? [call.output] : [];
  });

  const approvals: PendingApproval[] = [];
  const asks: PendingAsk[] = [];
  const questions: { pause: LocalRunQuestionPause; call: StoredToolCall }[] =
    [];
  for (const interrupt of pendingInterrupts) {
    const pause = localRunQuestionPauseOf([interrupt]);
    if (pause !== null) {
      const call = calls.find(
        ({ id, state }) =>
          id === interrupt.toolCallId && state === "input-complete",
      );
      if (call === undefined) {
        return ELSEWHERE;
      }
      questions.push({ pause, call });
      continue;
    }
    const ask = askOf(interrupt, calls);
    if (ask !== undefined) {
      asks.push(ask);
      continue;
    }
    const call = calls.find(
      ({ approval, state }) =>
        state === "approval-requested" && approval?.id === interrupt.id,
    );
    if (call === undefined) {
      // A client tool, a file or a secret: only the web app can answer it.
      return ELSEWHERE;
    }
    approvals.push({
      interruptId: interrupt.id,
      toolName: call.name,
      input: call.input,
      call,
    });
  }

  // Every call waiting for approval must be among the answers: the server
  // takes an answer to all of them at once.
  const unanswered = calls.some(
    ({ id, state }) =>
      state === "approval-requested" &&
      !approvals.some(({ call }) => call.id === id),
  );
  const answered = [
    ...approvals.map(({ call }) => call),
    ...asks.map(({ call }) => call),
    ...questions.map(({ call }) => call),
  ];
  const owner = ownerOf(answered, runTarget);
  const [question, ...moreQuestions] = questions;
  if (unanswered || owner === undefined || moreQuestions.length > 0) {
    return ELSEWHERE;
  }
  const resumable = {
    messageId: message.id,
    parentRunId: resumeState.runId,
    owner,
  };
  if (question !== undefined) {
    return approvals.length === 0 && asks.length === 0
      ? { ...resumable, type: "question", ...question }
      : ELSEWHERE;
  }
  if (asks.length > 0) {
    return approvals.length === 0
      ? { ...resumable, type: "ask-user", asks }
      : ELSEWHERE;
  }
  return approvals.length === 0
    ? ELSEWHERE
    : { ...resumable, type: "approvals", approvals };
};

/**
 * The model's questions an interrupt waits on: an `ask-user` call the
 * browser resolves, still waiting for its answer, whose questions parse. A
 * call whose questions do not parse could only be answered with something
 * the server refuses, so it is left to the web app.
 */
function askOf(
  interrupt: { readonly id: string; readonly toolCallId?: string | undefined },
  calls: readonly StoredToolCall[],
): PendingAsk | undefined {
  const call = calls.find(
    ({ id, name, state }) =>
      id === interrupt.toolCallId &&
      name === ASK_USER_TOOL_NAME &&
      state === "input-complete",
  );
  const input = v.safeParse(askUserInputSchema, call?.input);
  return call === undefined || !input.success
    ? undefined
    : { interruptId: interrupt.id, questions: input.output.questions, call };
}

/**
 * Who answers the calls: all stella's, or all the computer's, never a mix.
 * A computer's calls are answered through the thread's local run target,
 * so a thread without one cannot answer them from here.
 */
function ownerOf(
  calls: readonly StoredToolCall[],
  runTarget: unknown,
): PendingOwner | undefined {
  const harness = calls.filter((call) => isHarnessChatToolCall(call));
  if (harness.length === 0) {
    return { type: "cloud" };
  }
  if (harness.length !== calls.length) {
    return undefined;
  }
  const target = v.safeParse(localRunTargetSchema, runTarget);
  return target.success
    ? { type: "harness", runTarget: target.output }
    : undefined;
}

/**
 * The person's answer: each approval allowed or denied, by interrupt id, or
 * the question's answers, or `null` to dismiss it, which stops the agent's
 * turn.
 */
export type PendingAnswer =
  | {
      readonly type: "approvals";
      readonly allowed: Readonly<Record<string, boolean>>;
    }
  | {
      readonly type: "ask-user";
      /** Each ask's answers, by its interrupt id. */
      readonly answers: Readonly<Record<string, readonly AskUserAnswer[]>>;
    }
  | {
      readonly type: "question";
      readonly answers: ChatLocalRunQuestionReply["answers"] | null;
    };

type ResumeItem =
  | {
      readonly interruptId: string;
      readonly status: "resolved";
      readonly payload: unknown;
    }
  | { readonly interruptId: string; readonly status: "cancelled" };

/**
 * What a continuation carries for one answer: the paused message's answered
 * calls, each the stored call with only its answer changed, and the resume
 * item of each interrupt. An approval moves its call to
 * `approval-responded`; the model's questions move their call to `complete`
 * with the answers as its output, and add the result that answers it, as the
 * web does; a coding agent's question's call stays as stored, its answer
 * riding in the resume payload. Undefined when the answer does not answer
 * every interrupt.
 */
export const continuationOf = (
  pending: Exclude<PendingInput, { type: "elsewhere" }>,
  answer: PendingAnswer,
):
  | { readonly parts: readonly unknown[]; readonly resume: ResumeItem[] }
  | undefined => {
  if (pending.type === "question") {
    if (answer.type !== "question") {
      return undefined;
    }
    const { interruptId } = pending.pause;
    return {
      parts: [pending.call],
      resume: [
        answer.answers === null
          ? { interruptId, status: "cancelled" }
          : {
              interruptId,
              status: "resolved",
              payload: { answers: answer.answers },
            },
      ],
    };
  }
  if (pending.type === "ask-user") {
    return answer.type === "ask-user"
      ? askContinuationOf(pending.asks, answer.answers)
      : undefined;
  }
  if (answer.type !== "approvals") {
    return undefined;
  }
  const decided = pending.approvals.flatMap((approval) => {
    const approved = Object.hasOwn(answer.allowed, approval.interruptId)
      ? answer.allowed[approval.interruptId]
      : undefined;
    return approved === undefined || approval.call.approval === undefined
      ? []
      : [{ approval, approved, stored: approval.call.approval }];
  });
  if (decided.length !== pending.approvals.length) {
    return undefined;
  }
  return {
    parts: decided.map(({ approval, approved, stored }) => ({
      ...approval.call,
      state: "approval-responded",
      approval: { ...stored, approved },
    })),
    resume: decided.map(({ approval, approved }) => ({
      interruptId: approval.interruptId,
      status: "resolved",
      payload: { approved },
    })),
  };
};

/**
 * The answered `ask-user` calls and their results, or undefined unless every
 * ask has answers the server accepts.
 */
function askContinuationOf(
  asks: readonly PendingAsk[],
  answers: Readonly<Record<string, readonly AskUserAnswer[]>>,
):
  | { readonly parts: readonly unknown[]; readonly resume: ResumeItem[] }
  | undefined {
  const answered = asks.flatMap((ask) => {
    const given = Object.hasOwn(answers, ask.interruptId)
      ? answers[ask.interruptId]
      : undefined;
    return given === undefined ||
      askUserAnswersRefusal(ask.questions, given) !== null
      ? []
      : [{ ask, output: { answers: given } }];
  });
  if (answered.length !== asks.length) {
    return undefined;
  }
  return {
    parts: [
      ...answered.map(({ ask, output }) => ({
        ...ask.call,
        state: "complete",
        output,
      })),
      ...answered.map(({ ask, output }) => ({
        type: "tool-result",
        toolCallId: ask.call.id,
        content: JSON.stringify(output),
        state: "complete",
      })),
    ],
    resume: answered.map(({ ask, output }) => ({
      interruptId: ask.interruptId,
      status: "resolved",
      payload: output,
    })),
  };
}

/** Whether two reads name the same pause, so an answer to one still fits the other. */
export const isSamePendingInput = (
  left: PendingInput | null,
  right: PendingInput | null,
): boolean => {
  if (left === null || right === null || left.type !== right.type) {
    return left === right;
  }
  if (left.type === "elsewhere" || right.type === "elsewhere") {
    return true;
  }
  return (
    left.messageId === right.messageId && left.parentRunId === right.parentRunId
  );
};

/** What the thread's live turn says about the card, when one is on screen. */
type LiveTurnView = {
  /** Whether the turn's answer is still arriving. */
  readonly streaming: boolean;
  /** The paused message the turn continues, when it is the card's answer. */
  readonly continues: string | undefined;
};

/**
 * Whether the card for what the thread waits for is on screen. A turn
 * streaming its answer has nothing to ask yet, so the card waits for it to
 * end; the run an answer from this card started is the exception, and the
 * card stays (held while the answer is on its way), so an answer the
 * server refuses keeps what the person entered.
 */
export const showsPendingInput = (live: LiveTurnView | null): boolean =>
  live === null || !live.streaming || live.continues !== undefined;

/**
 * The identity a card keeps its entries under: the same pause read again
 * (after a refused answer, or a refresh) keeps them; a new pause starts
 * empty.
 */
export const pendingInputKey = (
  pending: Exclude<PendingInput, { type: "elsewhere" }>,
): string => {
  if (pending.type === "question") {
    return `question:${pending.pause.interruptId}`;
  }
  const interrupts =
    pending.type === "ask-user" ? pending.asks : pending.approvals;
  return `${pending.type}:${pending.parentRunId}:${interrupts
    .map(({ interruptId }) => interruptId)
    .join(",")}`;
};
