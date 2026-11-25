import * as v from "valibot";

import {
  chatLocalRunQuestionReplySchema,
  chatLocalRunQuestionsSchema,
  type LocalRunQuestionPause,
} from "./chat-local-run-question";
import { DESKTOP_RUNNER_APPROVAL_DECISIONS } from "./desktop-runner-answers";

// A leaf beside `chat-local-run-question`: the phone reads a run's requests
// without loading the runner protocol.

/**
 * What a run on the member's computer asks them, beside its running turn:
 * an approval of one step, or a blocking question. A request is its own
 * entity, never the turn's status. The harness may go on while it waits
 * (other steps, its final answer), so the turn reads `running` and the card
 * reads the request:
 *
 * - `pending`: waiting on the member. Only a pending request takes an answer
 *   (`isChatLocalRunRequestAnswerable`); every one is closed by the time its
 *   run ends, so a pending request always belongs to a live run.
 * - `resolved`: the member's answer reached the run.
 * - `expired`: the run no longer waits for it (`CHAT_LOCAL_RUN_REQUEST_EXPIRY`
 *   says why). The run's output stays as it is; the card turns neutral.
 * - `cancelled`: the member stopped the run's turn (a Stop, or dismissing
 *   the question) before answering it.
 *
 * The run's computer closes every open request when the run ends, whichever
 * way; the API closes what a run it gave up on left open.
 */
export const CHAT_LOCAL_RUN_REQUEST_STATUSES = [
  "pending",
  "resolved",
  "expired",
  "cancelled",
] as const;
export type ChatLocalRunRequestStatus =
  (typeof CHAT_LOCAL_RUN_REQUEST_STATUSES)[number];

/**
 * Why a request expired: the agent finished or failed without it, the
 * harness withdrew it while the turn went on, or the run was lost (its
 * computer never came back, or the turn ended on the API's side first).
 */
export const CHAT_LOCAL_RUN_REQUEST_EXPIRY = [
  "run_finished",
  "run_failed",
  "withdrawn",
  "run_lost",
] as const;
export type ChatLocalRunRequestExpiry =
  (typeof CHAT_LOCAL_RUN_REQUEST_EXPIRY)[number];

const requestIdSchema = v.pipe(v.string(), v.uuid());
const shownTextSchema = v.pipe(v.string(), v.maxLength(4000));

/** What an approval asks, as the card shows it. */
const approvalAskSchema = v.object({
  kind: v.literal("approval"),
  /** One line saying what the step does. */
  message: shownTextSchema,
  /** The harness's own reason, when it gave one. */
  reason: v.nullable(shownTextSchema),
  /** The step's tool, when the run opened its call. */
  toolName: v.nullable(v.pipe(v.string(), v.maxLength(256))),
  /** What chat keeps of the step's input. */
  input: v.unknown(),
  approvalKind: v.nullable(v.pipe(v.string(), v.maxLength(64))),
  /** The answers the harness accepts. */
  decisions: v.array(v.picklist(DESKTOP_RUNNER_APPROVAL_DECISIONS)),
});

const questionAskSchema = v.object({
  kind: v.literal("question"),
  questions: chatLocalRunQuestionsSchema,
});

export const chatLocalRunRequestAskSchema = v.variant("kind", [
  approvalAskSchema,
  questionAskSchema,
]);
export type ChatLocalRunRequestAsk = v.InferOutput<
  typeof chatLocalRunRequestAskSchema
>;

const requestFields = {
  requestId: requestIdSchema,
  /** The chat call the request is about: the step, or the question's call. */
  toolCallId: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  ask: chatLocalRunRequestAskSchema,
};

/** The decision the member's answer to an approval gave, once the run took it. */
const resolvedDecision = {
  decision: v.optional(v.picklist(DESKTOP_RUNNER_APPROVAL_DECISIONS)),
};

export const chatLocalRunRequestSchema = v.variant("status", [
  v.object({ ...requestFields, status: v.literal("pending") }),
  v.object({
    ...requestFields,
    status: v.literal("resolved"),
    ...resolvedDecision,
  }),
  v.object({
    ...requestFields,
    status: v.literal("expired"),
    expiry: v.picklist(CHAT_LOCAL_RUN_REQUEST_EXPIRY),
  }),
  v.object({ ...requestFields, status: v.literal("cancelled") }),
]);
export type ChatLocalRunRequest = v.InferOutput<
  typeof chatLocalRunRequestSchema
>;

/** Whether an answer to `request` can still reach its run. */
export const isChatLocalRunRequestAnswerable = (
  request: ChatLocalRunRequest,
): boolean => request.status === "pending";

/** Most requests one answer names; a run asks one at a time, mostly. */
export const CHAT_LOCAL_RUN_MAX_REQUESTS = 50;

/**
 * Message metadata: every request the answer's run asked, in the order it
 * asked them, each in its latest state. The stream restates the whole list
 * on each change (a stream processor merges metadata key by key) and the
 * stored answer keeps it, so a live answer and a reloaded one read the same.
 */
