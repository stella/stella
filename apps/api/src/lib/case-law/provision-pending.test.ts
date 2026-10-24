import { expect, test } from "bun:test";

import { CASE_LAW_JURISDICTIONS } from "@stll/api-contract/case-law-jurisdictions";

import { unavailableProvisionPendingCounts } from "./provision-pending";

test("failed reads retain total capability coverage and never report zero", () => {
  const entries = unavailableProvisionPendingCounts();
  expect(entries.map(({ country }) => country)).toEqual(CASE_LAW_JURISDICTIONS);
  for (const { country, state } of entries) {
    expect(state).not.toHaveProperty("pendingCount");
    if (country === "CZE" || country === "SVK") {
      expect(state).toEqual({
        type: "unavailable",
        reason: "read_failed",
        lastSampledAt: null,
      });
    } else {
      expect(state.type).toBe("notSupportedYet");
    }
  }
});
