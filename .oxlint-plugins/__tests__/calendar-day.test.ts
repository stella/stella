import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const PLUGIN = "calendar-day";

describe.serial("calendar-day/no-utc-user-day", () => {
  const RULE = "no-utc-user-day";

  test("rejects UTC calendar-day reads outside the ledger", async () => {
    expect(
      await lintSingleRule(
        RULE,
        [
          'import { Temporal, todayFor } from "@stll/time";',
          "declare const createdAt: Date;",
          'export const a = Temporal.Now.plainDateISO("UTC");',
          'export const b = todayFor("UTC");',
          "export const c = createdAt.toISOString().slice(0, 10);",
          "export const d = createdAt.getUTCDate();",
        ].join("\n"),
        { plugin: PLUGIN },
      ),
    ).toEqual([3, 4, 5, 6]);
  });

  test("permits the user's zone", async () => {
    expect(
      await lintSingleRule(
        RULE,
        [
          'import { Temporal, todayFor } from "@stll/time";',
          "declare const viewerZone: string;",
          "export const a = todayFor(viewerZone);",
          "export const b = Temporal.Now.plainDateISO(viewerZone);",
        ].join("\n"),
        { plugin: PLUGIN },
      ),
    ).toEqual([]);
  });
});

describe.serial("calendar-day/no-wall-clock-scheduler-decision", () => {
  const RULE = "no-wall-clock-scheduler-decision";

  test("rejects wall-clock reads outside the ledger", async () => {
    expect(
      await lintSingleRule(
        RULE,
        [
          'import { Temporal } from "@stll/time";',
          "export const a = new Date();",
          "export const b = Date.now();",
          "export const c = Temporal.Now.instant();",
        ].join("\n"),
        { plugin: PLUGIN },
      ),
    ).toEqual([2, 3, 4]);
  });

  test("permits decisions on the due slot", async () => {
    expect(
      await lintSingleRule(
        RULE,
        [
          'import { Temporal } from "@stll/time";',
          "declare const viewerZone: string;",
          "declare const dueAt: { instant: Temporal.Instant; dayIn: (zone: string) => Temporal.PlainDate };",
          "export const a = dueAt.dayIn(viewerZone);",
          "export const b = new Date(dueAt.instant.epochMilliseconds);",
        ].join("\n"),
        { plugin: PLUGIN },
      ),
    ).toEqual([]);
  });
});