export const CHAT_LOCAL_RUN_REQUESTS_METADATA_KEY = "localRunRequests";

export const chatLocalRunRequestsSchema = v.pipe(
  v.array(chatLocalRunRequestSchema),
  v.maxLength(CHAT_LOCAL_RUN_MAX_REQUESTS),
);

/** The requests a message's metadata names; none when it names none or they do not read. */
export const chatLocalRunRequestsOf = (
  metadata: unknown,
): readonly ChatLocalRunRequest[] => {
  if (typeof metadata !== "object" || metadata === null) {
    return [];
  }
  const parsed = v.safeParse(
    chatLocalRunRequestsSchema,
    Reflect.get(metadata, CHAT_LOCAL_RUN_REQUESTS_METADATA_KEY),
  );
  return parsed.success ? parsed.output : [];
};

/**
 * The member's answer to a request: a decision for an approval, answers for
 * a question, or a dismissal of the question (which stops the run's turn).
 */
export const chatLocalRunRequestAnswerSchema = v.variant("type", [
  v.object({
    type: v.literal("approval"),
    decision: v.picklist(DESKTOP_RUNNER_APPROVAL_DECISIONS),
  }),
  v.object({
    type: v.literal("question"),
    answers: chatLocalRunQuestionReplySchema.entries.answers,
  }),
  v.object({ type: v.literal("dismiss") }),
]);
export type ChatLocalRunRequestAnswer = v.InferOutput<
  typeof chatLocalRunRequestAnswerSchema
>;

/**
 * `POST /chat/threads/:threadId/turns/:turnId/requests/:requestId/answer`.
 * An answer is keyed by its request: the first one reaches the run, and a
 * repeat replays its receipt.
 */
export const chatLocalRunRequestAnswerRequestSchema = v.object({
  answer: chatLocalRunRequestAnswerSchema,
});

/**
 * What became of an answer:
 * - `answered`: it is on its way to the run (a repeat while it is, too); the
 *   run's stream says once it resolved the request.
 * - `already_resolved`: the run had already taken an answer to it.
 * - `expired`: the run no longer waits for it (`expiry` says why); nothing
 *   was sent.
 * - `cancelled`: the member stopped the run's turn before; nothing was sent.
 * - `refused`: the answer cannot be sent (`reason`): it does not answer the
 *   request, or the run holds as many commands as it may.
 */
export const chatLocalRunRequestAnswerOutcomeSchema = v.variant("type", [
  v.object({ type: v.literal("answered") }),
  v.object({ type: v.literal("already_resolved") }),
  v.object({
    type: v.literal("expired"),
    expiry: v.picklist(CHAT_LOCAL_RUN_REQUEST_EXPIRY),
  }),
  v.object({ type: v.literal("cancelled") }),
  v.object({
    type: v.literal("refused"),
    reason: v.picklist(["invalid_answer", "run_full"]),
  }),
]);
export type ChatLocalRunRequestAnswerOutcome = v.InferOutput<
  typeof chatLocalRunRequestAnswerOutcomeSchema
>;

/**
 * The CUSTOM event a run's computer reports a request's end with, on the
 * run's stream: `resolved` once the harness took an answer, `cancelled` when
 * the member's stop ended it, `expired` when the harness withdrew it or the
 * run ended with it open. The API folds it into the answer's requests; it
 * never reaches a viewer as is.
 */
export const DESKTOP_RUNNER_REQUEST_EVENT = "stella.local-run.request";

export const desktopRunnerRequestEventSchema = v.variant("status", [
  v.object({
    requestId: requestIdSchema,
    status: v.literal("resolved"),
    ...resolvedDecision,
  }),
  v.object({
    requestId: requestIdSchema,
    status: v.literal("expired"),
    expiry: v.picklist(CHAT_LOCAL_RUN_REQUEST_EXPIRY),
  }),
  v.object({ requestId: requestIdSchema, status: v.literal("cancelled") }),
]);
export type DesktopRunnerRequestEvent = v.InferOutput<
  typeof desktopRunnerRequestEventSchema
>;

/**
 * The blocking question a message's run asks and still waits on, as the
 * question card answers it: the request is the pause, its id the one an
 * answer names. The browser and the phone read it alike, live and reloaded.
 */
export const pendingLocalRunQuestionOf = (
  metadata: unknown,
): LocalRunQuestionPause | null => {
  for (const request of chatLocalRunRequestsOf(metadata)) {
    if (request.status === "pending" && request.ask.kind === "question") {
      return {
        interruptId: request.requestId,
        questions: request.ask.questions,
      };
    }
  }
  return null;
};

/** The approval a message's run still waits on for call `toolCallId`, if any. */
export const pendingLocalRunApprovalOf = (
  metadata: unknown,
  toolCallId: string,
): ChatLocalRunRequest | null =>
  chatLocalRunRequestsOf(metadata).find(
    (request) =>
      request.status === "pending" &&
      request.ask.kind === "approval" &&
      request.toolCallId === toolCallId,
  ) ?? null;
