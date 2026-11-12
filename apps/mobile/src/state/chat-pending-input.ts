import * as v from "valibot";

import { BROWSER_CONTROL_TOOL_NAME } from "@stll/api-contract/browser-control";
import {
  ASK_USER_TOOL_NAME,
  CREATE_DOCUMENT_TOOL_NAME,
  isHarnessChatToolCall,
} from "@stll/api-contract/chat";
import {
  type AskUserAnswer,
  askUserAnswersRefusal,
  askUserInputSchema,
  type AskUserQuestion,
} from "@stll/api-contract/chat-ask-user";
import { CONNECT_CONNECTOR_TOOL_NAME } from "@stll/api-contract/chat-connector";
import {
  type CreateDocumentInput,
  createDocumentInputSchema,
} from "@stll/api-contract/chat-create-document";
import {
  type ChatLocalRunQuestionReply,
  type LocalRunQuestionPause,
  localRunQuestionPauseOf,
} from "@stll/api-contract/chat-local-run-question";
import {
  REQUEST_SECRET_TOOL_NAME,
  requiresPerCallChatApproval,
} from "@stll/api-contract/chat-secret";
import {
  isChatToolCoveredByGrantOn,
  isGrantableChatTool,
} from "@stll/api-contract/chat-tool-grants";

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
type PendingAsk = {
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
 * A draft the model wrote with `create-document`, which the client compiles
 * and answers with the compiler's report, as the web does. It asks the
 * person nothing; the phone compiles it when it answers the rest.
 */
export type PendingDocument = {
  readonly interruptId: string;
  readonly input: CreateDocumentInput;
  readonly call: StoredToolCall;
};

/**
 * Why only another place can give what a paused turn waits for: a browser
 * command the person allowed, which runs in the browser on their computer;
 * a key, or an app to connect, which the API takes only from a signed-in
 * browser (`API_OAUTH_ROUTES` keeps keys and connections away from a phone
 * token); or anything else this build cannot read.
 */
export type ElsewhereReason = "browser" | "secret" | "connector" | "other";

/**
 * What a paused turn waits for: the steps of one model turn (approvals of
 * the calls it wants to run, its clarifying questions, the drafts it wrote),
 * a question a coding agent on the person's computer asked, or input this
 * phone cannot give, and why.
 */
export type PendingInput =
  | (Resumable & {
      readonly type: "steps";
      readonly approvals: readonly PendingApproval[];
      readonly asks: readonly PendingAsk[];
      readonly documents: readonly PendingDocument[];
    })
  | (Resumable & {
      readonly type: "question";
      readonly pause: LocalRunQuestionPause;
      readonly call: StoredToolCall;
    })
  | { readonly type: "elsewhere"; readonly reason: ElsewhereReason };

/** A stored message, as much of it as tells whether its turn waits. */
type StoredMessageView = {
  readonly id: string;
  readonly role: string;
  readonly metadata?: unknown;
  readonly parts: readonly unknown[];
};

const elsewhere = (reason: ElsewhereReason): PendingInput => ({
  type: "elsewhere",
  reason,
});

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
    return elsewhere("other");
  }
  const { pendingInterrupts, resumeState } = awaiting.output.resumeSnapshot;
  const calls = message.parts.flatMap((part) => {
    const call = v.safeParse(storedToolCallSchema, part);
    return call.success ? [call.output] : [];
  });

  const approvals: PendingApproval[] = [];
  const asks: PendingAsk[] = [];
  const documents: PendingDocument[] = [];
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
        return elsewhere("other");
      }
      questions.push({ pause, call });
      continue;
    }
    const approved = calls.find(
      ({ approval, state }) =>
        state === "approval-requested" && approval?.id === interrupt.id,
    );
    if (approved !== undefined) {
      approvals.push({
        interruptId: interrupt.id,
        toolName: approved.name,
        input: approved.input,
        call: approved,
      });
      continue;
    }
    const step = clientStepOf(interrupt, calls);
    switch (step.type) {
      case "ask":
        asks.push(step.ask);
        continue;
      case "document":
        documents.push(step.document);
        continue;
      case "elsewhere":
        return elsewhere(step.reason);
    }
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
    ...documents.map(({ call }) => call),
    ...questions.map(({ call }) => call),
  ];
  const owner = ownerOf(answered, runTarget);
  const [question, ...moreQuestions] = questions;
  if (unanswered || owner === undefined || moreQuestions.length > 0) {
    return elsewhere("other");
  }
  const resumable = {
    messageId: message.id,
    parentRunId: resumeState.runId,
    owner,
  };
  const steps = approvals.length + asks.length + documents.length;
  if (question !== undefined) {
    return steps === 0
      ? { ...resumable, type: "question", ...question }
      : elsewhere("other");
  }
  return steps === 0
    ? elsewhere("other")
    : { ...resumable, type: "steps", approvals, asks, documents };
};

