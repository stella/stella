import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  backlogPairs,
  grownPairs,
  PROCESSED_FIELD_BACKLOG_FILE,
  referencePairs,
} from "./processed-field-backlog-guard";

const baseline = {
  comment: "x",
  skipped: {
    "not-extracted": { "pl-nsa": ["court-paragraph-numbers"] },
    unassessed: { "pl-sn": ["court-paragraph-numbers"] },
  },
  unrecorded: { "pl-sn": ["court-paragraph-numbers"] },
};

describe("processed-field backlog guard", () => {
  test("reads every pair, keyed by the list it is on", () => {
    expect(backlogPairs(baseline, "test")).toEqual([
      "skipped:not-extracted|pl-nsa|court-paragraph-numbers",
      "skipped:unassessed|pl-sn|court-paragraph-numbers",
      "unrecorded|pl-sn|court-paragraph-numbers",
    ]);
  });

  test("a pair the base did not list is growth, wherever it is added", () => {
    const base = backlogPairs(baseline, "base");
    const grownSkip = {
      ...baseline,
      skipped: {
        ...baseline.skipped,
        unassessed: {
          ...baseline.skipped.unassessed,
          "at-vfgh": ["court-paragraph-numbers"],
        },
      },
    };
    expect(
      grownPairs({ current: backlogPairs(grownSkip, "head"), base }),
    ).toEqual(["skipped:unassessed|at-vfgh|court-paragraph-numbers"]);
    // Moving a pair to another list is growth on the list it moved to.
    const moved = {
      ...baseline,
      skipped: {
        "not-extracted": {},
        unassessed: {
          "pl-sn": ["court-paragraph-numbers"],
          "pl-nsa": ["court-paragraph-numbers"],
        },
      },
    };
    expect(grownPairs({ current: backlogPairs(moved, "head"), base })).toEqual([
      "skipped:unassessed|pl-nsa|court-paragraph-numbers",
    ]);
  });

  test("removing pairs is never growth", () => {
    const base = backlogPairs(baseline, "base");
    const shrunk = { ...baseline, unrecorded: {} };
    expect(grownPairs({ current: backlogPairs(shrunk, "head"), base })).toEqual(
      [],
    );
  });

  test("the committed baseline parses", () => {
    const committed: unknown = JSON.parse(
      readFileSync(
        path.join(
          import.meta.dir,
          "..",
          "..",
          "..",
          PROCESSED_FIELD_BACKLOG_FILE,
        ),
        "utf-8",
      ),
    );
    expect(
      backlogPairs(committed, PROCESSED_FIELD_BACKLOG_FILE).length,
    ).toBeGreaterThan(0);
  });

  test("without a base file, the bootstrap backlog is the reference", () => {
    const committed: unknown = JSON.parse(
      readFileSync(
        path.join(
          import.meta.dir,
          "..",
          "..",
          "..",
          PROCESSED_FIELD_BACKLOG_FILE,
        ),
        "utf-8",
      ),
    );
    const current = backlogPairs(committed, PROCESSED_FIELD_BACKLOG_FILE);
    expect(grownPairs({ current, base: referencePairs(undefined) })).toEqual(
      [],
    );
    expect(
      grownPairs({
        current: [
          ...current,
          "skipped:unassessed|eu-ecj|court-paragraph-numbers",
        ],
        base: referencePairs(undefined),
      }),
    ).toEqual(["skipped:unassessed|eu-ecj|court-paragraph-numbers"]);
    // A base file, once there, is the reference instead.
    expect(referencePairs([])).toEqual([]);
  });

  test("a malformed list fails with its name", () => {
    expect(() =>
      backlogPairs({ skipped: { unassessed: { x: "y" } } }, "bad"),
    ).toThrow("skipped:unassessed is not a map of source to field names");
  });
});
