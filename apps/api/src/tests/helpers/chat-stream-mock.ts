import { panic } from "better-result";
import { afterEach, mock } from "bun:test";

import type { ChatTurnRun } from "@/api/handlers/chat/chat-turn-run";
import type { streamChat } from "@/api/handlers/chat/stream-chat";
import { sseResponse } from "@/api/lib/sse";

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
  return mock(async ({ run }: Parameters<typeof streamChat>[0]) => {
    runs.add(run);
    return sseResponse(
      new ReadableStream<Uint8Array>({
        start: (controller) => controller.close(),
      }),
    );
  });
};
