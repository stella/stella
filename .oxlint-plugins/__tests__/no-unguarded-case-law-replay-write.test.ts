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

/**
 * Lints every case concurrently: concurrent cases of one rule share a single
 * oxlint run, so a test costs one run instead of one per case.
 */
const expectLines = async (
  cases: readonly (readonly [string, readonly number[]])[],
): Promise<void> => {
  expect(
    await Promise.all(cases.map(async ([source]) => await lint(source))),
  ).toEqual(cases.map(([, lines]) => [...lines]));
};

describe.serial(RULE, () => {
  test("a mutation without the owner's predicate is rejected", async () => {
    await expectLines([
      ["await tx.update(rows).set({ value });", [1]],
      [
        `${
          imports
        }const write = plan(rows, { value });\nawait tx.update(rows).set(write.set).where(eq(rows.id,id));`,
        [3],
      ],
      [
        `${
          imports
        }const write = plan(rows, { value });\nawait tx.update(rows).set(write.set).where(and(eq(rows.id,id),write.setWhere));`,
        [],
      ],
    ]);
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
    await expectLines([
      [
        `${
          imports
        }const write = plan(rows, { value });\nawait tx.insert(rows).values(input).onConflictDoUpdate({target:rows.id,...write});`,
        [],
      ],
      [
        `${
          imports
        }const write = plan(rows, { value });\nawait tx.insert(rows).values(input).onConflictDoUpdate({target:rows.id,...write,setWhere:sql\`true\`});`,
        [3],
      ],
      [
        `${
          imports
        }const write = plan(rows, { value });\nawait tx.insert(rows).values(input).onConflictDoUpdate({target:rows.id,...write,set:{other}});`,
        [3],
      ],
    ]);
  });
  test("source-ordered conflict options cannot replace the plan through any later source", async () => {
    await expectLines([
      ...[
        "target:rows.id,...write,...{setWhere:sql`true`}",
        "target:rows.id,...write,...{set:{other}}",
        "target:rows.id,...write,setWhere:sql`true`",
        "target:rows.id,...write,set:{other}",
        "target:rows.id,...write,...{...{setWhere:sql`true`}}",
        "target:rows.id,...write,...{where:sql`true`}",
        "target:rows.id,...write,...{target:other}",
        "target:rows.id,...write,target:other",
        "target:rows.id,...write,...opaque",
        "...opaque,target:rows.id,...write",
        'target:rows.id,...write,...{["setWhere"]:sql`true`}',
        "target:rows.id,...write,...second",
        "target:rows.id,set:write.set,setWhere:write.setWhere,...{setWhere:sql`true`}",
        "target:rows.id,set:write.set,setWhere:write.setWhere,...opaque",
      ].map(
        (options) =>
          [
            `${imports}const write = plan(rows,{value}); const second = plan(rows,{other});\nawait tx.insert(rows).values(input).onConflictDoUpdate({${options}});`,
            [3],
          ] as const,
      ),
      [
        `${imports}const write = plan(rows,{value});\nawait tx.insert(rows).values(input).onConflictDoUpdate({...{target:rows.id},...write});`,
        [],
      ],
      [
        `${imports}const write = plan(rows,{value});\nawait tx.insert(rows).values(input).onConflictDoUpdate({target:rows.id,set:write.set,setWhere:and(write.setWhere,eq(rows.id,id))});`,
        [],
      ],
    ]);
  });
  test("the final WHERE and SET sinks must retain the same plan", async () => {
    await expectLines([
      ...[
        ".set(write.set).where(write.setWhere).where(sql`true`)",
        ".set(write.set).where(write.setWhere).where(undefined)",
        ".set(write.set).where(write.setWhere).set({other})",
        ".set({...write.set}).where(write.setWhere)",
        ".set({...write.set,...{value:other}}).where(write.setWhere)",
        ".set(write.set).where({...write.setWhere,...opaque})",
      ].map(
        (sink) =>
          [
            `${imports}const write = plan(rows,{value});\nawait tx.update(rows)${sink};`,
            [3],
          ] as const,
      ),
      [
        `${imports}const write = plan(rows,{value});\nawait tx.update(rows).set(write.set).where(sql\`true\`).where(write.setWhere);`,
        [],
      ],
    ]);
  });
  test("a shadowed plan or an OR does not establish a changed-only write", async () => {
    await expectLines([
      [
        `${
          imports
        }const write = plan(rows, { value });\nfunction bad(write) { return tx.update(rows).set(write.set).where(write.setWhere); }`,
        [3],
      ],
      [
        `${
          imports
        }const write = plan(rows, { value });\nawait tx.update(rows).set(write.set).where(or(write.setWhere,sql\`true\`));`,
        [3],
      ],
    ]);
  });
  test("raw SQL writes and overwritten predicates fail the guard", async () => {
    // Independent sources lint concurrently, so the case's wall time stays
    // one lint run rather than four.
    const cases: readonly (readonly [string, readonly number[]])[] = [
      [
        'import { sql } from "drizzle-orm";\nawait tx.execute(sql`UPDATE rows SET value = ' +
          "$" +
          "{value}`);",
        [2],
      ],
      [
        'import { sql } from "drizzle-orm";\nawait tx.execute(sql.raw("UPDATE rows SET value = 1"));',
        [2],
      ],
      [
        'import { sql } from "drizzle-orm";\nconst statement = sql.raw("UPDATE rows SET value = 1");\nawait tx.execute(statement);',
        [3],
      ],
      [
        'import {replayRawWrite} from "@/api/lib/case-law/replay-write"; import {sql} from "drizzle-orm";\nawait replayRawWrite({table:rows,values:{value},predicate:sql`true`,operation:{kind:"update"},ctes:[{name:"x",query:sql.raw("UPDATE rows SET value=1")}]}).execute({kind:"drizzle",connection:tx});',
        [2],
      ],
      [
        'import { sql } from "drizzle-orm";\nawait tx.execute(sql.raw("/* replay batch */ UPDATE rows SET value = 1"));',
        [2],
      ],
      [
        'import { sql } from "drizzle-orm";\nawait tx.execute(useUpdate ? sql.raw("UPDATE rows SET value = 1") : sql.raw("SELECT 1"));',
        [2],
      ],
    ];
    expect(
      await Promise.all(cases.map(async ([source]) => await lint(source))),
    ).toEqual(cases.map(([, lines]) => [...lines]));
  });
  test("a saved update builder must still carry the plan's predicate", async () => {
    await expectLines([
      [
        `${imports}const write = plan(rows, { value });\nconst update = tx.update(rows);\nawait update.set(write.set).where(eq(rows.id,id));`,
        [4],
      ],
      [
        `${imports}const update = tx.update(rows);\nawait update.set({ value });`,
        [3],
      ],
      [
        `${imports}const write = plan(rows, { value });\nconst update = tx.update(rows);\nawait update.set(write.set).where(and(eq(rows.id,id),write.setWhere));`,
        [],
      ],
    ]);
  });
  test("a predicate typed as optional may only fall back to a panic", async () => {
    const guarded = `${imports}import { panic } from "better-result";\nconst write = plan(rows,{value});\nawait tx.insert(rows).values(input).onConflictDoUpdate({target:rows.id,set:write.set,setWhere:and(write.setWhere,eq(rows.id,id)) ?? `;
    await expectLines([
      [`${guarded}panic("missing")});`, []],
      [`${guarded}sql\`true\`});`, [4]],
    ]);
  });
  test("raw templates cannot substitute for a complete owner statement", async () => {
    const rawImports =
      'import {sql} from "drizzle-orm"; import {replayWriteAssignments} from "@/api/lib/case-law/replay-write";';
    const marker = "$";
    await expectLines([
      ...[
        `UPDATE rows SET ${marker}{replayWriteAssignments(rows,write)} WHERE true RETURNING ${marker}{write.setWhere}`,
        `UPDATE rows SET value=1 WHERE true RETURNING ${marker}{write.setWhere}`,
        `UPDATE rows SET value=(SELECT 1 WHERE ${marker}{write.setWhere}) WHERE true`,
        `WITH check AS (SELECT ${marker}{write.setWhere}) UPDATE rows SET ${marker}{replayWriteAssignments(rows,write)} WHERE true`,
        `UPDATE rows SET ${marker}{replayWriteAssignments(rows,write)} WHERE ${marker}{write.setWhere} OR true`,
        `UPDATE rows SET ${marker}{replayWriteAssignments(rows,write)} WHERE ${marker}{write.setWhere}`,
        `INSERT INTO rows(id,value) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET value=1 WHERE ${marker}{write.setWhere}`,
      ].map(
        (statement) =>
          [
            `${imports}${rawImports}\nconst write = plan(rows,{value});\nawait tx.execute(sql\`${statement}\`);`,
            [4],
          ] as const,
      ),
      [
        'import {replayRawWrite} from "@/api/lib/case-law/replay-write";\nawait replayRawWrite({table:rows,values:{value},predicate:sql`true`,operation:{kind:"update"}}).execute({kind:"drizzle",connection:tx});',
        [],
      ],
    ]);
  });
  test("complete owners cannot smuggle a raw mutation in a CTE or result query", async () => {
    await expectLines([
      ...[
        'ctes:[{name:"x",query:sql`UPDATE rows SET value=1 RETURNING id`}]',
        'result:{kind:"query",name:"x",columns:sql`id`,query:sql`UPDATE rows SET value=1`}',
      ].map(
        (extra) =>
          [
            `import {replayRawWrite} from "@/api/lib/case-law/replay-write"; import {sql} from "drizzle-orm";\nawait replayRawWrite({table:rows,values:{value},predicate:sql\`true\`,operation:{kind:"update"},${extra}}).execute({kind:"drizzle",connection:tx});`,
            [2],
          ] as const,
      ),
    ]);
  });
  test("serialized raw updates cannot compare a different SET", async () => {
    expect(
      await lint(
        `${
          imports
        }import {sql} from "drizzle-orm";\nconst write = plan(rows,{value}); const query = new PgDialect().sqlToQuery(sql\`UPDATE rows SET other = 1 WHERE \${write.setWhere}\`);\nawait tx.execute(query.sql,query.params);`,
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
    const [before, broken, restored] = await Promise.all([
      lint(original),
      lint(mutated),
      lint(original),
    ]);
    expect(before).toEqual([]);
    expect(broken.length).toBeGreaterThan(0);
    expect(restored).toEqual([]);
  });
});
