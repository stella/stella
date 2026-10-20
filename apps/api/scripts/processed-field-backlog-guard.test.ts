import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  admittedNewSourcePairs,
  backlogPairs,
  declaredNewSourcePairs,
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

const NEW_SOURCE_PAIR =
  "skipped:not-extracted|new-source|court-paragraph-numbers";

const declaring = (declaration: unknown) => ({
  ...baseline,
  newSourceDeclarations: { "new-source": declaration },
});

const DECLARED = declaredNewSourcePairs(
  declaring({
    owner: "pr-closer-org",
    followUp: "stella#1",
    pairs: ["skipped:not-extracted|court-paragraph-numbers"],
  }),
  "test",
);

describe("new-source declarations", () => {
  test("a source the base does not register enters with the debt it declares", () => {
    expect(
      admittedNewSourcePairs({
        grown: [NEW_SOURCE_PAIR],
        declared: DECLARED,
        isRegisteredAtBase: () => false,
      }),
    ).toEqual([NEW_SOURCE_PAIR]);
  });

  test("a source the base registers never grows, declared or not", () => {
    expect(
      admittedNewSourcePairs({
        grown: [NEW_SOURCE_PAIR],
        declared: DECLARED,
        isRegisteredAtBase: () => true,
      }),
    ).toEqual([]);
  });

  test("an undeclared pair of a new source is still growth", () => {
    expect(
      admittedNewSourcePairs({
        grown: ["unrecorded|new-source|court-paragraph-numbers"],
        declared: DECLARED,
        isRegisteredAtBase: () => false,
      }),
    ).toEqual([]);
  });

  test("a declaration names its owner and its follow-up", () => {
    expect(() =>
      declaredNewSourcePairs(
        declaring({ owner: "pr-closer-org", pairs: [] }),
        "test",
      ),
    ).toThrow(
      "newSourceDeclarations.new-source needs owner, followUp and pairs",
    );
  });
});

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
    // Past the bootstrap list, only what a new source declared it enters with.
    const declared = [
      ...declaredNewSourcePairs(
        committed,
        PROCESSED_FIELD_BACKLOG_FILE,
      ).values(),
    ].flat();
    expect(
      grownPairs({ current, base: referencePairs(undefined) }).filter(
        (pair) => !declared.includes(pair),
      ),
    ).toEqual([]);
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
