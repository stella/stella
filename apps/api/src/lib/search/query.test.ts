import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import {
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
});
