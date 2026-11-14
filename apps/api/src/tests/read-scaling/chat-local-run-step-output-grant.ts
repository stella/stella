import getLocalRunStepOutputGrant from "@/api/handlers/chat/local-run-step-output-grant";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import { ownerStepOutputGrant } from "@/api/lib/desktop-runner/step-output-grants";
import type { RunOwner } from "@/api/lib/desktop-runner/store";

type ChatLocalRunStepOutputGrantFixture = {
  control: Pick<DesktopRunnerControl, "readRunOutputKey">;
  owner: RunOwner;
  runId: string;
};

/**
 * A grant reads the output key of the owner's one run by its id and signs
 * with it; nothing it reads grows with the run's events, commands or the
 * member's other runs.
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
      const grant = (
        await ownerStepOutputGrant({ control, owner, runId, now: 0 })
      ).unwrap();
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(grant)),
        rows: grant === null ? 0 : 1,
      };
    }),
};
