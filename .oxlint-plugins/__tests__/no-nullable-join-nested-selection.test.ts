import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

// Join-key proofs count only for helpers imported from drizzle-orm, so every
// snippet starts with that import; reported lines are counted without it.
const DRIZZLE_IMPORT = 'import { and, eq, isNotNull, or } from "drizzle-orm";';

const lint = async (lines: readonly string[]) =>
  (
    await lintSingleRule(
      "no-nullable-join-nested-selection",
      [DRIZZLE_IMPORT, ...lines].join("\n"),
    )
  ).map((line) => line - 1);

describe.serial("no-nullable-join-nested-selection", () => {
  test("reports a nested object over a left-joined table, as the research read had it", async () => {
    expect(
      await lint([
        "const [row] = await tx",
        "  .select({",
        "    id: publishedCaseLawDecisions.id,",
        "    source: { descriptor: caseLawSources.descriptor },",
        "  })",
        "  .from(publishedCaseLawDecisions)",
        "  .leftJoin(",
        "    caseLawSources,",
        "    eq(caseLawSources.id, publishedCaseLawDecisions.sourceId),",
        "  )",
        "  .where(eq(publishedCaseLawDecisions.id, decisionId))",
        "  .limit(1);",
        "",
      ]),
    ).toEqual([4]);
  });

  test("accepts the flat columns and join key that replace it", async () => {
    expect(
      await lint([
        "const [row] = await tx",
        "  .select({",
        "    id: publishedCaseLawDecisions.id,",
        "    sourceId: caseLawSources.id,",
        "    sourceDescriptor: caseLawSources.descriptor,",
        "  })",
        "  .from(publishedCaseLawDecisions)",
        "  .leftJoin(",
        "    caseLawSources,",
        "    eq(caseLawSources.id, publishedCaseLawDecisions.sourceId),",
        "  );",
        "",
      ]),
    ).toEqual([]);
  });

  test("accepts a nested object that carries its left join's own key", async () => {
    expect(
      await lint([
        "db.select({ b: { id: b.id, x: b.x } }).from(a).leftJoin(b, eq(b.id, a.bId));",
        "db.select({ b: { id: b.id, x: b.x } }).from(a).leftJoin(b, and(eq(a.bId, b.id), eq(b.kind, kind)));",
        "db.select({ b: { id: b.id, x: b.x } }).from(a).leftJoinLateral(b, isNotNull(b.id));",
        // Another table's condition, `or`, or a non-key column prove nothing.
        "db.select({ b: { id: b.id } }).from(a).leftJoin(b, eq(b.x, a.x)).leftJoin(c, eq(c.id, b.id));",
        "db.select({ b: { id: b.id } }).from(a).leftJoin(b, or(eq(b.id, a.bId), eq(b.id, a.cId)));",
        "db.select({ b: { x: b.x } }).from(a).leftJoin(b, eq(b.id, a.bId));",
        // Right and full joins: the nullable side has no own condition.
        "db.select({ b: { id: b.id } }).from(a).fullJoin(b, eq(b.id, a.bId));",
        "",
      ]),
    ).toEqual([4, 5, 6, 7]);
  });

  test("follows which side of each join may be unmatched", async () => {
    expect(
      await lint([
        // Base table and inner join: never nullified.
        "db.select({ a: { id: a.id }, b: { id: b.id } }).from(a).innerJoin(b, on);",
        // Right join: the tables before it become nullable, the joined one not.
        "db.select({ a: { id: a.id }, b: { id: b.id } }).from(a).rightJoin(b, on);",
        // Full join: both sides.
        "db.select({ a: { id: a.id }, b: { id: b.id } }).from(a).fullJoin(b, on);",
        // An inner join after a left join does not make the left one required.
        "db.select({ b: { id: b.id } }).from(a).leftJoin(b, on).innerJoin(c, on);",
        // Schema-qualified tables are matched by their dotted name.
        "db.select({ b: { id: schema.b.id } }).from(schema.a).leftJoin(schema.b, on);",
        "",
      ]),
    ).toEqual([2, 3, 3, 4, 5]);
  });

  test("reads a const selection and every select form", async () => {
    expect(
      await lint([
        "const selection = { b: { id: b.id } };",
        "db.select(selection).from(a).leftJoin(b, on);",
        "db.selectDistinct({",
        "  b: { id: b.id },",
        "}).from(a).leftJoin(b, on);",
        "db.selectDistinctOn([a.id], {",
        "  b: { id: b.id },",
        "}).from(a).leftJoin(b, on);",
        "",
      ]),
    ).toEqual([1, 4, 7]);
  });

  test("leaves deeper nesting, flat columns and unjoined reads alone", async () => {
    expect(
      await lint([
        "db.select({ meta: { b: { id: b.id } } }).from(a).leftJoin(b, on);",
        "db.select({ bId: b.id, a: { id: a.id } }).from(a).leftJoin(b, on);",
        "db.select({ b: { id: b.id } }).from(b).where(on);",
        "db.select({ b: { id: sql`1` } }).from(a).leftJoin(b, on);",
        "",
      ]),
    ).toEqual([]);
  });

  test("reads the first column of the nullable table, as Drizzle does", async () => {
    expect(
      await lint([
        // The key first: a NULL first column means no row matched.
        "db.select({ b: { id: b.id, x: b.x } }).from(a).leftJoin(b, eq(b.id, a.bId));",
        // The key later: a NULL `x` on a matched row already nulls `b`.
        "db.select({ b: { x: b.x, id: b.id } }).from(a).leftJoin(b, eq(b.id, a.bId));",
        // Columns of two tables: Drizzle never nullifies the object.
        "db.select({ b: { aId: a.id, x: b.x } }).from(a).leftJoin(b, eq(b.id, a.bId));",
        "db.select({ b: { x: b.x, aId: a.id } }).from(a).leftJoin(b, eq(b.id, a.bId));",
        "",
      ]),
    ).toEqual([2]);
  });

  test("resolves drizzle-orm helpers through their import", async () => {
    expect(
      await lint([
        'import { and as all, eq as equals } from "drizzle-orm";',
        'import * as d from "drizzle-orm";',
        'import { eq as same } from "./not-drizzle.ts";',
        "db.select({ b: { id: b.id } }).from(a).leftJoin(b, equals(b.id, a.bId));",
        "db.select({ b: { id: b.id } }).from(a).leftJoin(b, all(d.eq(b.id, a.bId), d.isNotNull(b.x)));",
        "db.select({ b: { id: b.id } }).from(a).leftJoin(b, same(b.id, a.bId));",
        "",
      ]),
    ).toEqual([6]);
  });

  test("reads a nested object held in a const", async () => {
    expect(
      await lint([
        "const source = { x: b.x };",
        "const keyed = { id: b.id, x: b.x };",
        "db.select({ source }).from(a).leftJoin(b, eq(b.id, a.bId));",
        "db.select({ source: keyed }).from(a).leftJoin(b, eq(b.id, a.bId));",
        "",
      ]),
    ).toEqual([3]);
  });

  test("a helper not imported from drizzle-orm proves no join key", async () => {
    expect(
      await lint([
        "const same = (left: unknown, right: unknown) => isNotDistinctFrom(left, right);",
        "db.select({ b: { id: b.id } }).from(a).leftJoin(b, same(b.id, a.bId));",
        "",
      ]),
    ).toEqual([2]);
  });

  test("skips a nested object holding a spread", async () => {
    expect(
      await lint([
        "const keyed = { id: b.id };",
        "db.select({ b: { ...keyed, x: b.x } }).from(a).leftJoin(b, eq(b.id, a.bId));",
        "",
      ]),
    ).toEqual([]);
  });
});
