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

test("amendment evidence requires installed columns without granting private fields", () => {
  const relation = getTableName(legislationAmendments);
  const declared = PUBLIC_LAW_COLUMN_GRANTS_BY_RELATION.legislation_amendments;
  const installed = new Set(
    Object.values(getColumns(legislationAmendments)).map(({ name }) => name),
  );
  expect(installed.has("effect_details")).toBe(true);
  expect(installed.has("observations")).toBe(true);
  installed.add("private_fixture");
  const grants = grantedPublicLawColumns(relation, declared, installed);
  expect(grants).toContain("effect_details");
  expect(grants).toContain("observations");
  expect(grants).not.toContain("private_fixture");
  installed.delete("effect_details");
  expect(() => grantedPublicLawColumns(relation, declared, installed)).toThrow(
    "Required public-law fixture column is absent: legislation_amendments.effect_details",
  );
});
