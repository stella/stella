import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (lines: readonly string[]) =>
  await lintSingleRule("no-nullable-join-nested-selection", lines.join("\n"));

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
});
