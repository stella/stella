import { RUN_CANCEL_REASON } from "@tanstack/ai";
import { Result } from "better-result";

import type { SafeDb } from "@/api/db/safe-db";
import { readChatTurnExecutionStanding } from "@/api/handlers/chat/chat-turn-persistence";
import type { ChatTurnExecution } from "@/api/handlers/chat/chat-turn-persistence";
import { captureError, detached } from "@/api/lib/analytics/capture";

// The runs this process is producing, by execution id, so a stop request that
// reaches this process aborts its run at once. A stop that reaches another
// process is recorded on the turn row, and the owner finds it by polling.

/**
 * How often a run's owner looks for a stop requested on another instance:
 * the latency bound of that stop. A stop reaching this instance aborts at
 * once.
 */
const CHAT_TURN_STOP_POLL_MS = 5000;

type ChatTurnProducer = {
  abortController: AbortController;
  settled: Promise<undefined>;
};

const producers = new Map<string, ChatTurnProducer>();

/**
 * Upstream's explicit-cancel reason, not a `DOMException`: the run then reads
 * as the user's cancel, never as a dropped connection.
 */
const abortForStop = (abortController: AbortController): void => {
  if (!abortController.signal.aborted) {
    abortController.abort(RUN_CANCEL_REASON);
  }
};

type ChatTurnProducerRegistration = {
  /** Call once the run's terminal outcome is stored. */
  settled: () => void;
};

export const registerChatTurnProducer = ({
  abortController,
  execution,
  pollMs = CHAT_TURN_STOP_POLL_MS,
  safeDb,
}: {
  abortController: AbortController;
  execution: ChatTurnExecution;
  pollMs?: number | undefined;
  safeDb: SafeDb;
}): ChatTurnProducerRegistration => {
  const settled = Promise.withResolvers<undefined>();
  producers.set(execution.executionId, {
    abortController,
    settled: settled.promise,
  });
  const checkForStop = async () => {
    const standing = await readChatTurnExecutionStanding({
      execution,
      safeDb,
    });
    // A failed read is transient: the lease still holds, and the next poll
    // asks again.
    if (Result.isError(standing)) {
      captureError(standing.error, { source: "chat-turn-stop-poll" });
      return;
    }
    if (standing.value === "stop-requested") {
      abortForStop(abortController);
    }
  };
  let polling = false;
  const poll = setInterval(() => {
    if (polling) {
      return;
    }
    polling = true;
    detached(
      checkForStop().finally(() => {
        polling = false;
      }),
      "chat-turn-producers.poll",
    );
  }, pollMs);
  poll.unref();
  const stopPolling = () => {
    clearInterval(poll);
  };
  abortController.signal.addEventListener("abort", stopPolling, {
    once: true,
  });
  return {
    settled: () => {
      stopPolling();
      producers.delete(execution.executionId);
      settled.resolve(undefined);
    },
  };
};

/**
 * Stop the run `executionId` names if this process produces it. Resolves once
 * the run has stored its outcome; null when another process owns the run.
 */
export const stopLocalChatTurnProducer = (
  executionId: string,
): Promise<undefined> | null => {
  const producer = producers.get(executionId);
  if (producer === undefined) {
    return null;
  }
  abortForStop(producer.abortController);
  return producer.settled;
};
