import getLocalRunStepContent from "@/api/handlers/chat/local-run-step-content";
import type { SafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import { stepContentAnswer } from "@/api/lib/desktop-runner/step-content-answer";
import type { RunOwner } from "@/api/lib/desktop-runner/store";

type ChatLocalRunStepContentFixture = {
  control: Pick<DesktopRunnerControl, "readStepContent">;
  owner: RunOwner;
  threadId: SafeId<"chatThread">;
  runId: string;
  stepKey: string;
};

/**
 * One step's content is read by its thread and step key in one statement
 * and answered in one bounded window: nothing it reads or answers grows with
 * the thread's other steps, its runs or their events.
 */
export const chatLocalRunStepContentScalingScenario = {
  name: "chat local run step content",
  definition: getLocalRunStepContent,
  measure: async ({
    control,
    owner,
    threadId,
    runId,
    stepKey,
  }: ChatLocalRunStepContentFixture) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const content = (
        await control.readStepContent({ owner, threadId, stepKey, runId })
      ).unwrap();
      const answer =
        content === null
          ? null
          : stepContentAnswer(content, { start: 0, limit: 1024 });
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(answer)),
        rows: answer === null ? 0 : 1,
      };
    }),
};
