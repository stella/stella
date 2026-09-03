import { expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  CORPUS_QUERY_LEAF_BUDGET,
  corpusFreeTextClause,
} from "@/api/lib/legal-search/corpus-query";
import { expandTermWith } from "@/api/lib/legal-search/expansion";
import { parseExpansionDictionary } from "@/api/lib/legal-search/morphology/dictionary";

/**
 * Arbitrary serialized dictionaries, including hostile ones. Dictionary
 * content is derived from corpus text and is therefore untrusted input to the
 * query builder: a form carrying a quote or a backslash would close the
 * clause and let the rest parse as DSL. Two independent layers stop that (the
 * letters-only filter at parse, `quoteCorpusValue` at emit), and the point of
 * generating the escapes is that neither layer may be the only one.
 */
const dictionaryText = fc
  .array(
    fc
      .array(
        fc.oneof(
          fc.string({ minLength: 1, maxLength: 8 }),
          fc.constantFrom(
            'a"b',
            "a\\",
            "a b",
            "a,b",
            "a\tb",
            "a1",
            "aaa",
            "aaab",
          ),
        ),
        { minLength: 1, maxLength: 6 },
      )
      .map((forms) => `stem\t${forms.join(",")}\t7`),
    { maxLength: 20 },
  )
  .map((lines) => lines.join("\n"));

const queryText = fc.oneof(
  fc.string({ maxLength: 60 }),
  fc.constantFrom(
    "aaa aaab",
    '"aaa aaab" aaa',
    "aaa ".repeat(20),
    // Past the leaf budget before a single expansion is considered.
    "aaa ".repeat(30),
    "§ 2235 odst. 1",
    'x) OR (court:"y"',
  ),
);

/**
 * The emitted clause is balanced, and every quote in it is either a delimiter
 * or escaped. Walking the string is the check, because "no value escaped its
 * quoting" is exactly the property a regex over the result would beg.
 */
const isWellQuoted = (clause: string): boolean => {
  let depth = 0;
  let index = 0;
  let inQuotes = false;
  while (index < clause.length) {
    const char = clause.charAt(index);
    if (inQuotes) {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === '"') {
        inQuotes = false;
      }
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
    index += 1;
  }
  return depth === 0 && !inQuotes;
};

/** Quoted leaves: quote characters that opened a span, counted outside one. */
const leafCount = (clause: string): number => {
  let leaves = 0;
  let index = 0;
  let inQuotes = false;
  while (index < clause.length) {
    const char = clause.charAt(index);
    if (inQuotes) {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === '"') {
        inQuotes = false;
      }
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      leaves += 1;
    }
    index += 1;
  }
  return leaves;
};

test("no dictionary can produce a clause that escapes its own quoting", () => {
  fc.assert(
    fc.property(dictionaryText, queryText, (text, query) => {
      const { entries } = parseExpansionDictionary(text);
      const clause = corpusFreeTextClause(query, {
        expand: (term) => expandTermWith(entries, term),
      });
      if (clause === null) {
        return;
      }
      expect(isWellQuoted(clause)).toBe(true);
    }),
    propertyConfig(),
  );
});

// The budget bounds what expansion adds, not what the reader typed: a query of
// more than 24 words already carries more than 24 leaves before any expansion,
// and the builder must not drop the reader's own terms to fit. So the ceiling
// is the budget or the unexpanded clause, whichever is larger.
test("expansion never pushes a clause past the leaf budget it started under", () => {
  fc.assert(
    fc.property(dictionaryText, queryText, (text, query) => {
      const { entries } = parseExpansionDictionary(text);
      const base = corpusFreeTextClause(query);
      const expanded = corpusFreeTextClause(query, {
        expand: (term) => expandTermWith(entries, term),
      });
      if (base === null || expanded === null) {
        return;
      }
      const baseLeaves = leafCount(base);
      expect(leafCount(expanded)).toBeLessThanOrEqual(
        Math.max(baseLeaves, CORPUS_QUERY_LEAF_BUDGET),
      );
      // Over the budget on its own, a query gets no expansion at all.
      if (baseLeaves >= CORPUS_QUERY_LEAF_BUDGET) {
        expect(expanded).toBe(base);
      }
    }),
    propertyConfig(),
  );
});

test("expansion only ever adds leaves to the unexpanded clause", () => {
  fc.assert(
    fc.property(dictionaryText, queryText, (text, query) => {
      const { entries } = parseExpansionDictionary(text);
      const base = corpusFreeTextClause(query);
      const expanded = corpusFreeTextClause(query, {
        expand: (term) => expandTermWith(entries, term),
      });
      expect(expanded === null).toBe(base === null);
      if (base === null || expanded === null) {
        return;
      }
      expect(leafCount(expanded)).toBeGreaterThanOrEqual(leafCount(base));
      // The reader's own terms are never dropped: every AND position the
      // unexpanded clause has is still there.
      expect(expanded.split(" AND ").length).toBe(base.split(" AND ").length);
    }),
    propertyConfig(),
  );
});
