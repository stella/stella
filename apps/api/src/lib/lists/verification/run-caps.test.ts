import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import * as v from "valibot";

import { VERIFICATION_RUN_CAP_CODES } from "@stll/api-contract/verification-run-caps";

import {
  DEFAULT_VERIFICATION_RUN_CAPS,
  verificationRunCapEnvSchema,
} from "@/api/lib/lists/verification/run-cap-config";
import { decideVerificationBudget } from "@/api/lib/lists/verification/run-caps";

test("run cap configuration defaults are positive and bounded", () => {
  const schema = v.strictObject(verificationRunCapEnvSchema);
  expect(v.parse(schema, {})).toEqual({
    LIST_VERIFICATION_ACTIVE_RUNS_MAX: DEFAULT_VERIFICATION_RUN_CAPS.active,
    LIST_VERIFICATION_DAILY_STARTS_MAX:
      DEFAULT_VERIFICATION_RUN_CAPS.startsPerDay,
  });
  for (const value of ["0", "-1", "1.5", "NaN", "101", "Infinity"]) {
    expect(
      v.safeParse(schema, { LIST_VERIFICATION_ACTIVE_RUNS_MAX: value }).success,
    ).toBe(false);
  }
  expect(
    v.safeParse(schema, { LIST_VERIFICATION_DAILY_STARTS_MAX: "1001" }).success,
  ).toBe(false);
});

test("an admitted run can dispatch at the cap and a start needs a free slot", () => {
  const caps = { active: 2, startsPerDay: 3 };
  for (const phase of ["start", "dispatch"] as const) {
    for (let active = 0; active <= 3; active += 1) {
      for (let starts = 0; starts <= 4; starts += 1) {
        const outcome = decideVerificationBudget({
          active,
          starts,
          caps,
          phase,
        });
        const admitted =
          phase === "start"
            ? active < 2 && starts < 3
            : active <= 2 && starts <= 3;
        expect(Result.isOk(outcome)).toBe(admitted);
        if (Result.isError(outcome)) {
          expect(outcome.error.code).toBe(
            VERIFICATION_RUN_CAP_CODES[outcome.error.reason],
          );
          expect(outcome.error.hint).toContain("lists.verifications.create");
          expect(outcome.error.reason).toBe(
            active >= caps.active + (phase === "dispatch" ? 1 : 0)
              ? "active"
              : "daily",
          );
        }
      }
    }
  }
  const refused = decideVerificationBudget({
    active: 2,
    starts: 0,
    caps,
    phase: "start",
  });
  if (Result.isOk(refused)) {
    panic("The fixture must reach the active cap");
  }
  expect(refused.error.message).toContain("active verification limit");
});
