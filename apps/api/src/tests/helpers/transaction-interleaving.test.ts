import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  enumerateInterleavings,
  withInterleaving,
} from "./transaction-interleaving";

test("enumeration contains every shuffle once and preserves both participant orders", () => {
  const schedules = enumerateInterleavings(
    ["read", "write", "commit"],
    ["read", "write", "commit"],
  );
  expect(schedules).toHaveLength(20);
  expect(new Set(schedules.map((schedule) => schedule.join(","))).size).toBe(
    20,
  );
  for (const schedule of schedules) {
    for (const actor of ["a", "b"] as const) {
      expect(schedule.filter((token) => token.startsWith(`${actor}.`))).toEqual(
        [`${actor}.read`, `${actor}.write`, `${actor}.commit`],
      );
    }
  }
  expect(enumerateInterleavings([], ["commit"])).toEqual([["b.commit"]]);
});

test("invalid and empty schedule selections fail before opening a database", async () => {
  const options = {
    databaseUrl: "postgres://invalid.test/unused",
    a: { steps: [] },
    b: { steps: [] },
    reset: async () => {},
    readState: async () => null,
    invariant: () => {},
  };
  expect(
    await rejectionOf(withInterleaving({ ...options, schedules: [] })),
  ).toMatchObject({ message: "Interleaving requires at least one schedule" });
  expect(
    await rejectionOf(
      withInterleaving({
        ...options,
        schedules: [["b.commit", "a.commit", "a.extra"]],
      }),
    ),
  ).toMatchObject({ message: "Schedule contains unexpected steps" });
  expect(
    await rejectionOf(
      withInterleaving({ ...options, schedules: [["a.commit", "a.commit"]] }),
    ),
  ).toMatchObject({
    message: expect.stringContaining("Schedule must contain every step"),
  });
});
