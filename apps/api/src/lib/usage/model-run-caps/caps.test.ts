import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import * as v from "valibot";

import { MODEL_RUN_CAP_CODES } from "@stll/api-contract/model-run-caps";

import {
  decideModelRunCaps,
  modelRunCapRefusal,
} from "@/api/lib/usage/model-run-caps/caps";
import {
  DEFAULT_MODEL_RUN_CAPS,
  MODEL_RUN_CAP_ENV,
  MODEL_RUN_KINDS,
  modelRunCapEnvSchema,
} from "@/api/lib/usage/model-run-caps/config";

test("every kind's limits are configured, defaulted, positive and bounded", () => {
  const schema = v.strictObject(modelRunCapEnvSchema);
  const parsed = v.parse(schema, {});
  const configured = new Set<string>();
  for (const kind of MODEL_RUN_KINDS) {
    const names = MODEL_RUN_CAP_ENV[kind];
    configured.add(names.active);
    configured.add(names.startsPerDay);
    expect(parsed[names.active]).toBe(DEFAULT_MODEL_RUN_CAPS[kind].active);
    expect(parsed[names.startsPerDay]).toBe(
      DEFAULT_MODEL_RUN_CAPS[kind].startsPerDay,
    );
    for (const value of ["0", "-1", "1.5", "NaN", "101", "Infinity"]) {
      expect(v.safeParse(schema, { [names.active]: value }).success).toBe(
        false,
      );
    }
    expect(v.safeParse(schema, { [names.startsPerDay]: "1001" }).success).toBe(
      false,
    );
  }
  // No setting is left over that no kind reads.
  expect([...configured].toSorted()).toEqual(
    Object.keys(modelRunCapEnvSchema).toSorted(),
  );
});

test("an admitted run can dispatch at the cap and a start needs a free slot", () => {
  const caps = { active: 2, startsPerDay: 3 };
  for (const kind of MODEL_RUN_KINDS) {
    for (const phase of ["start", "dispatch"] as const) {
      for (let active = 0; active <= 3; active += 1) {
        for (let starts = 0; starts <= 4; starts += 1) {
          const outcome = decideModelRunCaps({
            kind,
            operation: "fixture.runs.create",
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
            expect(outcome.error.kind).toBe(kind);
            expect(outcome.error.code).toBe(
              MODEL_RUN_CAP_CODES[outcome.error.reason],
            );
            expect(outcome.error.hint).toContain("fixture.runs.create");
            expect(outcome.error.reason).toBe(
              active >= caps.active + (phase === "dispatch" ? 1 : 0)
                ? "active"
                : "daily",
            );
          }
        }
      }
    }
  }
});

test("both kinds refuse with the same codes and envelope, each naming its own runs", () => {
  const messages = new Set<string>();
  for (const kind of MODEL_RUN_KINDS) {
    for (const [reason, starts, active] of [
      ["active", 0, 2],
      ["daily", 3, 0],
    ] as const) {
      const refused = decideModelRunCaps({
        kind,
        operation: "fixture.runs.create",
        active,
        starts,
        caps: { active: 2, startsPerDay: 3 },
        phase: "start",
      });
      if (Result.isOk(refused)) {
        panic("The fixture must reach the cap");
      }
      const refusal = modelRunCapRefusal(refused.error);
      expect(refusal).toMatchObject({
        status: 429,
        code: MODEL_RUN_CAP_CODES[reason],
        retryable: true,
        hint: refused.error.hint,
        message: refused.error.message,
      });
      messages.add(refusal.message);
    }
  }
  expect(messages.size).toBe(MODEL_RUN_KINDS.length * 2);
});
