import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { CASE_LAW_JURISDICTIONS } from "@stll/api-contract/case-law-jurisdictions";

import {
  provisionAnchorLineage,
  provisionAnchorNesting,
} from "@/api/lib/case-law/provision-anchor-lineage";

const DRIZZLE_ROOT = nodePath.resolve(import.meta.dir, "../../../drizzle");

const LINEAGE_FUNCTION =
  'CREATE OR REPLACE FUNCTION "case_law_provision_anchor_lineage"';

/** The CASE that names each jurisdiction's separator in the function body. */
const SEPARATOR_CASE =
  /CASE target_jurisdiction((?:\s+WHEN '[^']+' THEN '[^']+')+)\s+END AS separator/gu;
const SEPARATOR_WHEN =
  /WHEN '(?<jurisdiction>[^']+)' THEN '(?<separator>[^']+)'/gu;

/**
 * The separator each jurisdiction nests on in the function body the last
 * migration that defines it installs: migrations apply in directory order,
 * so the last definition is the one the database runs.
 */
const storedSeparators = (): Record<string, string> => {
  const definitions = [
    ...new Bun.Glob("*/migration.sql").scanSync({ cwd: DRIZZLE_ROOT }),
  ]
    .toSorted()
    .map((file) => readFileSync(nodePath.join(DRIZZLE_ROOT, file), "utf-8"))
    .filter((sql) => sql.includes(LINEAGE_FUNCTION));
  const body = definitions.at(-1)?.split(LINEAGE_FUNCTION).at(-1) ?? "";
  const cases = [...body.matchAll(SEPARATOR_CASE)];
  expect(cases.length).toBe(1);
  return Object.fromEntries(
    [...(cases.at(0)?.[1] ?? "").matchAll(SEPARATOR_WHEN)].map(({ groups }) => [
      groups?.["jurisdiction"],
      groups?.["separator"],
    ]),
  );
};

describe("provision anchor lineage", () => {
  test("the stored function nests each jurisdiction on its scheme's separator", () => {
    const nested: Record<string, string> = {};
    for (const jurisdiction of CASE_LAW_JURISDICTIONS) {
      const nesting = provisionAnchorNesting(jurisdiction);
      if (nesting.type === "nested") {
        nested[jurisdiction] = nesting.separator;
      }
    }
    // A scheme that nests no jurisdiction would make the comparison vacuous.
    expect(Object.keys(nested).length).toBeGreaterThan(0);
    expect(storedSeparators()).toEqual(nested);
  });

  test("a jurisdiction no grammar mints anchors for reads them whole", () => {
    expect(provisionAnchorNesting("SVK")).toEqual({ type: "flat" });
    expect(
      provisionAnchorLineage({
        jurisdiction: "SVK",
        anchor: "paragraf-5.odsek-1",
      }),
    ).toEqual(["paragraf-5.odsek-1"]);
  });

  test("a jurisdiction outside the case-law list is a bug", () => {
    expect(() =>
      provisionAnchorLineage({ jurisdiction: "ZZZ", anchor: "par_1" }),
    ).toThrow('No provision citation grammar for "ZZZ".');
  });
});
