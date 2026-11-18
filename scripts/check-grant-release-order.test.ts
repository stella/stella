import { describe, expect, test } from "bun:test";

import {
  findPrematureRequiredGrants,
  formatPrematureRequiredGrant,
  relativeImports,
  selectProductionTag,
  staleAllowances,
} from "./check-grant-release-order.ts";

const RELEASED = {
  case_law_citations: { id: "required", cited_part: "permitted" },
} as const;

describe("findPrematureRequiredGrants", () => {
  test("a column that arrives required fails", () => {
    expect(
      findPrematureRequiredGrants(
        {
          case_law_citations: {
            ...RELEASED.case_law_citations,
            kind: "required",
          },
          case_law_judges: { id: "required" },
        },
        RELEASED,
      ),
    ).toEqual([
      { relation: "case_law_citations", column: "kind" },
      { relation: "case_law_judges", column: "id" },
    ]);
  });

  test("a column that arrives permitted passes", () => {
    expect(
      findPrematureRequiredGrants(
        {
          case_law_citations: {
            ...RELEASED.case_law_citations,
            kind: "permitted",
          },
          case_law_judges: { id: "permitted" },
        },
        RELEASED,
      ),
    ).toEqual([]);
  });

  test("a column the release permits may become required", () => {
    expect(
      findPrematureRequiredGrants(
        { case_law_citations: { id: "required", cited_part: "required" } },
        RELEASED,
      ),
    ).toEqual([]);
  });

  test("removing a column or a relation passes", () => {
    expect(
      findPrematureRequiredGrants(
        { case_law_citations: { id: "required" } },
        RELEASED,
      ),
    ).toEqual([]);
    expect(findPrematureRequiredGrants({}, RELEASED)).toEqual([]);
  });

  test("an allowance names the only column it excuses", () => {
    const allowances = [
      {
        relation: "case_law_citations",
        column: "kind",
        pr: 1,
        reason: "fixture",
      },
    ];
    expect(
      findPrematureRequiredGrants(
        {
          case_law_citations: {
            ...RELEASED.case_law_citations,
            kind: "required",
            polarity: "required",
          },
        },
        RELEASED,
        allowances,
      ),
    ).toEqual([{ relation: "case_law_citations", column: "polarity" }]);
    expect(staleAllowances(RELEASED, allowances)).toEqual([]);
    expect(
      staleAllowances(
        { case_law_citations: { kind: "permitted" } },
        allowances,
      ),
    ).toEqual(allowances);
  });
});

test("the failure names the column and the two-release fix", () => {
  const message = formatPrematureRequiredGrant(
    { relation: "case_law_citations", column: "kind" },
    "v1.2.3",
  );
  expect(message).toContain("case_law_citations.kind");
  expect(message).toContain("v1.2.3");
  expect(message).toContain('Ship it as "permitted" first');
  expect(message).toContain("after the next production release");
});

describe("selectProductionTag", () => {
  test("takes the newest final release, never a candidate", () => {
    expect(
      selectProductionTag(
        ["v0.9.9", "v0.9.86-rc.1", "v0.9.85", "v0.9.85-rc.1", "v0.10.0-rc.1"],
        () => true,
      ),
    ).toBe("v0.9.85");
  });

  test("skips tags that share no history with HEAD", () => {
    expect(
      selectProductionTag(["v2.9.0", "v0.9.85"], (tag) => tag !== "v2.9.0"),
    ).toBe("v0.9.85");
    expect(selectProductionTag(["v1.0.0-rc.1"], () => true)).toBeUndefined();
  });
});

test("follows relative imports and re-exports only", () => {
  expect(
    relativeImports(
      [
        'import { panic } from "better-result";',
        'import { A } from "./case-law/review-column-grants.ts";',
        'export { B } from "../b";',
        'import "./side-effect.ts";',
        'const c = await import("./c.ts");',
      ].join("\n"),
    ),
  ).toEqual([
    "./case-law/review-column-grants.ts",
    "../b",
    "./side-effect.ts",
    "./c.ts",
  ]);
});
