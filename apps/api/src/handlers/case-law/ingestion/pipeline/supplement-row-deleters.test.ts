import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";

import { caseLawDecisionSupplements } from "@/api/db/schema";
import { SUPPLEMENT_ROW_DELETERS } from "@/api/handlers/case-law/ingestion/pipeline/supplement-types";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../../../../..");
/** Every TypeScript tree that can reach the database: apps, packages, scripts. */
const SOURCES = [
  "apps/*/src/**/*.ts",
  "packages/*/src/**/*.ts",
  "scripts/**/*.ts",
];

/**
 * A delete of supplement rows: the query builder on the table (however its
 * module is named), or SQL naming the table directly or through the
 * builder's interpolation, as a DELETE or a TRUNCATE.
 */
const DELETES_SUPPLEMENT_ROWS =
  /\.delete\(\s*(?:\w+\.)?caseLawDecisionSupplements\b|(?:DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:(?:"?public"?\.)?"?case_law_decision_supplements"?\b|\$\{\s*(?:\w+\.)?caseLawDecisionSupplements\s*\})/iu;

/** An alias would hide the table from the pattern above. */
const ALIASES_SUPPLEMENT_TABLE = /\bcaseLawDecisionSupplements\s+as\s+\w/u;

const isTest = (file: string): boolean =>
  /\.(?:test|spec)\.ts$/u.test(file) || file.includes("/tests/");

test("only the erasure and takedown paths delete supplement rows", async () => {
  const deleters: string[] = [];
  const aliases: string[] = [];
  for (const pattern of SOURCES) {
    for await (const file of new Bun.Glob(pattern).scan({ cwd: REPO_ROOT })) {
      if (isTest(file) || file.includes("/node_modules/")) {
        continue;
      }
      // db-await-in-loop: not a database read; one source file at a time.
      const text = await readFile(path.join(REPO_ROOT, file), "utf-8");
      if (DELETES_SUPPLEMENT_ROWS.test(text)) {
        deleters.push(file);
      }
      if (ALIASES_SUPPLEMENT_TABLE.test(text)) {
        aliases.push(file);
      }
    }
  }
  expect(aliases).toEqual([]);
  // A new deleter must be an erasure or a takedown, or the `removed`
  // supplement disposition no longer holds: list it with that reason, or
  // give the supplement step a disposition for it.
  expect(deleters.toSorted()).toEqual([...SUPPLEMENT_ROW_DELETERS].toSorted());
});

test.each([
  ["await tx.delete(caseLawDecisionSupplements)", true],
  ["await tx.delete(schema.caseLawDecisionSupplements)", true],
  ['DELETE FROM "public"."case_law_decision_supplements" WHERE', true],
  // The source text of a builder interpolation, as the scan reads it.
  [`sql\`DELETE FROM \${caseLawDecisionSupplements} WHERE\``, true],
  ["TRUNCATE TABLE case_law_decision_supplements", true],
  ["tx.select().from(caseLawDecisionSupplements)", false],
  ["DELETE FROM case_law_decision_supplements_history", false],
  ["await tx.delete(caseLawDecisionSupplementsHistory)", false],
] as const)("the census reads %j as a delete: %p", (text, deletes) => {
  expect(DELETES_SUPPLEMENT_ROWS.test(text)).toBe(deletes);
});

// The database deletes rows too. A source's removal takes its supplements
// with it, and the supplement step of that source has nothing left to place
// into. A decision's removal only detaches the rows it held, which the step
// reads as detached, never as removed. Any other foreign-key action would
// remove rows the census above cannot see.
test("the database removes supplement rows only with their source", () => {
  const actions = getTableConfig(caseLawDecisionSupplements).foreignKeys.map(
    (foreignKey) => {
      const reference = foreignKey.reference();
      return {
        columns: reference.columns.map(({ name }) => name),
        target: getTableConfig(reference.foreignTable).name,
        onDelete: foreignKey.onDelete,
      };
    },
  );
  expect(
    actions.toSorted((left, right) =>
      compareCodeUnit(left.target, right.target),
    ),
  ).toEqual([
    {
      columns: ["decision_id"],
      target: "case_law_decisions",
      onDelete: "set null",
    },
    { columns: ["source_id"], target: "case_law_sources", onDelete: "cascade" },
  ]);
});
