import { panic } from "better-result";

import connectDesktopRunner from "@/api/handlers/desktop-runner/connect";
import type { HttpServer } from "@/api/http/context";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { DesktopRunnerGateway } from "@/api/lib/desktop-runner/gateway";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/** A server that takes every upgrade over, as Bun does when the socket opens. */
const acceptingServer = asTestRaw<HttpServer>({ upgrade: () => true });

type DesktopRunnerUpgradeFixture = {
  gateway: DesktopRunnerGateway;
  /** A fresh upgrade request; each carries a single-use device proof. */
  signRequest: () => Promise<Request>;
};

/**
 * Opening a runner socket authenticates the desktop account and its device
 * proof and reads the account's runner feature decision. Nothing it reads grows with the runs, commands or events the
 * account's desktops hold; the socket's own reads are bounded pages.
 */
export const desktopRunnerUpgradeScalingScenario = {
  name: "desktop runner socket upgrade",
  definition: connectDesktopRunner,
  measure: async ({ gateway, signRequest }: DesktopRunnerUpgradeFixture) => {
    const request = await signRequest();
    return await runWithMeasuredQueryCounter(async (counter) => {
      const refusal = await gateway.upgrade(request, acceptingServer);
      if (refusal !== null) {
        return panic(
          `Desktop runner upgrade scaling requires an accepted upgrade, got ${String(refusal.status)}`,
        );
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: 0,
        rows: 1,
      };
    });
  },
};
