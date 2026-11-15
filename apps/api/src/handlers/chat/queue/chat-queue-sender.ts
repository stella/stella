import { Result } from "better-result";

import { routeLocalRun } from "@/api/handlers/chat/local-run-route";
import {
  CHAT_QUEUE_SWEEP_INTERVAL_MS,
  createChatQueueDrainer,
} from "@/api/handlers/chat/queue/chat-queue-drain";
import sendMessage from "@/api/handlers/chat/send-message";
import { captureError, detached } from "@/api/lib/analytics/capture";
import { answerChatQueueDoorbell } from "@/api/lib/chat/chat-queue-doorbell";
import { getDesktopRunnerControl } from "@/api/lib/desktop-runner/runtime";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";

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
  const stopAnswering = answerChatQueueDoorbell((threadId, whileWaiting) => {
    detached(
      async () => await drainer.drain(threadId, whileWaiting),
      "chat-queue.ring",
    );
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
        captureError(
          swept.error,
          handlerErrorContext("chat.queue.sweep", { feature: "chat.queue" }),
        );
      }
    }, "chat-queue.sweep");
  }, CHAT_QUEUE_SWEEP_INTERVAL_MS);
  return () => {
    clearInterval(timer);
    stopAnswering();
    stopping.abort();
  };
};
