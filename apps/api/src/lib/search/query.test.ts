import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  buildPlainSearchTsQuery,
  buildSearchTsQuery,
  fileNameSearchText,
  normalizeFileNameForSearch,
  normalizeFileNameVariantForSearch,
  removeSearchDiacritics,
  toAdvancedTsQueryText,
  toLooseTsQueryText,
  toPrefixTsQueryText,
  validateStellaSearchQuery,
} from "@/api/lib/search/query";

describe("search query text", () => {
  test("indexes the full file name and a normalized base name", () => {
    expect(fileNameSearchText("Share_Purchase-Agreement.final.pdf")).toBe(
      "Share_Purchase-Agreement.final.pdf Share Purchase Agreement final",
    );
  });

  test("normalizes file-style separators and strips the extension", () => {
    expect(normalizeFileNameForSearch("Closing_Memo-v2.docx")).toBe(
      "Closing Memo v2",
    );
  });

  test("only creates filename variants for filename-looking queries", () => {
    expect(normalizeFileNameVariantForSearch("Closing Memo v2.docx")).toBe(
      "Closing Memo v2",
    );
    expect(normalizeFileNameVariantForSearch("Smith v. Jones")).toBeNull();
    expect(normalizeFileNameVariantForSearch("Acme Inc.")).toBeNull();
  });

  test("normalizes diacritics for lexeme-based search syntax", () => {
    expect(removeSearchDiacritics("černý žaloba")).toBe("cerny zaloba");
    expect(toPrefixTsQueryText("černý")).toBe("cerny:*");
  });

  test("builds prefix tsquery text from normalized filename tokens", () => {
    expect(toPrefixTsQueryText("Closing_Memo-v2.docx")).toBe(
      "Closing:* & Memo:* & v2:* & docx:*",
    );
  });

  test("keeps legal abbreviations after periods in prefix queries", () => {
    expect(toPrefixTsQueryText("Smith v. Jones")).toBe(
      "Smith:* & v:* & Jones:*",
    );
  });

  test("builds a loose fallback so one typo does not hide useful results", () => {
    expect(toLooseTsQueryText("nterim injunctive")).toBe(
      "nterim:* | injunctive:*",
    );
    expect(toLooseTsQueryText("injunctive")).toBeNull();
  });

  test("parses explicit AND with prefix terms", () => {
    expect(toAdvancedTsQueryText("agreement AND termination")).toBe(
      "(agreement:*) & (termination:*)",
    );
  });

  test("accepts explicit wildcard roots for inflected Czech terms", () => {
    expect(toAdvancedTsQueryText("lhůt* AND odvol*")).toBe(
      "(lhut:*) & (odvol:*)",
    );
    expect(validateStellaSearchQuery("lhůt* AND odvol*")).toEqual({
      valid: true,
    });
  });

  test("parses OR with lower precedence than implicit AND", () => {
    expect(toAdvancedTsQueryText("agreement OR termination draft")).toBe(
      "(agreement:*) | ((termination:*) & (draft:*))",
    );
  });

  test("parses parentheses to override precedence", () => {
    expect(toAdvancedTsQueryText("(agreement OR termination) AND draft")).toBe(
      "((agreement:*) | (termination:*)) & (draft:*)",
    );
  });

  test("parses NOT and leading minus as negation", () => {
    expect(toAdvancedTsQueryText("agreement NOT draft")).toBe(
      "(agreement:*) & (!(draft:*))",
    );
    expect(toAdvancedTsQueryText("agreement -draft")).toBe(
      "(agreement:*) & (!(draft:*))",
    );
  });

  test("parses quoted phrases as adjacent lexemes", () => {
    expect(toAdvancedTsQueryText('"share purchase agreement"')).toBe(
      "share:* <-> purchase:* <-> agreement:*",
    );
  });

  test("normalizes filename terms inside advanced queries", () => {
    expect(toAdvancedTsQueryText("Closing_Memo-v2.docx OR invoice.pdf")).toBe(
      "(Closing:* & Memo:* & v2:* & docx:*) | (invoice:* & pdf:*)",
    );
  });

  test("normalizes diacritics inside advanced query terms", () => {
    expect(toAdvancedTsQueryText("černý AND žaloba")).toBe(
      "(cerny:*) & (zaloba:*)",
    );
  });

  test("returns null for invalid advanced syntax", () => {
    expect(toAdvancedTsQueryText("(agreement OR")).toBeNull();
    expect(toAdvancedTsQueryText('"unterminated phrase')).toBeNull();
  });

  test("rejects advanced queries with only negated terms", () => {
    expect(toAdvancedTsQueryText("-draft")).toBeNull();
    expect(toAdvancedTsQueryText("NOT draft")).toBeNull();
    expect(validateStellaSearchQuery("-draft")).toEqual({
      reason: "Search query must include at least one positive term.",
      valid: false,
    });
  });

  test("validates stella search syntax for AI-generated queries", () => {
    expect(validateStellaSearchQuery("Černý reorganizace")).toEqual({
      valid: true,
    });
    expect(
      validateStellaSearchQuery(
        'injunction OR "interim relief" OR "preliminary measure"',
      ),
    ).toEqual({ valid: true });
    expect(
      validateStellaSearchQuery(
        '("smluvní pokuta" OR "penalty clause" OR "liquidated damages") AND (nejpřísnější OR highest OR severe)',
      ),
    ).toEqual({ valid: true });
    expect(validateStellaSearchQuery("(agreement OR")).toEqual({
      reason:
        "Invalid boolean syntax. Use uppercase AND, OR, NOT, balanced parentheses, and closed quotes.",
      valid: false,
    });
  });

  test("does not treat lowercase connector words as advanced operators", () => {
    expect(toAdvancedTsQueryText("terms and conditions")).toBeNull();
  });

  test("builds a valid empty tsquery for whitespace-only input", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(buildSearchTsQuery("   "));

    expect(compiled.sql).toBe("plainto_tsquery('simple', '')");
  });

  test("builds a no-match tsquery for invalid advanced input", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(buildSearchTsQuery("NOT draft"));

    expect(compiled.sql).toBe("plainto_tsquery('simple', '')");
  });

  test("folds Arabic orthographic variants in lexeme queries", () => {
    expect(toPrefixTsQueryText("خدمة")).toBe("خدمه:*");
    expect(toPrefixTsQueryText("أحمد")).toBe("احمد:*");
    expect(toAdvancedTsQueryText("خدمة AND ٢٠٢٤")).toBe("(خدمه:*) & (2024:*)");
  });

  test("normalizes Arabic on the plainto query path", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(buildSearchTsQuery("خدمة"));

    expect(compiled.sql).toContain("arabic_normalize");
    expect(compiled.sql).toContain("plainto_tsquery('simple', unaccent($1))");
    expect(compiled.params.filter((param) => param === "خدمة")).toHaveLength(2);
    expect(compiled.params).toContain("(خدمة:* | خدمه:*)");
  });

  test("keeps advanced Arabic queries compatible with existing indexes", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(buildSearchTsQuery("خدمة AND ٢٠٢٤"));

    expect(compiled.sql).toBe("to_tsquery('simple', unaccent($1))");
    expect(compiled.params).toEqual([
      "((خدمة:* | خدمه:*)) & ((٢٠٢٤:* | 2024:* | ۲۰۲۴:*))",
    ]);
  });

  test("keeps negated advanced Arabic terms compatible", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(
      buildSearchTsQuery("agreement NOT خدمة"),
    );

    expect(compiled.sql).toBe("to_tsquery('simple', unaccent($1))");
    expect(compiled.params).toEqual(["(agreement:*) & (!((خدمة:* | خدمه:*)))"]);
  });

  test("keeps already-folded Arabic queries compatible with legacy vectors", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(buildSearchTsQuery("احمد"));

    expect(compiled.sql).toContain("plainto_tsquery('simple', unaccent($1))");
    expect(compiled.params).toContain("احمد");
    expect(compiled.params).toContain("أحمد");
  });

  test("keeps already-folded negated Arabic terms compatible", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(
      buildSearchTsQuery("agreement NOT احمد"),
    );

    expect(compiled.sql).toBe("to_tsquery('simple', unaccent($1))");
    expect(compiled.params).toEqual([
      "(agreement:*) & (!((احمد:* | آحمد:* | أحمد:* | إحمد:* | ٱحمد:*)))",
    ]);
  });

  test("builds a plain tsquery that can match old and normalized vectors", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(buildPlainSearchTsQuery("خدمة"));

    expect(compiled.sql).toBe(
      "(plainto_tsquery('simple', unaccent($1)) || plainto_tsquery('simple', unaccent(arabic_normalize($2))))",
    );
    expect(compiled.params).toEqual(["خدمة", "خدمة"]);
  });

  test("builds plain tsqueries for folded-to-legacy Arabic variants", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(buildPlainSearchTsQuery("احمد"));

    expect(compiled.sql).toBe(
      "(plainto_tsquery('simple', unaccent($1)) || plainto_tsquery('simple', unaccent($2)) || plainto_tsquery('simple', unaccent($3)) || plainto_tsquery('simple', unaccent($4)) || plainto_tsquery('simple', unaccent($5)))",
    );
    expect(compiled.params).toEqual(["احمد", "آحمد", "أحمد", "إحمد", "ٱحمد"]);
  });

  test("keeps already-folded Arabic prefixes compatible with legacy vectors", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(buildSearchTsQuery("احم"));

    expect(compiled.params).toContain(
      "(احم:* | آحم:* | أحم:* | إحم:* | ٱحم:*)",
    );
  });

  test("keeps loose Arabic fallback prefixes compatible with legacy vectors", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(buildSearchTsQuery("احم agreemnt"));

    expect(compiled.params).toContain(
      "احم:* | آحم:* | أحم:* | إحم:* | ٱحم:* | agreemnt:*",
    );
  });

  test("does not duplicate plain tsqueries when folding is a no-op", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(buildPlainSearchTsQuery("agreement"));

    expect(compiled.sql).toBe("(plainto_tsquery('simple', unaccent($1)))");
    expect(compiled.params).toEqual(["agreement"]);
  });

  test("duplicates plain tsqueries when search normalization changes case", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(buildPlainSearchTsQuery("HELLO"));

    expect(compiled.sql).toBe(
      "(plainto_tsquery('simple', unaccent($1)) || plainto_tsquery('simple', unaccent(arabic_normalize($2))))",
    );
    expect(compiled.params).toEqual(["HELLO", "HELLO"]);
  });

  test("builds plain tsqueries with caller-provided FTS config", () => {
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(
      buildPlainSearchTsQuery("خدمة", {
        regconfig: sql`sd.regconfig::regconfig`,
        useUnaccent: false,
      }),
    );

    expect(compiled.sql).toBe(
      "(plainto_tsquery(sd.regconfig::regconfig, $1) || plainto_tsquery(sd.regconfig::regconfig, arabic_normalize($2)))",
    );
    expect(compiled.params).toEqual(["خدمة", "خدمة"]);
  });
});
