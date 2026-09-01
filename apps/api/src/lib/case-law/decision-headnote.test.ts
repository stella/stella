import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  decisionHeadnoteSql,
  normalizeDecisionHeadnote,
} from "@/api/lib/case-law/decision-headnote";
import { LIMITS } from "@/api/lib/limits";

describe("headnote text fits one row", () => {
  test("never exceeds the budget and never carries stray whitespace", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 800, unit: "grapheme" }),
        (raw) => {
          const headnote = normalizeDecisionHeadnote(raw);
          if (headnote === null) {
            expect(raw.trim()).toBe("");
            return;
          }
          expect(headnote.length).toBeLessThanOrEqual(
            LIMITS.caseLawHeadnoteMaxChars,
          );
          expect(headnote).toBe(headnote.trim());
          expect(headnote).not.toMatch(/\s{2}/u);
          expect(headnote).not.toMatch(/[\n\t]/u);
        },
      ),
      propertyConfig(),
    );
  });

  test("short text passes through with its whitespace collapsed", () => {
    expect(normalizeDecisionHeadnote("  Nájemní   smlouva\n\tvýpověď ")).toBe(
      "Nájemní smlouva výpověď",
    );
  });

  test("long text is cut on a word boundary and marked", () => {
    const words = Array.from({ length: 80 }, (_, i) => `slovo${i}`).join(" ");
    const headnote = normalizeDecisionHeadnote(words);

    expect(headnote).not.toBeNull();
    expect(headnote?.endsWith("…")).toBe(true);
    // The cut falls between words: the character before the mark is a full
    // word's last letter, not a truncated one followed by a space.
    expect(headnote).toMatch(/slovo\d+…$/u);
    expect(headnote?.length).toBeLessThanOrEqual(
      LIMITS.caseLawHeadnoteMaxChars,
    );
  });

  test("nothing but whitespace, or a non-string, is no headnote", () => {
    expect(normalizeDecisionHeadnote("   \n ")).toBeNull();
    expect(normalizeDecisionHeadnote(null)).toBeNull();
    expect(normalizeDecisionHeadnote(["legal sentence"])).toBeNull();
  });
});

describe("headnote SQL", () => {
  test("prefers the legal sentence, then abstract, keywords, legal area", () => {
    const rendered = new PgDialect().sqlToQuery(
      decisionHeadnoteSql(sql.raw("d.metadata")),
    ).sql;
    const order = ["legalSentence", "abstract", "keywords", "legalArea"].map(
      (key) => rendered.indexOf(key),
    );

    for (const position of order) {
      expect(position).toBeGreaterThanOrEqual(0);
    }
    expect([...order].toSorted((a, b) => a - b)).toEqual(order);
    // Keywords are only ever read as an array; a scalar under that key must
    // not raise in the database.
    expect(rendered).toContain("jsonb_typeof(d.metadata -> 'keywords')");
    expect(rendered).toContain("WITH ORDINALITY");
  });
});

describe("headnote text stays well-formed at the cut", () => {
  test("an emoji astride the budget is dropped whole, never split", () => {
    const filler = "a".repeat(LIMITS.caseLawHeadnoteMaxChars - 2);
    // The budget (max minus the mark) lands between the two code units of
    // the emoji: the cut must not keep a lone high surrogate.
    const headnote = normalizeDecisionHeadnote(`${filler}😀 tail words`);

    expect(headnote).not.toBeNull();
    expect(headnote).not.toMatch(/[\uD800-\uDBFF]…$/u);
    expect(headnote?.isWellFormed()).toBe(true);
  });
});
