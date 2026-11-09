import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  type ChatLocalRunSteerOutcome,
  chatLocalRunSteerRequestSchema,
} from "@stll/api-contract/chat-run-target";

import { readChatTurnView } from "@/api/handlers/chat/chat-turn-persistence";
import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
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
    "`unavailable`: the turn does not run, does not run on a computer, or " +
    "its harness takes no message mid-turn; send it as a new message. A " +
    "turn outside the thread, or one you cannot see, is a 404.",
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
      return answer("unavailable");
    }
    const steered = await getDesktopRunnerControl().control.steerChatTurn({
      owner: {
        userId: user.id,
        organizationId: session.activeOrganizationId,
      },
      chat: { threadId, turnId },
      inputId: body.inputId,
      text: body.text,
    });
    if (steered.isErr()) {
      // The request's bounds are the command's, so only the store can fail.
      return steered.error._tag === "DatabaseError"
        ? Result.err(steered.error)
        : panic("A steer the request schema admits broke the command contract");
    }
    return answer(steered.value);
  },
);

declareAggregateMutation(steerChatTurn, {
  type: "independent",
  reason:
    "Queues one runner command for the turn's open run; the runner store serializes it on the member's runner capacity, and the turn itself is not written.",
});

export default steerChatTurn;
