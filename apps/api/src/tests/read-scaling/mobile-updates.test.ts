import { expect, test } from "bun:test";

import { mobileUpdateScalingScenario } from "@/api/tests/read-scaling/mobile-updates";

test("the update relay reads three CDN objects and no rows at any CDN size", async () => {
  const small = await mobileUpdateScalingScenario.measure(1);
  const large = await mobileUpdateScalingScenario.measure(500);
  for (const measured of [small, large]) {
    expect(measured.statements).toBe(0);
    expect(measured.transactionRoundTrips).toBe(0);
    expect(measured.cdnReads).toBe(3);
  }
  expect(large.responseBytes).toBe(small.responseBytes);
});
