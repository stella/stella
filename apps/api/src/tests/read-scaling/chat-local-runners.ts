import getLocalRunners from "@/api/handlers/chat/local-runners";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import type { RunOwner } from "@/api/lib/desktop-runner/store";

type ChatLocalRunnersFixture = {
  control: Pick<DesktopRunnerControl, "readMemberRunners">;
  owner: RunOwner;
};

/**
 * The composer's computer list reads the member's feature decision, a fixed
 * cost, and then the member's runner rows, which an account holds at most
 * `maxRunnersPerAccount` of. The measured read is that second one: it must
 * not grow with the runs, commands or events those computers hold.
 */
export const chatLocalRunnersScalingScenario = {
  name: "chat local runners",
  definition: getLocalRunners,
  measure: async ({ control, owner }: ChatLocalRunnersFixture) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const runners = (await control.readMemberRunners({ owner })).unwrap();
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(runners)),
        rows: runners.length,
      };
    }),
};
