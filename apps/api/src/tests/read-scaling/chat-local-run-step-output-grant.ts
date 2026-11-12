import getLocalRunStepOutputGrant from "@/api/handlers/chat/local-run-step-output-grant";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import type { RunOwner } from "@/api/lib/desktop-runner/store";

type ChatLocalRunStepOutputGrantFixture = {
  control: Pick<DesktopRunnerControl, "readRun">;
  owner: RunOwner;
  runId: string;
};

/**
 * A grant reads the owner's one run by its id and derives a key; nothing it
 * reads grows with the run's events, commands or the member's other runs.
 */
export const chatLocalRunStepOutputGrantScalingScenario = {
  name: "chat local run step output grant",
  definition: getLocalRunStepOutputGrant,
  measure: async ({
    control,
    owner,
    runId,
  }: ChatLocalRunStepOutputGrantFixture) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const run = (await control.readRun({ owner, runId })).unwrap();
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(run)),
        rows: run === null ? 0 : 1,
      };
    }),
};
