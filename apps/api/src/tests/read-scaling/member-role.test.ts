import { expect, test } from "bun:test";

import { memberRoleScalingScenario } from "@/api/tests/read-scaling/member-role";

test("the caller's role is answered from the request, reading nothing from the database", async () => {
  const measured = await memberRoleScalingScenario.measure();
  expect(measured.role).toBe("intern");
  expect(measured.statements).toBe(0);
  expect(measured.transactionRoundTrips).toBe(0);
});
