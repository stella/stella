import { describe, expect, test } from "bun:test";

import { Temporal } from "@stll/time";

import { proposeBlocks, timedSegments } from "./activity-logic";
import { initialTimeEntry, localEntryBlock } from "./time-entry-form";

const blockAt = (durationMinutes: number) => {
  const blocks = proposeBlocks(
    timedSegments([
      {
        appIdentifier: "private.app.identifier",
        appName: "Private application name",
        start: "2026-03-10T08:00:00Z",
        end: Temporal.Instant.from("2026-03-10T08:00:00Z")
          .add({ milliseconds: durationMinutes * 60_000 })
          .toString(),
      },
    ]),
  );
  const block = blocks.at(0);
  if (!block) {
    throw new TypeError("Fixture must produce a nonempty block");
  }
  return block;
};

describe("confirmed activity entry defaults", () => {
  test("every block starts with empty narrative and only six billing fields", () => {
    for (const duration of [0.1, 1, 6, 6.1, 59, 60, 61, 120.5]) {
      const block = blockAt(duration);
      const entry = initialTimeEntry("2026-03-10", block);
      expect(Object.keys(entry).toSorted()).toEqual([
        "billable",
        "dateWorked",
        "durationMinutes",
        "narrative",
        "timezoneId",
        "workspaceId",
      ]);
      expect(entry.narrative).toBe("");
      expect(entry.billable).toBe(true);
      expect(entry.workspaceId).toBe("");
      expect(entry.dateWorked).toBe("2026-03-10");
      expect(entry.durationMinutes % 6).toBe(0);
      expect(entry.durationMinutes).toBeGreaterThanOrEqual(duration);
      expect(entry.durationMinutes - duration).toBeLessThan(6);
      expect(JSON.stringify(entry)).not.toContain("private");
    }
  });

  test("local block identity carries no application information", () => {
    expect(localEntryBlock("2026-03-10", blockAt(7))).toEqual({
      date: "2026-03-10",
      start: "2026-03-10T08:00:00Z",
      end: "2026-03-10T08:07:00Z",
    });
  });
});
