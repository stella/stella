import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  CHAT_LOCAL_RUN_STEER_SOURCE,
  type ChatLocalRunSteerOutcome,
  chatLocalRunSteerRequestSchema,
  type ChatLocalRunSteerSource,
} from "@stll/api-contract/chat-run-target";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { readChatTurnView } from "@/api/handlers/chat/chat-turn-persistence";
import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import { lockOwnQueueThreadOnTx } from "@/api/handlers/chat/queue/chat-queue-store";
import {
  clearSteeredQueuedMessageOnTx,
  markSteeredQueuedMessageOnTx,
  steeredMessageIdOf,
} from "@/api/handlers/chat/queue/steered-message";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { getDesktopRunnerControl } from "@/api/lib/desktop-runner/runtime";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  contract: "patch",
  description:
    "Hand a message to a turn of one of your chat threads while it runs on " +
    "your computer, so the turn goes on with it instead of stopping. " +
    "Idempotent on `inputId`. `queued`: the computer was handed the " +
    "message, and the turn's stream says whether its harness took it. " +
    "`source`: `composer` for a message just written, or `queued` with " +
    "the `revision` read for the queued message `inputId`, which leaves " +
    "the queue once the turn took it. `refused` with a `reason`: " +
    "`turn_not_running`, `no_run` (no run on a computer yet, or it ended), " +
    "`harness_cannot_steer`, `run_full`, or `queued_message_changed` (the " +
    "queued message was edited, sent or removed since); queue the message " +
    "as the next one. A turn outside the thread, or one you cannot see, is " +
    "a 404.",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "realtime_stream" },
  params: v.object({
    threadId: resourceIdSchema("chatThread"),
    turnId: resourceIdSchema("chatTurn"),
  }),
  body: chatLocalRunSteerRequestSchema,
} satisfies HandlerConfig;

/** One answer type for every branch, so the route infers the whole union. */
const answer = (steer: ChatLocalRunSteerOutcome) => Result.ok({ steer });

type QueuedSteerMark = {
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  source: ChatLocalRunSteerSource;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  id: SafeId<"chatMessage">;
};

/**
 * Mark a queued message as handed to the turn at the revision the member
 * read, before the computer is handed it: the run's report on the steer then
 * finds the mark (`createSteeredQueue`). A message just written has no mark.
 */
const markQueuedSteer = async ({
  id,
  organizationId,
  safeDb,
  source,
  threadId,
  userId,
}: QueuedSteerMark): Promise<
  Result<"marked" | "changed" | "unqueued", SafeDbError>
> => {
  switch (source.type) {
    case CHAT_LOCAL_RUN_STEER_SOURCE.composer:
      return Result.ok("unqueued");
    case CHAT_LOCAL_RUN_STEER_SOURCE.queued:
      return await safeDb(async (tx) =>
        (await lockOwnQueueThreadOnTx({
          organizationId,
          threadId,
          tx,
          userId,
        })) === undefined
          ? "changed"
          : await markSteeredQueuedMessageOnTx({
              id,
              revision: source.revision,
              threadId,
              tx,
            }),
      );
    default:
      source satisfies never;
      return panic("Unhandled steer source");
  }
};

/**
 * Steer a running local turn with a queued message. The turn's own run is
 * the only one this reaches: the run is looked up by this member, thread and
 * turn, never named by the request.
 */
const steerChatTurn = createSafeRootHandler(
  config,
  async function* ({ body, params, safeDb, session, user }) {
    const { threadId, turnId } = params;
    const turn = yield* Result.await(
      readChatTurnView({ safeDb, threadId, turnId }),
    );
    if (turn === null) {
      return Result.err(
        new HandlerError({
          status: 404,
          code: "not_found",
          message: "Chat turn not found",
        }),
      );
    }
    if (turn.status !== "running") {
      return answer({ type: "refused", reason: "turn_not_running" });
    }
    const organizationId = session.activeOrganizationId;
    const id = steeredMessageIdOf(body.inputId);
    const marked = yield* Result.await(
      markQueuedSteer({
        id,
        organizationId,
        safeDb,
        source: body.source,
        threadId,
        userId: user.id,
      }),
    );
    if (marked === "changed") {
      return answer({ type: "refused", reason: "queued_message_changed" });
    }
    const steered = await getDesktopRunnerControl().control.steerChatTurn({
      owner: { userId: user.id, organizationId },
      chat: { threadId, turnId },
      inputId: body.inputId,
      text: body.text,
    });
    // A refused steer reached no computer, so no report settles its mark. A
    // store failure may still have queued the command; its report does.
    if (
      steered.isOk() &&
      steered.value.type === "refused" &&
      marked === "marked"
    ) {
      yield* Result.await(
        safeDb(async (tx) => {
          if (
            (await lockOwnQueueThreadOnTx({
              organizationId,
              threadId,
              tx,
              userId: user.id,
            })) !== undefined
          ) {
            await clearSteeredQueuedMessageOnTx({ id, threadId, tx });
          }
        }),
      );
    }
    if (steered.isErr()) {
      // The request's bounds are the command's, so only the store can fail.
      return steered.error._tag === "DatabaseError"
        ? Result.err(steered.error)
        : panic("A steer the request schema admits broke the command contract");
    }
    return answer(steered.value);
  },
);

// A queued message's steer mark is written under the member's thread lock,
// the row its turns and queue changes lock; the runner command is serialized
// by the runner store, and the turn itself is not written.
declareAggregateMutation(steerChatTurn, {
  type: "aggregate",
  aggregates: ["chatThread"],
});

export default steerChatTurn;
