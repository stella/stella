import { Result } from "better-result";

import { routeLocalRun } from "@/api/handlers/chat/local-run-route";
import {
  CHAT_QUEUE_SWEEP_INTERVAL_MS,
  createChatQueueDrainer,
} from "@/api/handlers/chat/queue/chat-queue-drain";
import sendMessage from "@/api/handlers/chat/send-message";
import { detached } from "@/api/lib/analytics/capture";
import { answerChatQueueDoorbell } from "@/api/lib/chat/chat-queue-doorbell";
import { getDesktopRunnerControl } from "@/api/lib/desktop-runner/runtime";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

/** A sweep for due queues failed; the next one, `CHAT_QUEUE_SWEEP_INTERVAL_MS` later, tries again. */
const queueSweepFailed = failureSink({
  event: "chat.queue.sweep_failed",
  expected: [],
});

/**
 * Send queued chat messages from this API task: every ring of the doorbell
 * here, and a sweep every `CHAT_QUEUE_SWEEP_INTERVAL_MS` for a ring lost to a
 * process exit. Safe on every task at once: two senders of one thread
 * serialize on its lock and the message's acceptance takes it only once.
 * Answers the stop the server calls on shutdown.
 */
export const startChatQueueSender = (): (() => void) => {
  const stopping = new AbortController();
  const drainer = createChatQueueDrainer({
    send: sendMessage.handler,
    routeLocalRun: async ({ owner, target }) =>
      await routeLocalRun({
        control: getDesktopRunnerControl().control,
        owner,
        target,
      }),
    signal: stopping.signal,
  });
  const stopAnswering = answerChatQueueDoorbell((threadId) => {
    detached(async () => await drainer.drain(threadId), "chat-queue.ring");
  });
  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) {
      return;
    }
    sweeping = true;
    detached(async () => {
      const swept = await Result.tryPromise(async () => await drainer.sweep());
      sweeping = false;
      if (Result.isError(swept)) {
        observeFailure(swept.error, {
          sink: queueSweepFailed,
          ctx: { feature: "chat.queue" },
        });
      }
    }, "chat-queue.sweep");
  }, CHAT_QUEUE_SWEEP_INTERVAL_MS);
  return () => {
    clearInterval(timer);
    stopAnswering();
    stopping.abort();
  };
};
