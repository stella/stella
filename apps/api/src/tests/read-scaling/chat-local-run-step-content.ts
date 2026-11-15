import type { SafeDb } from "@/api/db/safe-db";
import getLocalRunStepContent from "@/api/handlers/chat/local-run-step-content";
import type { SafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { stepContentAnswer } from "@/api/lib/desktop-runner/step-content-answer";
import { readVisibleStepContent } from "@/api/lib/desktop-runner/step-contents";
import type { RunOwner } from "@/api/lib/desktop-runner/store";

type ChatLocalRunStepContentFixture = {
  /** The member's own scoped connection. */
  safeDb: SafeDb;
  owner: RunOwner;
  threadId: SafeId<"chatThread">;
  stepKey: string;
};

/**
 * One stored step is read by its thread and step key in one statement and
 * answered in one bounded window: nothing it reads or answers grows with
 * the thread's other steps, its runs or their events.
 */
export const chatLocalRunStepContentScalingScenario = {
  name: "chat local run step content",
  definition: getLocalRunStepContent,
  measure: async ({
    safeDb,
    owner,
    threadId,
    stepKey,
  }: ChatLocalRunStepContentFixture) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const content = (
        await readVisibleStepContent(safeDb, { owner, threadId, stepKey })
      ).unwrap();
      const answer =
        content === null ||
        content.type === "none" ||
        content.type === "awaited"
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
