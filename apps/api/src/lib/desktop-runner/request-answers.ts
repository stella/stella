import { panic, Result } from "better-result";
import * as v from "valibot";

import type {
  ChatLocalRunRequestAnswer,
  ChatLocalRunRequestAnswerOutcome,
  ChatLocalRunRequestExpiry,
  DesktopRunnerRequestEvent,
} from "@stll/api-contract/chat-local-run-request";
import {
  DESKTOP_RUNNER_DESKTOP_MESSAGE,
  desktopRunnerDesktopMessageSchema,
} from "@stll/api-contract/desktop-runner";

import type { SafeDbError } from "@/api/db/safe-db-types";
import {
  questionPauseOf,
  questionReplyOf,
} from "@/api/lib/desktop-runner/chunk";
import type {
  DesktopRunnerControl,
  DesktopRunnerControlError,
  QueueCommandOutcome,
} from "@/api/lib/desktop-runner/control";
import { DESKTOP_RUNNER_OPEN_RUN_STATES } from "@/api/lib/desktop-runner/states";
import type {
  ChatRunBinding,
  ChatRunForRequest,
  RunOwner,
} from "@/api/lib/desktop-runner/store";
import type { DatabaseError } from "@/api/lib/errors/tagged-errors";

/**
 * Answering what a run on the member's computer asked, beside its running
 * turn. The turn never pauses for it: the run may go on while the request
 * waits, and the turn's own read shows whatever it does. An answer goes to
 * the run's computer as a command keyed by the request (`insertRunCommand`),
 * so the first answer is the one the run gets and a repeat replays its
 * receipt. One that comes too late is told so in the request's terms, never
 * as the computer having stopped.
 */

type AnswerControl = Pick<
  DesktopRunnerControl,
  | "answerApproval"
  | "answerQuestion"
  | "readChatRunForRequest"
  | "readRunRequestAnswered"
  | "readRunRequestClosure"
> & {
  /**
   * The member's stop of the turn that holds `run`, as its Stop does it:
   * dismissing a question stops the run's turn, which closes the question
   * cancelled.
   */
  stopTurn: (run: {
    owner: RunOwner;
    runId: string;
  }) => Promise<Result<unknown, SafeDbError | DesktopRunnerControlError>>;
};

type ChatRunOutcome = ChatRunForRequest["outcome"];

/** What a request reads as once its run ended without reporting it closed. */
const OUTCOME_OF_ENDED_RUN = {
  completed: { type: "expired", expiry: "run_finished" },
  interrupted: { type: "cancelled" },
  cancelled: { type: "cancelled" },
  failed: { type: "expired", expiry: "run_failed" },
  limit_reached: { type: "expired", expiry: "run_failed" },
  needs_login: { type: "expired", expiry: "run_failed" },
} as const satisfies Record<
  NonNullable<ChatRunOutcome>,
  ChatLocalRunRequestAnswerOutcome
>;

const expired = (
  expiry: ChatLocalRunRequestExpiry,
): ChatLocalRunRequestAnswerOutcome => ({ type: "expired", expiry });

/** An ended run's request, by how the run ended; `run_lost` without an end. */
const endedRunOutcome = (
  outcome: ChatRunOutcome,
): ChatLocalRunRequestAnswerOutcome =>
  outcome === null ? expired("run_lost") : OUTCOME_OF_ENDED_RUN[outcome];

/** A closed request, as an answer to it is told. */
const closedOutcome = (
  closure: DesktopRunnerRequestEvent,
): ChatLocalRunRequestAnswerOutcome => {
  switch (closure.status) {
    case "resolved":
      return { type: "already_resolved" };
    case "cancelled":
      return { type: "cancelled" };
    case "expired":
      return expired(closure.expiry);
    default:
      closure satisfies never;
      return panic("Unknown request closure");
  }
};

/** What a queued command made of the answer; `ended` when the run had ended. */
const queuedOutcome = (
  queued: QueueCommandOutcome,
): ChatLocalRunRequestAnswerOutcome | "ended" => {
  switch (queued.type) {
    // A duplicate: the first answer was queued already, its receipt stands.
    case "queued":
    case "duplicate":
      return { type: "answered" };
    // The run ended between the read and the command.
    case "run_ended":
    case "run_not_found":
      return "ended";
    case "command_limit":
      return { type: "refused", reason: "run_full" };
    case "too_large":
      return { type: "refused", reason: "invalid_answer" };
    case "not_requested":
      // The answer's kind is checked against the asking message first.
      return panic("An answer named a request its run asked otherwise");
    default:
      queued satisfies never;
      return panic("Unknown desktop runner command outcome");
  }
};