/** What a client-tool interrupt asks of the person, if the phone can give it. */
type ClientStep =
  | { readonly type: "ask"; readonly ask: PendingAsk }
  | { readonly type: "document"; readonly document: PendingDocument }
  | { readonly type: "elsewhere"; readonly reason: ElsewhereReason };

/** The tools whose call only a place other than the phone resolves, and why. */
const ELSEWHERE_TOOLS: Readonly<Record<string, ElsewhereReason>> = {
  [BROWSER_CONTROL_TOOL_NAME]: "browser",
  [REQUEST_SECRET_TOOL_NAME]: "secret",
  [CONNECT_CONNECTOR_TOOL_NAME]: "connector",
};

/**
 * The step a client-tool interrupt waits on: the model's questions or a
 * draft to compile, each a call still waiting for its result whose input
 * parses (one that does not could only be answered with something the
 * server refuses), or a tool only another place resolves.
 */
function clientStepOf(
  interrupt: { readonly id: string; readonly toolCallId?: string | undefined },
  calls: readonly StoredToolCall[],
): ClientStep {
  const call = calls.find(({ id }) => id === interrupt.toolCallId);
  const reason: ElsewhereReason =
    call !== undefined && Object.hasOwn(ELSEWHERE_TOOLS, call.name)
      ? (ELSEWHERE_TOOLS[call.name] ?? "other")
      : "other";
  if (call?.state !== "input-complete") {
    return { type: "elsewhere", reason };
  }
  if (call.name === ASK_USER_TOOL_NAME) {
    const input = v.safeParse(askUserInputSchema, call.input);
    return input.success
      ? {
          type: "ask",
          ask: {
            interruptId: interrupt.id,
            questions: input.output.questions,
            call,
          },
        }
      : { type: "elsewhere", reason };
  }
  if (call.name === CREATE_DOCUMENT_TOOL_NAME) {
    const input = v.safeParse(createDocumentInputSchema, call.input);
    return input.success
      ? {
          type: "document",
          document: { interruptId: interrupt.id, input: input.output, call },
        }
      : { type: "elsewhere", reason };
  }
  return { type: "elsewhere", reason };
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
 * The person's answer: to a turn's steps, each approval allowed or denied
 * and each set of the model's questions answered, by interrupt id, with
 * each draft's compiled result; or to a coding agent's question, its
 * answers, or `null` to dismiss it, which stops the agent's turn.
 */
export type PendingAnswer =
  | {
      readonly type: "steps";
      readonly allowed: Readonly<Record<string, boolean>>;
      readonly asked: Readonly<Record<string, readonly AskUserAnswer[]>>;
      readonly documents: Readonly<Record<string, unknown>>;
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

/** One answered call: the call as sent, its resume item, and any result it adds. */
type Settled = {
  readonly part: unknown;
  readonly resume: ResumeItem;
  readonly result?: unknown;
};

const given = <T>(
  answers: Readonly<Record<string, T>>,
  interruptId: string,
): T | undefined =>
  Object.hasOwn(answers, interruptId) ? answers[interruptId] : undefined;

/** A call the client resolved: complete with `output`, and the result that answers it. */
const resolvedByClient = (
  call: StoredToolCall,
  interruptId: string,
  output: unknown,
): Settled => ({
  part: { ...call, state: "complete", output },
  resume: { interruptId, status: "resolved", payload: output },
  result: {
    type: "tool-result",
    toolCallId: call.id,
    content: JSON.stringify(output),
    state: "complete",
  },
});

/**
 * What a continuation carries for one answer: the paused message's answered
 * calls, each the stored call with only its answer changed, then the
 * results the client adds, and the resume item of each interrupt, as the
 * web sends them. An approval moves its call to `approval-responded`; the
 * model's questions and a draft move their call to `complete` with the
 * answer as its output and add the result that answers it; a coding agent's
 * question's call stays as stored, its answer riding in the resume payload.
 * Undefined when the answer does not answer every interrupt.
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
  if (answer.type !== "steps") {
    return undefined;
  }
  const settled = [
    ...pending.approvals.map((approval): Settled | undefined => {
      const approved = given(answer.allowed, approval.interruptId);
      const stored = approval.call.approval;
      return approved === undefined || stored === undefined
        ? undefined
        : {
            part: {
              ...approval.call,
              state: "approval-responded",
              approval: { ...stored, approved },
            },
            resume: {
              interruptId: approval.interruptId,
              status: "resolved",
              payload: { approved },
            },
          };
    }),
    ...pending.asks.map((ask): Settled | undefined => {
      const answers = given(answer.asked, ask.interruptId);
      return answers === undefined ||
        askUserAnswersRefusal(ask.questions, answers) !== null
        ? undefined
        : resolvedByClient(ask.call, ask.interruptId, { answers });
    }),
    ...pending.documents.map((document): Settled | undefined => {
      const output = given(answer.documents, document.interruptId);
      return output === undefined
        ? undefined
        : resolvedByClient(document.call, document.interruptId, output);
    }),
  ];
  const complete = settled.flatMap((step) =>
    step === undefined ? [] : [step],
  );
  if (complete.length !== settled.length) {
    return undefined;
  }
  return {
    parts: [
      ...complete.map(({ part }) => part),
      ...complete.flatMap(({ result }) =>
        result === undefined ? [] : [result],
      ),
    ],
    resume: complete.map(({ resume }) => resume),
  };
};

/**
 * The approvals once a grant on `toolName` is stored: every other approval
 * of the step the grant covers is allowed too, as the web's cards answer
 * themselves once a grant covers them. A tool asked about on every call is
 * never covered, and an approval already answered keeps its answer.
 */
export const allowedWithGrant = (
  approvals: readonly PendingApproval[],
  allowed: Readonly<Record<string, boolean>>,
  toolName: string,
): Record<string, boolean> => ({
  ...Object.fromEntries(
    approvals.flatMap(({ interruptId, toolName: approvalTool }) =>
      grantableApproval(approvalTool) &&
      isChatToolCoveredByGrantOn(toolName, approvalTool)
        ? [[interruptId, true] as const]
        : [],
    ),
  ),
  // An approval already answered keeps its answer.
  ...allowed,
});

/**
 * Whether the person may allow `toolName` for the conversation or always,
 * as the web's approval card offers it: only a tool the grant policy lets a
 * stored grant cover.
 */
export const grantableApproval = (toolName: string): boolean =>
  isGrantableChatTool(toolName) && !requiresPerCallChatApproval(toolName);

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
): string =>
  pending.type === "question"
    ? `question:${pending.pause.interruptId}`
    : `steps:${pending.parentRunId}:${[
        ...pending.approvals,
        ...pending.asks,
        ...pending.documents,
      ]
        .map(({ interruptId }) => interruptId)
        .join(",")}`;
