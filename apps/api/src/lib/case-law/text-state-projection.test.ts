import { expect, test } from "bun:test";

import { DECISION_TEXT_AVAILABILITY } from "@stll/api-contract/case-law-text-field";
import { CASE_LAW_TEXT_STATUS } from "@stll/api-contract/case-law-text-status";

import {
  decisionTextAvailability,
  readDecisionTextStateStatus,
} from "./text-state-projection";

test.each(Object.values(CASE_LAW_TEXT_STATUS))(
  "%s is explicit and dominates legacy pointer presence",
  (status) => {
    expect(readDecisionTextStateStatus(status)).toBe(status);
    for (const legacyHasDocument of [false, true]) {
      expect(decisionTextAvailability(status, legacyHasDocument)).toBe(
        status === CASE_LAW_TEXT_STATUS.STORED
          ? DECISION_TEXT_AVAILABILITY.AVAILABLE
          : DECISION_TEXT_AVAILABILITY.METADATA_ONLY,
      );
    }
  },
);

test("only legacy null retains the canonical presence fallback", () => {
  expect(readDecisionTextStateStatus(null)).toBeNull();
  expect(decisionTextAvailability(null, true)).toBe(
    DECISION_TEXT_AVAILABILITY.AVAILABLE,
  );
  expect(decisionTextAvailability(null, false)).toBe(
    DECISION_TEXT_AVAILABILITY.METADATA_ONLY,
  );
});

test.each([undefined, "", "unavailable", {}, 0])(
  "invalid status %j fails instead of becoming a legacy row",
  (value) => {
    expect(() => readDecisionTextStateStatus(value)).toThrow(
      "Invalid public decision text state status",
    );
  },
);
