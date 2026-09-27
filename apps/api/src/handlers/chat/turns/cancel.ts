import { panic, Result } from "better-result";
import { t } from "elysia";

import {
  readChatTurnView,
  stopChatTurnOnTx,
} from "@/api/handlers/chat/chat-turn-persistence";
import { stopLocalChatTurnProducer } from "@/api/handlers/chat/chat-turn-producers";
import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

/**
 * How long a stop waits for a run this process produces to store its outcome,
 * before answering that the stop is recorded but not yet settled.
 */
const LOCAL_STOP_SETTLE_WAIT_MS = 10_000;

const config = {
  description:
    "Stop a turn of one of your chat threads. Idempotent: the answer is the " +
    "turn as it now stands. 200 when the turn is settled, by this request or " +
    "before it (a turn that completed first stays completed); 202 when the " +
    "turn still runs and its owner will settle it as stopped. A turn outside " +
    "the thread, or one you cannot see, is a 404.",
  permissions: CHAT_TURN_PERMISSIONS,
  mcp: { type: "internal", reason: "realtime_stream" },
  params: t.Object({
    threadId: tSafeId("chatThread"),
    turnId: tSafeId("chatTurn"),
  }),
} satisfies HandlerConfig;

const settledWithin = async (
  settled: Promise<undefined>,
  timeoutMs: number,
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      settled,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const turnNotFound = () =>
  new HandlerError({ status: 404, message: "Chat turn not found" });

/** The turn still runs: the stop is recorded and its owner settles it. */
const STOP_ACCEPTED_STATUS = 202;

const cancelChatTurn = createSafeRootHandler(
  config,
  async function* ({ params: { threadId, turnId }, safeDb, set }) {
    const stop = yield* Result.await(
      safeDb(async (tx) => await stopChatTurnOnTx({ threadId, tx, turnId })),
    );
    switch (stop.type) {
      case "not-found":
        return Result.err(turnNotFound());
      case "settled":
        return Result.ok({ turn: stop.turn });
      case "requested": {
        // The intent is committed, so an owner elsewhere settles on it too;
        // this only spares a run this process produces the poll's delay.
        const localRun = stopLocalChatTurnProducer(stop.executionId);
        if (localRun !== null) {
          await settledWithin(localRun, LOCAL_STOP_SETTLE_WAIT_MS);
        }
        const turn =
          localRun === null
            ? stop.turn
            : yield* Result.await(
                readChatTurnView({ safeDb, threadId, turnId }),
              );
        if (turn === null) {
          return Result.err(turnNotFound());
        }
        if (turn.status === "running") {
          set.status = STOP_ACCEPTED_STATUS;
        }
        return Result.ok({ turn });
      }
      default:
        stop satisfies never;
        return panic(`Unhandled stop: ${String(stop)}`);
    }
  },
);

export default cancelChatTurn;
