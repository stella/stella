import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { groupableSql } from "@/api/lib/groupable-sql";

const decisions = pgTable("decisions", {
  id: text("id"),
  decisionDate: timestamp("decision_date"),
});

// A grouped SELECT expression is matched by Postgres on rendered text, and
// drizzle numbers bind placeholders per render, so a bound value inside a
// fragment used in both the SELECT list and GROUP BY produces a mismatch.
// `groupableSql` refuses to construct such a fragment.

test("panics on a bare interpolated primitive (drizzle binds it as $n)", () => {
  expect(() => groupableSql(sql`decision_date >= ${"2020-01-01"}`)).toThrow(
    /bound/u,
  );
});

test("panics on an explicit sql.param(...) value", () => {
  expect(() => groupableSql(sql`x = ${sql.param("v")}`)).toThrow(/Param/u);
});

test("panics on an sql.placeholder(...)", () => {
  expect(() => groupableSql(sql`x = ${sql.placeholder("p")}`)).toThrow(
    /placeholder/u,
  );
});

test("panics on a bound value nested inside a sub-fragment", () => {
  const inner = sql`${decisions.decisionDate} < ${"2021-01-01"}`;
  expect(() => groupableSql(sql`(${inner})`)).toThrow(/bound/u);
});

test("panics on a bound value inside a joined list", () => {
  const values = ["a", "b"].map((value) => sql`${value}`);
  expect(() =>
    groupableSql(sql`status IN (${sql.join(values, sql`, `)})`),
  ).toThrow(/bound/u);
});

test("accepts column references and sql.raw-inlined constants", () => {
  const fragment = groupableSql(
    sql<string>`COALESCE(to_char(${decisions.decisionDate}, 'YYYY'), ${sql.raw(`'undated'`)})`,
  );
  // Returns the same fragment untouched so callers can use it directly.
  expect(fragment).toBeInstanceOf(sql`x`.constructor);
});

test("accepts a raw-only fragment", () => {
  expect(() => groupableSql(sql`${sql.raw("count(*)::int")}`)).not.toThrow();
});

test("accepts an sql.raw-inlined list join", () => {
  const values = ["open", "done"].map((value) => sql.raw(`'${value}'`));
  expect(() =>
    groupableSql(sql`status IN (${sql.join(values, sql`, `)})`),
  ).not.toThrow();
});

test("the migrated sitemap fragments construct without panicking", async () => {
  const fragments = await import("@/api/handlers/case-law/decisions/sitemap");
  expect(fragments.decisionYearSql).toBeInstanceOf(sql`x`.constructor);
  expect(fragments.decisionMonthSql).toBeInstanceOf(sql`x`.constructor);
  expect(fragments.decisionBucketSql).toBeInstanceOf(sql`x`.constructor);
});
