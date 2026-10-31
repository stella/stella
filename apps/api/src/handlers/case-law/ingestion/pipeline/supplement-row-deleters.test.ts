import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { SUPPLEMENT_ROW_DELETERS } from "@/api/handlers/case-law/ingestion/pipeline/supplement-types";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../../../../..");
const API_SOURCES = "apps/api/src/**/*.ts";

/** A delete of supplement rows, through the query builder or in SQL. */
const DELETES_SUPPLEMENT_ROWS =
  /\.delete\(\s*caseLawDecisionSupplements\s*\)|DELETE\s+FROM\s+(?:"?public"?\.)?"?case_law_decision_supplements"?/iu;

const isTest = (file: string): boolean =>
  /\.(?:test|spec)\.ts$/u.test(file) || file.includes("/tests/");

test("only the erasure and takedown paths delete supplement rows", async () => {
  const deleters: string[] = [];
  for await (const file of new Bun.Glob(API_SOURCES).scan({
    cwd: REPO_ROOT,
  })) {
    if (isTest(file)) {
      continue;
    }
    // db-await-in-loop: not a database read; one source file at a time.
    const text = await readFile(path.join(REPO_ROOT, file), "utf-8");
    if (DELETES_SUPPLEMENT_ROWS.test(text)) {
      deleters.push(file);
    }
  }
  // A new deleter must be an erasure or a takedown, or the `removed`
  // supplement disposition no longer holds: list it with that reason, or
  // give the supplement step a disposition for it.
  expect(deleters.toSorted()).toEqual([...SUPPLEMENT_ROW_DELETERS].toSorted());
});

test("the census sees both ways a delete is written", () => {
  expect(
    DELETES_SUPPLEMENT_ROWS.test("await tx.delete(caseLawDecisionSupplements)"),
  ).toBe(true);
  expect(
    DELETES_SUPPLEMENT_ROWS.test(
      'DELETE FROM "public"."case_law_decision_supplements" WHERE',
    ),
  ).toBe(true);
  expect(
    DELETES_SUPPLEMENT_ROWS.test(
      "tx.select().from(caseLawDecisionSupplements)",
    ),
  ).toBe(false);
});
