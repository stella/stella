import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-unguarded-case-law-replay-write";
const sourcePath = "apps/api/src/handlers/case-law/ingestion/listing-census.ts";
const lint = async (source: string) =>
  await lintSingleRule(RULE, source, { sourcePath });
const imports =
  'import { replayWrite as plan } from "@/api/lib/case-law/replay-write"; import { and } from "drizzle-orm";\n';

describe.serial(RULE, () => {
  test("a mutation without the owner's predicate is rejected", async () => {
    expect(await lint("await tx.update(rows).set({ value });")).toEqual([1]);
    expect(
      await lint(
        `${
          imports
        }const write = plan(rows, { value });\nawait tx.update(rows).set(write.set).where(eq(rows.id,id));`,
      ),
    ).toEqual([3]);
    expect(
      await lint(
        `${
          imports
        }const write = plan(rows, { value });\nawait tx.update(rows).set(write.set).where(and(eq(rows.id,id),write.setWhere));`,
      ),
    ).toEqual([]);
  });
  test("the predicate must belong to the effective SET being written", async () => {
    expect(
      await lint(
        `${
          imports
        }const first = plan(rows,{value}); const second = plan(rows,{other});\nawait tx.update(rows).set(first.set).where(second.setWhere);`,
      ),
    ).toEqual([3]);
  });
  test("upserts cannot override the coupled SET or predicate", async () => {
    expect(
      await lint(
        `${
          imports
        }const write = plan(rows, { value });\nawait tx.insert(rows).values(input).onConflictDoUpdate({target:rows.id,...write});`,
      ),
    ).toEqual([]);
    expect(
      await lint(
        `${
          imports
        }const write = plan(rows, { value });\nawait tx.insert(rows).values(input).onConflictDoUpdate({target:rows.id,...write,setWhere:sql\`true\`});`,
      ),
    ).toEqual([3]);
    expect(
      await lint(
        `${
          imports
        }const write = plan(rows, { value });\nawait tx.insert(rows).values(input).onConflictDoUpdate({target:rows.id,...write,set:{other}});`,
      ),
    ).toEqual([3]);
  });
  test("a shadowed plan or an OR does not establish a changed-only write", async () => {
    expect(
      await lint(
        `${
          imports
        }const write = plan(rows, { value });\nfunction bad(write) { return tx.update(rows).set(write.set).where(write.setWhere); }`,
      ),
    ).toEqual([3]);
    expect(
      await lint(
        `${
          imports
        }const write = plan(rows, { value });\nawait tx.update(rows).set(write.set).where(or(write.setWhere,sql\`true\`));`,
      ),
    ).toEqual([3]);
  });
  test("raw SQL writes and overwritten predicates fail the guard", async () => {
    expect(
      await lint(
        'import { sql } from "drizzle-orm";\nawait tx.execute(sql`UPDATE rows SET value = ' +
          "$" +
          "{value}`);",
      ),
    ).toEqual([2]);
  });
  test("serialized raw updates cannot compare a different SET", async () => {
    expect(
      await lint(
        `${
          imports
        }import {sql} from "drizzle-orm";\nconst write = plan(rows,{value}); const query = new PgDialect().sqlToQuery(sql\`UPDATE rows SET other = 1 WHERE ${"$"}{write.setWhere}\`);\nawait tx.execute(query.sql,query.params);`,
      ),
    ).toEqual([4]);
  });
  test("an unguarded mutation of a converted source fails and restoration passes", async () => {
    const root = path.resolve(import.meta.dir, "../..");
    const original = readFileSync(path.join(root, sourcePath), "utf-8");
    const marker =
      "  // audit: skip — public case-law corpus bookkeeping, no workspace data";
    expect(original.includes(marker)).toBe(true);
    const mutated = original.replace(
      marker,
      () =>
        `  await tx.update(caseLawSources).set({ storedTotal: 0 }).where(eq(caseLawSources.id, sourceId));\n${
          marker
        }`,
    );
    expect(mutated).not.toBe(original);
    expect(await lint(original)).toEqual([]);
    expect((await lint(mutated)).length).toBeGreaterThan(0);
    expect(await lint(original)).toEqual([]);
  });
});
