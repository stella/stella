import { panic } from "better-result";
import { afterEach, mock } from "bun:test";

import type { ChatTurnRun } from "@/api/handlers/chat/chat-turn-run";
import type { StreamChatProps } from "@/api/handlers/chat/stream-chat";

/** A dispatch-only stub still owns the handed-over run until teardown. */
export const createChatStreamMock = () => {
  const runs = new Set<ChatTurnRun>();
  afterEach(async () => {
    for (const run of runs) {
      // No producer exists to observe cancellation and settle this run.
      await run.fail("provider-error", true);
      if ((await run.settled) !== "stored") {
        panic("The chat stream mock could not settle its handed-over run");
      }
    }
    runs.clear();
  });
  return mock(async ({ run }: StreamChatProps) => {
    runs.add(run);
    return new Response("stream started", {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
};
