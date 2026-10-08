import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects global Date clock parsing and calendar construction", async () => {
  expect(
    await lintSingleRule(
      "prefer-temporal",
      "Date();\nDate.now();\nglobalThis.Date.parse(raw);\nnew Date(2026, 9, 7);",
    ),
  ).toEqual([1, 2, 3, 4]);
});

test("rejects stable constructor and static method aliases", async () => {
  expect(
    await lintSingleRule(
      "prefer-temporal",
      "const LegacyDate = Date;\nLegacyDate.now();\nconst readClock = Date.now;\nreadClock();",
    ),
  ).toEqual([2, 3, 4]);
});

test("rejects calendar mutations on proven Date values and typed parameters", async () => {
  expect(
    await lintSingleRule(
      "prefer-temporal",
      "const date = new Date(raw);\nconst alias = date;\nalias.setDate(7);\nfunction inspect(value: Date) { return value.getUTCMonth(); }",
    ),
  ).toEqual([3, 4]);
});

test("rejects ambient Temporal but accepts an explicit import", async () => {
  expect(
    await lintSingleRule(
      "prefer-temporal",
      "Temporal.Now.instant();\nglobalThis.Temporal.Now.instant();",
    ),
  ).toEqual([1, 2]);
});

test("accepts explicit Temporal and immediate database or protocol boundaries", async () => {
  expect(
    await lintSingleRule(
      "prefer-temporal",
      'import { Temporal } from "@stll/time";\nTemporal.Now.instant();\nnew Date(raw).toISOString();\nnew Date(raw).getTime();\nnew Date(0).toJSON();',
    ),
  ).toEqual([]);
});

test("does not confuse shadowed Date constructors or opaque objects with calendar APIs", async () => {
  expect(
    await lintSingleRule(
      "prefer-temporal",
      "function local(Date, value) { Date.now(); new Date(2026, 9, 7); value.setDate(7); }\nconst receiver = getOpaque();\nreceiver.getMonth();",
    ),
  ).toEqual([]);
});