/** The questions of the stored message that asked a blocking question. */
const askedQuestions = (run: ChatRunForRequest) => {
  const stored = v.safeParse(desktopRunnerDesktopMessageSchema, run.request);
  const pause = stored.success
    ? questionPauseOf(
        stored.output.type === DESKTOP_RUNNER_DESKTOP_MESSAGE.runEvent
          ? stored.output.chunk
          : null,
      )
    : null;
  return pause?.type === "question" ? pause.questions : null;
};

type AnswerRunRequestOptions = {
  owner: RunOwner;
  chat: ChatRunBinding;
  requestId: string;
  answer: ChatLocalRunRequestAnswer;
};

/**
 * Hand the member's answer to the run that asked `requestId`, or say why it
 * cannot reach it. `null` when no run of this member's turn asked it.
 */
/**
 * The request as its run stands: the run that asked it (`null` for none),
 * and the outcome an answer gets when it can no longer reach the run, or
 * `null` while the request is open.
 */
const requestState = async (
  control: AnswerControl,
  { owner, chat, requestId }: Omit<AnswerRunRequestOptions, "answer">,
): Promise<
  Result<
    {
      run: ChatRunForRequest;
      closed: ChatLocalRunRequestAnswerOutcome | null;
    } | null,
    DatabaseError
  >
> => {
  const found = await control.readChatRunForRequest({ owner, chat, requestId });
  if (found.isErr()) {
    return Result.err(found.error);
  }
  const run = found.value;
  if (run === null) {
    return Result.ok(null);
  }
  const closure = await control.readRunRequestClosure({
    owner,
    runId: run.runId,
    requestId,
  });
  if (closure.isErr()) {
    return Result.err(closure.error);
  }
  if (closure.value !== null) {
    return Result.ok({ run, closed: closedOutcome(closure.value) });
  }
  const open = DESKTOP_RUNNER_OPEN_RUN_STATES.some(
    (state) => state === run.state,
  );
  return Result.ok({ run, closed: open ? null : endedRunOutcome(run.outcome) });
};

export const answerRunRequest = async (
  control: AnswerControl,
  { owner, chat, requestId, answer }: AnswerRunRequestOptions,
): Promise<
  Result<ChatLocalRunRequestAnswerOutcome | null, DatabaseError | SafeDbError>
> => {
  const state = await requestState(control, { owner, chat, requestId });
  if (state.isErr()) {
    return Result.err(state.error);
  }
  if (state.value === null) {
    return Result.ok(null);
  }
  const { run, closed } = state.value;
  if (closed !== null) {
    return Result.ok(closed);
  }
  const asksApproval =
    run.askedBy === DESKTOP_RUNNER_DESKTOP_MESSAGE.runApprovalRequest;
  const queued = await (async () => {
    switch (answer.type) {
      case "approval":
        return asksApproval
          ? await control.answerApproval({
              owner,
              runId: run.runId,
              requestId,
              decision: answer.decision,
            })
          : null;
      case "question": {
        const questions = asksApproval ? null : askedQuestions(run);
        if (questions === null) {
          return null;
        }
        const reply = questionReplyOf({ answers: answer.answers }, questions);
        return reply.type === "refused"
          ? null
          : await control.answerQuestion({
              owner,
              runId: run.runId,
              requestId,
              answers: reply.answers,
            });
      }
      case "dismiss": {
        // Dismissing a question is the member's stop of the turn; one
        // already answered keeps that answer, whose receipt stands.
        if (asksApproval) {
          return null;
        }
        const answered = await control.readRunRequestAnswered({
          owner,
          runId: run.runId,
          requestId,
        });
        if (answered.isErr() || answered.value) {
          return answered.map((): QueueCommandOutcome => ({
            type: "duplicate",
          }));
        }
        const stopped = await control.stopTurn({ owner, runId: run.runId });
        return stopped.map((): QueueCommandOutcome => ({ type: "queued" }));
      }
      default:
        answer satisfies never;
        return panic("Unknown request answer");
    }
  })();
  if (queued === null) {
    return Result.ok({ type: "refused", reason: "invalid_answer" });
  }
  if (queued.isErr()) {
    // The request's bounds are the command's, so only the store can fail.
    return queued.error._tag === "DesktopRunnerCommandInvalid"
      ? panic("An answer the request schema admits broke the command contract")
      : Result.err(queued.error);
  }
  const outcome = queuedOutcome(queued.value);
  if (outcome !== "ended") {
    return Result.ok(outcome);
  }
  // The run ended since it was read: the answer reads by how it ended.
  const ended = await requestState(control, { owner, chat, requestId });
  return ended.map((now) => now?.closed ?? endedRunOutcome(null));
};
