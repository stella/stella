import { describe, expect, test } from "bun:test";

import {
  censusColumnGrants,
  findPrematureRequiredGrants,
  findUndeclaredNewGrants,
  formatPrematureRequiredGrant,
  formatUndeclaredNewGrant,
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

describe("findUndeclaredNewGrants", () => {
  const releasedGranted = new Set(["case_law_citations.id"]);

  test("a new grant of a column the release never declared fails, even if permitted at HEAD", () => {
    expect(
      findUndeclaredNewGrants(
        new Set(["case_law_citations.id", "case_law_citations.kind"]),
        releasedGranted,
        RELEASED,
      ),
    ).toEqual([{ relation: "case_law_citations", column: "kind" }]);
  });

  test("a new grant of a column the release permits passes", () => {
    expect(
      findUndeclaredNewGrants(
        new Set(["case_law_citations.id", "case_law_citations.cited_part"]),
        releasedGranted,
        RELEASED,
      ),
    ).toEqual([]);
  });

  test("a grant the release already held, or a revoked grant, passes", () => {
    expect(
      findUndeclaredNewGrants(releasedGranted, releasedGranted, RELEASED),
    ).toEqual([]);
    expect(
      findUndeclaredNewGrants(new Set(), releasedGranted, RELEASED),
    ).toEqual([]);
  });

  test("an allowance excuses only its column", () => {
    expect(
      findUndeclaredNewGrants(
        new Set(["case_law_judges.id", "case_law_judges.slug"]),
        releasedGranted,
        RELEASED,
        [
          {
            relation: "case_law_judges",
            column: "id",
            pr: 1,
            reason: "fixture",
          },
        ],
      ),
    ).toEqual([{ relation: "case_law_judges", column: "slug" }]);
  });

  test("the failure names the column and the declare-first fix", () => {
    const message = formatUndeclaredNewGrant(
      { relation: "case_law_citations", column: "kind" },
      "v1.2.3",
    );
    expect(message).toContain("case_law_citations.kind");
    expect(message).toContain(
      'Declare it as "permitted" without the grant first',
    );
  });
});

describe("censusColumnGrants", () => {
  const census = {
    roles: [
      {
        role: "stella_public_law_reader",
        privileges: [
          "column:public.case_law_citations.id:SELECT:EFFECTIVE",
          "column:public.case_law_citations.id:SELECT:GRANTOR:census_admin:GRANTABLE:false",
          "table:public.case_law_citations:RLS_ENABLED:true",
        ],
      },
      {
        role: "stella_ingestion",
        privileges: ["column:public.case_law_sources.cursor:SELECT:EFFECTIVE"],
      },
    ],
  };

  test("reads the effective column grants of the governed role only", () => {
    expect([...censusColumnGrants(census)]).toEqual(["case_law_citations.id"]);
  });

  test("a census without the role fails instead of reading as no grants", () => {
    expect(() => censusColumnGrants({ roles: [] })).toThrow(
      "has no privileges for stella_public_law_reader",
    );
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
