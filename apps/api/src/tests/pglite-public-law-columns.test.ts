import { expect, test } from "bun:test";
import { getColumns, getTableName } from "drizzle-orm";

import { legislationAmendments } from "@/api/db/schema";
import { PUBLIC_LAW_COLUMN_GRANTS_BY_RELATION } from "@/api/lib/public-law-relations";
import { grantedPublicLawColumns } from "@/api/tests/pglite-test-db";

test.each(["permitted", "required"] as const)(
  "an installed %s column is granted without exposing undeclared columns",
  (grant) => {
    expect(
      grantedPublicLawColumns(
        "fixture",
        { reviewed: grant },
        new Set(["reviewed", "private_fixture"]),
      ),
    ).toEqual(["reviewed"]);
  },
);

test.each([
  { extent: "absent relation", installed: undefined },
  { extent: "absent column", installed: new Set(["private_fixture"]) },
])("$extent does not require a permitted column", ({ installed }) => {
  expect(
    grantedPublicLawColumns("fixture", { reviewed: "permitted" }, installed),
  ).toEqual([]);
});

test.each([
  { extent: "absent relation", installed: undefined },
  { extent: "absent column", installed: new Set(["private_fixture"]) },
])("$extent cannot silently omit a required column", ({ installed }) => {
  expect(() =>
    grantedPublicLawColumns("fixture", { reviewed: "required" }, installed),
  ).toThrow("Required public-law fixture column is absent: fixture.reviewed");
});

test("amendment evidence grants follow the installed expansion stage", () => {
  const relation = getTableName(legislationAmendments);
  const declared = PUBLIC_LAW_COLUMN_GRANTS_BY_RELATION.legislation_amendments;
  const before = new Set(
    Object.values(getColumns(legislationAmendments)).map(({ name }) => name),
  );
  expect(before.has("effect_details")).toBe(false);
  expect(before.has("observations")).toBe(false);
  const beforeGrants = grantedPublicLawColumns(relation, declared, before);
  expect(beforeGrants).not.toContain("effect_details");
  expect(beforeGrants).not.toContain("observations");

  const after = new Set([
    ...before,
    "effect_details",
    "observations",
    "private_fixture",
  ]);
  const afterGrants = grantedPublicLawColumns(relation, declared, after);
  expect(afterGrants).toContain("effect_details");
  expect(afterGrants).toContain("observations");
  expect(afterGrants).not.toContain("private_fixture");
});
