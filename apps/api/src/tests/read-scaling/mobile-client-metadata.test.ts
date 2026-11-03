import { expect, test } from "bun:test";

import { mobileClientMetadataScalingScenario } from "@/api/tests/read-scaling/mobile-client-metadata";

test("the mobile client metadata document reads nothing from the database", async () => {
  const measured = await mobileClientMetadataScalingScenario.measure();
  expect(measured.statements).toBe(0);
  expect(measured.transactionRoundTrips).toBe(0);
});
