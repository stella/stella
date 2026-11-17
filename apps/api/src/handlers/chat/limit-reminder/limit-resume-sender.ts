import { Result } from "better-result";

import { discardChatLimitResume, readDueChatLimitResumes } from "@/api/db/root";
import {
  CHAT_LIMIT_RESUME_SWEEP_INTERVAL_MS,
  createChatLimitResumer,
} from "@/api/handlers/chat/limit-reminder/limit-resume";
import { routeLocalRun } from "@/api/handlers/chat/local-run-route";
import sendMessage from "@/api/handlers/chat/send-message";
import { detached } from "@/api/lib/analytics/capture";
import { getDesktopRunnerControl } from "@/api/lib/desktop-runner/runtime";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

/** A sweep for chats to continue failed; the next one tries again. */
const limitResumeSweepFailed = failureSink({
  event: "chat.limit_resume.sweep_failed",
  expected: [],
});

/**
 * Continue chats whose members asked for it once the usage limit that
 * stopped them on their computer reset, from this API task: a sweep every
 * `CHAT_LIMIT_RESUME_SWEEP_INTERVAL_MS`. Safe on every task at once: only
 * one acceptance takes a request. Answers the stop the server calls on
 * shutdown.
 */
export const startChatLimitResumer = (): (() => void) => {
  const stopping = new AbortController();
  const sweep = createChatLimitResumer({
    send: sendMessage.handler,
    routeLocalRun: async ({ owner, target }) =>
      await routeLocalRun({
        control: getDesktopRunnerControl().control,
        owner,
        target,
      }),
    discard: discardChatLimitResume,
    readDue: readDueChatLimitResumes,
    now: () => new Date(),
    signal: stopping.signal,
  });
  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) {
      return;
    }
    sweeping = true;
    detached(async () => {
      const swept = await Result.tryPromise(async () => await sweep());
      sweeping = false;
      if (Result.isError(swept)) {
        observeFailure(swept.error, {
          sink: limitResumeSweepFailed,
          ctx: { feature: "chat.limit_resume" },
        });
      }
    }, "chat-limit-resume.sweep");
  }, CHAT_LIMIT_RESUME_SWEEP_INTERVAL_MS);
  return () => {
    clearInterval(timer);
    stopping.abort();
  };
};
