import readBackgroundTasks from "@/api/handlers/chat/threads/background-tasks";
import type { SafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import type { RunOwner } from "@/api/lib/desktop-runner/store";

type ChatBackgroundTasksFixture = {
  control: Pick<DesktopRunnerControl, "readBackgroundTasks">;
  owner: RunOwner;
  threadId: SafeId<"chatThread">;
};

/**
 * A chat's background count reads the chat's runs that hold background work
 * on a connected computer, bounded, in one statement: it must not grow with
 * the chat's other runs, their commands or events.
 */
export const chatBackgroundTasksScalingScenario = {
  name: "chat background tasks",
  definition: readBackgroundTasks,
  measure: async ({ control, owner, threadId }: ChatBackgroundTasksFixture) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const count = (
        await control.readBackgroundTasks({ owner, threadId })
      ).unwrap();
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify({ count })),
        rows: 1,
      };
    }),
};
