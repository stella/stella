import { describe, expect, test } from "bun:test";

import {
  buildProvisionVersionRows,
  groupWordingRuns,
  isRunStartKnown,
  previousWordingVersion,
  runWindow,
} from "@/features/statutes/provision-version-runs.logic";
import type { ProvisionWordingChange } from "@/features/statutes/provision-version-runs.logic";

const found = (documentId: string, wordingChange: ProvisionWordingChange) => ({
  documentId,
  status: "found" as const,
  wordingChange,
});
const unavailable = (documentId: string) => ({
  documentId,
  status: "unavailable" as const,
});
const version = (
  id: string,
  versionValidFrom: string,
  versionValidTo: string | null = null,
) => ({ id, versionValidFrom, versionValidTo });

describe("runs of one wording", () => {
  test("a wording the next consolidations kept stays one run until the version that changed it", () => {
    const groups = groupWordingRuns([
      found("d", "unchanged"),
      found("c", "changed"),
      found("b", "unchanged"),
      found("a", "earliest"),
    ]);

    expect(
      groups.map((group) =>
        group.type === "run"
          ? [group.start, group.members.map((member) => member.documentId)]
          : group.type,
      ),
    ).toEqual([
      ["changed", ["d", "c"]],
      ["earliest", ["b", "a"]],
    ]);
  });

  test("a version without readable text is never part of a run on either side", () => {
    const groups = groupWordingRuns([
      found("c", "unknown"),
      unavailable("b"),
      found("a", "earliest"),
    ]);

    expect(groups.map((group) => group.type)).toEqual([
      "run",
      "unavailable",
      "run",
    ]);
    expect(groups.at(0)).toMatchObject({ start: "unknown" });
  });

  test("a run whose start lies past what was read does not claim where it started", () => {
    const groups = groupWordingRuns([
      found("b", "changed"),
      found("a", "unchanged"),
    ]);

    expect(groups.at(-1)).toMatchObject({ type: "run", start: null });
  });

  test("paging the history differently folds it into the same runs", () => {
    const items = [
      found("f", "unchanged"),
      found("e", "changed"),
      unavailable("d"),
      found("c", "unchanged"),
      found("b", "unchanged"),
      found("a", "added"),
    ];
    const whole = groupWordingRuns(items);
    for (let size = 1; size <= items.length; size += 1) {
      const pages = Array.from(
        { length: Math.ceil(items.length / size) },
        (_, index) => items.slice(index * size, (index + 1) * size),
      );
      expect(groupWordingRuns(pages.flat())).toEqual(whole);
    }
  });
});

describe("the act's versions grouped by one provision", () => {
  const versions = [
    version("v5", "2024-01-01"),
    version("v4", "2023-01-01", "2023-12-31"),
    version("v3", "2022-01-01", "2022-12-31"),
    version("v2", "2021-01-01", "2021-12-31"),
    version("v1", "2020-01-01", "2020-12-31"),
  ];

  test("versions the history leaves out do not carry the provision, and fold together", () => {
    const rows = buildProvisionVersionRows({
      history: {
        complete: true,
        items: [found("v5", "unchanged"), found("v4", "added")],
      },
      versions,
    });

    expect(
      rows.map((row) =>
        row.type === "run" || row.type === "absent"
          ? [row.type, row.members.map((member) => member.id)]
          : [row.type, [row.version.id]],
      ),
    ).toEqual([
      ["run", ["v5", "v4"]],
      ["absent", ["v3", "v2", "v1"]],
    ]);
  });

  test("past what a bounded read reached, versions are listed without a claim", () => {
    const rows = buildProvisionVersionRows({
      history: {
        complete: false,
        items: [found("v5", "changed"), found("v4", "unchanged")],
      },
      versions,
    });

    expect(rows.map((row) => row.type)).toEqual([
      "run",
      "run",
      "unread",
      "unread",
      "unread",
    ]);
    expect(rows.at(1)).toMatchObject({ start: null });
  });

  test("a changed run compares with the version just before its oldest member", () => {
    const rows = buildProvisionVersionRows({
      history: {
        complete: true,
        items: [
          found("v5", "unchanged"),
          found("v4", "changed"),
          found("v3", "earliest"),
        ],
      },
      versions: versions.slice(0, 3),
    });
    const [newer, older] = rows;
    if (newer?.type !== "run" || older?.type !== "run") {
      throw new Error("Expected two runs");
    }

    expect(previousWordingVersion(newer, versions)?.id).toBe("v3");
    // The earliest wording on record has nothing before it to compare with.
    expect(previousWordingVersion(older, versions)).toBeNull();
  });
});

describe("the window a run covers", () => {
  const isFuture = (member: { versionValidFrom: string }) =>
    member.versionValidFrom > "2026-11-18";

  test("a later version that keeps the wording leaves the window open and is named apart", () => {
    expect(
      runWindow(
        [
          version("future", "2027-09-01"),
          version("now", "2022-01-01", "2027-08-31"),
          version("older", "2020-01-01", "2021-12-31"),
        ],
        isFuture,
      ),
    ).toEqual({
      type: "window",
      from: "2020-01-01",
      to: null,
      count: 2,
      alsoFrom: "2027-09-01",
    });
  });

  test("a run only of versions not yet in force is a coming change", () => {
    expect(runWindow([version("future", "2027-09-01")], isFuture)).toEqual({
      type: "future",
      from: "2027-09-01",
    });
  });
});

describe("where a run's wording began", () => {
  test("only a compared start is known; an unread or unreadable neighbour leaves it open", () => {
    expect(isRunStartKnown("changed")).toBe(true);
    expect(isRunStartKnown("added")).toBe(true);
    expect(isRunStartKnown("earliest")).toBe(true);
    expect(isRunStartKnown("unknown")).toBe(false);
    expect(isRunStartKnown(null)).toBe(false);
  });
});
