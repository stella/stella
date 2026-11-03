import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { indexRateEntries, selectEffectiveRateEntry } from "./rate-selection";

const selectors = [
  { userId: "person", role: null, activityCode: "A1" },
  { userId: null, role: "member", activityCode: "A1" },
  { userId: null, role: null, activityCode: "A1" },
  { userId: "person", role: null, activityCode: null },
  { userId: null, role: "member", activityCode: null },
  { userId: null, role: null, activityCode: null },
] as const;

const rows = selectors.map((selector, index) => ({
  ...selector,
  rateTableId: "table",
  hourlyRate: 600 - index * 100,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
}));

type TestEntry = Omit<(typeof rows)[number], "effectiveTo"> & {
  effectiveTo: string | null;
};

const resolve = (
  entries: readonly TestEntry[],
  activityCode: string | null = "A1",
) =>
  selectEffectiveRateEntry({
    entries: indexRateEntries(entries),
    rateTableId: "table",
    userId: "person",
    roles: ["member"],
    activityCode,
    dateWorked: "2026-06-01",
  });

for (const [index, name] of [
  "user plus activity",
  "role plus activity",
  "activity",
  "user",
  "role",
  "table default",
].entries()) {
  test(`resolves ${name} ahead of every less specific selector`, () => {
    expect(resolve(rows.slice(index))?.hourlyRate).toBe(600 - index * 100);
  });
}

test("no matching selector returns no rate", () => {
  expect(resolve([])).toBeUndefined();
  expect(resolve(rows, null)?.hourlyRate).toBe(300);
});

test("expired and future entries never shadow an effective fallback", () => {
  for (const dates of [
    { effectiveFrom: "2026-07-01", effectiveTo: null },
    { effectiveFrom: "2026-01-01", effectiveTo: "2026-05-31" },
  ]) {
    expect(
      resolve(
        rows.map((entry, index) =>
          index === 0 ? { ...entry, ...dates } : entry,
        ),
      )?.hourlyRate,
    ).toBe(500);
  }
});

test("activity precedence is invariant under subset and input ordering", () => {
  assertProperty(
    "activity precedence is invariant under subset and input ordering",
    fc.property(fc.shuffledSubarray(rows), (entries) => {
      const expected =
        entries.length === 0
          ? undefined
          : Math.max(...entries.map((entry) => entry.hourlyRate));
      expect(resolve(entries)?.hourlyRate).toBe(expected);
    }),
  );
});
