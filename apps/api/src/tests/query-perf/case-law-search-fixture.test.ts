import { expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { globalCaseLawHitsStatement } from "@/api/lib/search/index-global";

import {
  caseLawSearchStatement,
  unboundedCaseLawSearchStatement,
} from "./case-law-search-fixture";

const compile = (query: ReturnType<typeof globalCaseLawHitsStatement>) =>
  new PgDialect().sqlToQuery(query);

test("the mutation moves the page limit beyond section aggregation", () => {
  const good = compile(caseLawSearchStatement());
  const bad = compile(unboundedCaseLawSearchStatement());
  expect(good.sql).toContain("WITH page AS MATERIALIZED");
  expect(good.sql.indexOf("LIMIT")).toBeLessThan(
    good.sql.indexOf("jsonb_array_elements"),
  );
  expect(bad.sql).toContain("WITH page AS NOT MATERIALIZED");
  expect(bad.sql.indexOf("LIMIT")).toBeGreaterThan(
    bad.sql.indexOf("jsonb_array_elements"),
  );
  expect(good.params.filter((value) => value === 11)).toHaveLength(1);
  expect(bad.params.filter((value) => value === 11)).toHaveLength(1);
});

test("page selection retains publication, time filters, keyset and ranking before enrichment", () => {
  for (const query of ["", "smlouva"]) {
    const statement = compile(
      globalCaseLawHitsStatement({
        query,
        updatedFrom: "2026-01-01T00:00:00Z",
        updatedTo: "2026-12-31T00:00:00Z",
        searchCursor: {
          tier: 1,
          score: 0.5,
          id: "case-law:01990000-00b1-7000-8000-000000000100",
          seen: 10,
        },
        fetchLimit: 11,
      }),
    );
    const boundary = statement.sql.indexOf("LIMIT");
    const candidates = statement.sql.slice(0, boundary);
    if (query) {
      expect(candidates).toContain(
        "FROM case_law_published_decisions decision",
      );
      expect(candidates).toContain("WHERE decision.id = clsd.decision_id");
      expect(candidates).toContain("OFFSET 0");
    } else {
      expect(candidates).toContain("JOIN case_law_published_decisions d");
      expect(candidates).not.toContain("OFFSET 0");
    }
    expect(candidates).toContain("case_law_sources");
    expect(candidates).toContain("allowsRedistribution");
    expect(candidates).toContain("d.updated_at >=");
    expect(candidates).toContain("d.updated_at <=");
    expect(candidates).toContain("'case-law:' || clsd.decision_id::text");
    expect(candidates).not.toContain("jsonb_array_elements");
    expect(candidates).not.toContain("d.fulltext");
    expect(candidates).not.toContain("d.sections");
    const order = query
      ? "tier DESC, score DESC, clsd.decision_id DESC"
      : "d.updated_at DESC, clsd.decision_id DESC";
    expect(candidates).toContain(`ORDER BY ${order}`);
    expect(statement.sql.slice(boundary)).toContain(`ORDER BY ${order}`);
  }
});
