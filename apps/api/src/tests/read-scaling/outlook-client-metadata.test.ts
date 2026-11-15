import { expect, test } from "bun:test";

import { outlookClientMetadataScalingScenario } from "@/api/tests/read-scaling/outlook-client-metadata";

test("the Outlook client metadata document reads nothing from the database", async () => {
  const measured = await outlookClientMetadataScalingScenario.measure();
  expect(measured.statements).toBe(0);
  expect(measured.transactionRoundTrips).toBe(0);
});
