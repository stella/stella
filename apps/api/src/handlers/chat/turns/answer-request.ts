import { Result } from "better-result";
import * as v from "valibot";

import {
  type ChatLocalRunRequestAnswerOutcome,
  chatLocalRunRequestAnswerRequestSchema,
} from "@stll/api-contract/chat-local-run-request";

import {
  readChatTurnView,
  stopChatTurnOnTx,
} from "@/api/handlers/chat/chat-turn-persistence";
import { stopLocalChatTurnRun } from "@/api/handlers/chat/chat-turn-run";
import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import { detached } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { withChatRunPings } from "@/api/lib/chat/chat-run-pings";
import type { ChatTurnStatus } from "@/api/lib/chat/turn-status";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { answerRunRequest } from "@/api/lib/desktop-runner/request-answers";
import { getDesktopRunnerControl } from "@/api/lib/desktop-runner/runtime";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  contract: "patch",
  description:
    "Answer what a turn of one of your chat threads, running on your " +
    "computer, asked you: an approval of one step or a blocking question. " +
    "The turn keeps running while it waits; the answer goes to the run " +
    "beside it. An answer is keyed by its request: the first one reaches " +
    "the run and a repeat replays its receipt. `answered`: on its way, and " +
    "the turn's stream says once the run took it. `already_resolved`: the " +
    "run had taken an answer to it. `expired` with an `expiry` " +
    "(`run_finished`, `run_failed`, `withdrawn`, `run_lost`): the run no " +
    "longer waits for it. `cancelled`: the turn was stopped first. " +
    "`refused` with a `reason` (`invalid_answer`, `run_full`). A request " +
    "outside the turn, or one you cannot see, is a 404.",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "realtime_stream" },
  params: v.object({
    threadId: resourceIdSchema("chatThread"),
    turnId: resourceIdSchema("chatTurn"),
    requestId: v.pipe(v.string(), v.uuid()),
  }),
  body: chatLocalRunRequestAnswerRequestSchema,
} satisfies HandlerConfig;

/** One answer type for every branch, so the route infers the whole union. */
const answered = (outcome: ChatLocalRunRequestAnswerOutcome) =>
  Result.ok({ outcome });

/**
 * What a request of a settled turn reads as: its run ended with the turn,
 * so nothing reaches it any more, and the answer is told how it ended.
 * `null` while the turn is live: its run says. An accepted turn has no run
 * yet, which asked nothing.
 */
const SETTLED_TURN_OUTCOME = {
  accepted: "no_run",
  running: null,
  "awaiting-user": null,
  "handed-over": null,
  completed: { type: "expired", expiry: "run_finished" },
  failed: { type: "expired", expiry: "run_failed" },
  cancelled: { type: "cancelled" },
  interrupted: { type: "expired", expiry: "run_lost" },
} as const satisfies Record<
  ChatTurnStatus,
  ChatLocalRunRequestAnswerOutcome | "no_run" | null
>;

const notFound = (message: string) =>
  Result.err(new HandlerError({ status: 404, code: "not_found", message }));

/**
 * Answer a request of a local turn's run. The turn's own run is the only
 * one this reaches: the run is looked up by this member, thread, turn and
 * request, never named by the caller.
 */
const answerChatTurnRequest = createSafeRootHandler(
  config,
  async function* ({ body, params, safeDb, session, user }) {
    const { threadId, turnId, requestId } = params;
    const turn = yield* Result.await(
      readChatTurnView({ safeDb, threadId, turnId }),
    );
    if (turn === null) {
      return notFound("Chat turn not found");
    }
    const settled = SETTLED_TURN_OUTCOME[turn.status];
    if (settled === "no_run") {
      return notFound("Chat turn request not found");
    }
    if (settled !== null) {
      return answered(settled);
    }
    // The member's stop, as the turn's Stop records it: the turn's owner
    // settles it stopped, and the cut stops the run on the computer.
    const stopTurn = async () => {
      const stop = await withChatRunPings(
        async (pings) =>
          await safeDb(
            async (tx) =>
              await stopChatTurnOnTx({ pings, threadId, tx, turnId }),
          ),
      );
      // The intent is committed, so an owner elsewhere settles on it too;
      // this only spares a run this process produces the poll's delay.
      if (stop.isOk() && stop.value.type === "requested") {
        const { executionId } = stop.value;
        detached(async () => {
          await stopLocalChatTurnRun(executionId);
        }, "answer-request.stop");
      }
      return stop;
    };
    const outcome = yield* Result.await(
      answerRunRequest(
        { ...getDesktopRunnerControl().control, stopTurn },
        {
          owner: {
            userId: user.id,
            organizationId: session.activeOrganizationId,
          },
          chat: { threadId, turnId },
          requestId,
          answer: body.answer,
        },
      ),
    );
    return outcome === null
      ? notFound("Chat turn request not found")
      : answered(outcome);
  },
);

declareAggregateMutation(answerChatTurnRequest, {
  type: "independent",
  reason:
    "Queues one answer to the caller's own run in the desktop runner store, which takes the caller's runner capacity lock inside its own transaction, as the runner's other writes do; a dismissal stops the turn through the turn stop, which locks the thread itself.",
});

export default answerChatTurnRequest;
