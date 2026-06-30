import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { FtsSearchConfig } from "@/api/handlers/case-law/fts-config";
import { buildPgFtsSearchSql } from "@/api/lib/legal-search/pg-fts-query";

const configs: FtsSearchConfig[] = [
  {
    regconfig: "simple",
    useUnaccent: true,
    includeDefault: true,
    languages: ["cs"],
  },
  {
    regconfig: "english",
    useUnaccent: false,
    includeDefault: false,
    languages: ["en"],
  },
];

const refs = {
  language: sql`sd.language`,
  regconfig: sql`sd.regconfig`,
  vector: sql`sd.tsv`,
};

describe("buildPgFtsSearchSql", () => {
  test("keeps FTS predicates indexable with constant regconfig tsqueries", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(
      buildPgFtsSearchSql({ configs, query: "HELLO", refs }).predicate,
    );

    expect(compiled.sql).not.toContain("plainto_tsquery(sd.regconfig");
    expect(compiled.sql).toContain("sd.tsv @@ (plainto_tsquery($");
    expect(compiled.sql).toContain("sd.regconfig = $");
    expect(compiled.sql).toContain("sd.language NOT IN");
    expect(compiled.params).toContain("simple");
    expect(compiled.params).toContain("english");
    expect(compiled.params).toContain("HELLO");
  });

  test("preserves use-unaccent per FTS config branch", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(
      buildPgFtsSearchSql({ configs, query: "خدمة", refs }).predicate,
    );

    expect(compiled.sql).toBe(
      "((sd.regconfig = $1 AND (sd.language IN ($2) OR (sd.language IS NULL OR sd.language NOT IN ($3, $4))) AND sd.tsv @@ (plainto_tsquery($5::regconfig, unaccent($6)) || plainto_tsquery($7::regconfig, unaccent(arabic_normalize($8))))) OR (sd.regconfig = $9 AND (sd.language IS NULL OR sd.language NOT IN ($10)) AND sd.tsv @@ (plainto_tsquery($11::regconfig, unaccent($12)) || plainto_tsquery($13::regconfig, unaccent(arabic_normalize($14))))) OR (sd.regconfig = $15 AND (sd.language IN ($16) OR false) AND sd.tsv @@ (plainto_tsquery($17::regconfig, $18) || plainto_tsquery($19::regconfig, arabic_normalize($20)))) OR (sd.regconfig = $21 AND (sd.language IS NULL OR sd.language NOT IN ($22)) AND sd.tsv @@ (plainto_tsquery($23::regconfig, $24) || plainto_tsquery($25::regconfig, arabic_normalize($26)))))",
    );
    expect(compiled.params).toEqual([
      "simple",
      "cs",
      "cs",
      "en",
      "simple",
      "خدمة",
      "simple",
      "خدمة",
      "simple",
      "cs",
      "simple",
      "خدمة",
      "simple",
      "خدمة",
      "english",
      "en",
      "english",
      "خدمة",
      "english",
      "خدمة",
      "english",
      "en",
      "english",
      "خدمة",
      "english",
      "خدمة",
    ]);
  });

  test("keeps rows searchable when their stored regconfig differs from the current language config", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(
      buildPgFtsSearchSql({ configs, query: "contract", refs }).predicate,
    );

    expect(compiled.sql).toContain(
      "sd.regconfig = $7 AND (sd.language IS NULL OR sd.language NOT IN ($8))",
    );
    expect(compiled.params.slice(6, 10)).toEqual([
      "simple",
      "cs",
      "simple",
      "contract",
    ]);
  });
});
