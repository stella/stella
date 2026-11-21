import { expect, test } from "bun:test";

import { runSingleRule } from "./lint-single-rule.ts";

const cases = [
  {
    title: "reports sparse totality claim Partial<Record<Kind, number>>",
    source:
      "const policy = { a: 1 } as const satisfies Partial<Record<Kind, number>>;",
    lines: [1],
    sourcePath: "source.ts",
  },
  {
    title:
      "reports sparse totality claim Readonly<Partial<Record<Kind, number>>>",
    source:
      "const policy = { a: 1 } as const satisfies Readonly<Partial<Record<Kind, number>>>;",
    lines: [1],
    sourcePath: "source.ts",
  },
  {
    title:
      "reports sparse totality claim Partial<Readonly<Record<Kind, number>>>",
    source:
      "const policy = { a: 1 } as const satisfies Partial<Readonly<Record<Kind, number>>>;",
    lines: [1],
    sourcePath: "source.ts",
  },
  {
    title: "allows total policies and sparse annotations",
    source:
      "const policy = { a: 1 } as const satisfies Record<Kind, number>;\nconst overrides: Partial<Record<Kind, number>> = {};",
    lines: [],
    sourcePath: "source.ts",
  },
];

test.each(cases)(
  "no-partial-record-satisfies: $title",
  async ({ source, lines, sourcePath }) => {
    expect(
      (
        await runSingleRule("no-partial-record-satisfies", source, {
          sourcePath,
        })
      ).lines,
    ).toEqual(lines);
  },
);

test("rejects a bare sparse object claiming total classification", async () => {
  expect(
    (
      await runSingleRule(
        "no-partial-record-satisfies",
        "const policy = { a: 1 } satisfies Partial<Record<Kind, number>>;",
      )
    ).lines,
  ).toEqual([1]);
});
