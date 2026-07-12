import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import type { BoeSearchQuery } from "./query.js";
import { buildSearchQuery } from "./query.js";

describe("BOE search query builder", () => {
  test("escapes quotes inside title phrase queries", () => {
    expect(buildSearchQuery({ title: 'Ley "especial"' })).toBe(
      JSON.stringify({
        query: {
          query_string: { query: 'titulo:"Ley \\"especial\\""' },
        },
      }),
    );
  });

  test("tokenizes query_string reserved characters in free text", () => {
    expect(buildSearchQuery({ text: "39/2015" })).toBe(
      JSON.stringify({
        query: {
          query_string: {
            query: '(titulo:("39" AND "2015") OR texto:("39" AND "2015"))',
          },
        },
      }),
    );
  });

  test("keeps publication date filters inside the JSON DSL range", () => {
    expect(buildSearchQuery({ dateFrom: "18890101", dateTo: "18891231" })).toBe(
      JSON.stringify({
        query: {
          query_string: { query: "" },
          range: {
            fecha_publicacion: {
              gte: "18890101",
              lte: "18891231",
            },
          },
        },
      }),
    );
  });

  test("tokenizes and quotes plain free text across both fields", () => {
    expect(buildSearchQuery({ text: "ley organica" })).toBe(
      JSON.stringify({
        query: {
          query_string: {
            query:
              '(titulo:("ley" AND "organica") OR texto:("ley" AND "organica"))',
          },
        },
      }),
    );
  });

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

  const extractQueryString = (raw: string): string => {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new Error("Expected JSON object");
    }
    const query = parsed["query"];
    if (!isRecord(query)) {
      throw new Error("Expected query object");
    }
    const queryString = query["query_string"];
    if (!isRecord(queryString)) {
      throw new Error("Expected query_string object");
    }
    const value = queryString["query"];
    if (typeof value !== "string") {
      throw new TypeError("Expected query string");
    }
    return value;
  };

  // A balanced-parens / balanced-quotes check: every "(" has a matching
  // ")" and double-quotes come in pairs. User input must not be able to
  // unbalance the generated DSL.
  const isStructurallyBalanced = (q: string): boolean => {
    let depth = 0;
    let quotes = 0;
    for (const ch of q) {
      if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
      } else if (ch === '"') {
        quotes++;
      }
      if (depth < 0) {
        return false;
      }
    }
    return depth === 0 && quotes % 2 === 0;
  };

  test("INVARIANT: free text cannot inject field clauses, booleans, or unbalanced parens", () => {
    const attacks = [
      "a) OR fecha_publicacion:[* TO *] OR (b",
      "a) OR titulo:(b",
      'x" OR "y',
      "rango@codigo:99 OR (",
      "((((",
      "))))",
      "a AND b OR c NOT d",
      "* OR ?",
      "a:b:c",
      "valid term",
    ];
    for (const text of attacks) {
      const q = extractQueryString(buildSearchQuery({ text }));
      expect(isStructurallyBalanced(q)).toBe(true);
      // No raw field-clause injection: the only colons/parens present are
      // the ones the builder itself emits (titulo:(...) / texto:(...)).
      // Stripping those leaves no attacker-controlled ":" field clause.
      const withoutBuilderClauses = q
        .replaceAll("titulo:(", "")
        .replaceAll("texto:(", "");
      expect(withoutBuilderClauses).not.toContain(":");
      // No raw upstream field markers from user input.
      expect(q).not.toContain("fecha_publicacion");
      expect(q).not.toContain("rango@codigo");
    }
  });

  const CODIGO_FIELD_NAMES = {
    departmentCode: "departamento@codigo",
    legalRangeCode: "rango@codigo",
    matterCode: "materia@codigo",
  } as const;

  test("INVARIANT: code fields cannot inject field clauses, booleans, or unbalanced parens", () => {
    const attacks: [keyof typeof CODIGO_FIELD_NAMES, string][] = [
      ["departmentCode", "1000) OR titulo:(*"],
      ["legalRangeCode", '1300" OR rango@codigo:"*'],
      ["matterCode", "2765 OR (a"],
    ];
    for (const [field, value] of attacks) {
      const q = extractQueryString(buildSearchQuery({ [field]: value }));
      // Unlike free text, code fields are wrapped in a single quoted
      // phrase, so raw paren-counting (isStructurallyBalanced) is not a
      // meaningful signal here: a "(" inside a quoted phrase does not
      // unbalance the DSL. The exact-match assertion below is the real
      // proof: the attacker-controlled value must stay inside a single
      // quoted phrase, with any inner quotes/backslashes escaped, and no
      // unescaped injected "OR"/"titulo:"/parens reaching the DSL.
      const codigoField = CODIGO_FIELD_NAMES[field];
      const escapedValue = value
        .replaceAll("\\", "\\\\")
        .replaceAll('"', '\\"');
      expect(q).toBe(`${codigoField}:"${escapedValue}"`);
    }
  });

  test("free text of only symbols produces an empty query (no clause)", () => {
    expect(extractQueryString(buildSearchQuery({ text: "()[]:*?" }))).toBe("");
    expect(extractQueryString(buildSearchQuery({ text: "   " }))).toBe("");
  });

  // Strips every correctly-escaped quoted phrase from a query_string,
  // honoring the same backslash-escape grammar `escapeQueryStringPhrase`
  // writes (`\\` and `\"` are single escaped units inside a phrase). If
  // attacker content ever manages to close a phrase early with an
  // unescaped `"`, the remaining text after that point is left in the
  // output instead of being swallowed, and if a phrase is left dangling
  // (opened but never closed) this throws instead of silently consuming
  // the rest of the string — either way the fuzz property below fails
  // loudly instead of passing on a broken parse.
  const stripQuotedPhrases = (q: string): string => {
    let result = "";
    let i = 0;
    while (i < q.length) {
      if (q[i] !== '"') {
        result += q[i];
        i += 1;
        continue;
      }
      let j = i + 1;
      let closed = false;
      while (j < q.length) {
        if (q[j] === "\\") {
          j += 2;
          continue;
        }
        if (q[j] === '"') {
          j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) {
        throw new Error(`unterminated quoted phrase in query_string: ${q}`);
      }
      i = j;
    }
    return result;
  };

  // Paren balance, checked on the quote-stripped remainder rather than the
  // raw query_string: raw-string quote-parity (as `isStructurallyBalanced`
  // above checks) breaks once a phrase legitimately contains an escaped
  // quote (`\"`), which adds one literal `"` to the string without
  // unbalancing anything. Parens are unaffected by that, so checking them
  // post-strip stays a meaningful signal without the false positive.
  const isParenBalanced = (s: string): boolean => {
    let depth = 0;
    for (const ch of s) {
      if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
        if (depth < 0) {
          return false;
        }
      }
    }
    return depth === 0;
  };

  // The exact set of literal syntax fragments `buildSearchQuery` may emit
  // outside of quoted phrases: parens, the AND/OR joiners, and the field
  // prefixes for the five clause kinds it can produce. Nothing else is
  // legitimate: an attacker string that escapes its quoted phrase would
  // leave behind characters (another field name, a stray `:`, raw
  // boolean text) that do not match any of these tokens.
  const GRAMMAR_TOKEN =
    /^(?:\(|\)| AND | OR |titulo:|texto:|departamento@codigo:|rango@codigo:|materia@codigo:)/u;

  // Repeatedly strips one recognized grammar token from the front of the
  // (already quote-stripped) remainder. Anything left over once no token
  // matches is attacker-controlled syntax that escaped its phrase.
  const stripGrammarTokens = (remainder: string): string => {
    let s = remainder;
    for (;;) {
      const match = GRAMMAR_TOKEN.exec(s);
      if (!match) {
        return s;
      }
      s = s.slice(match[0].length);
    }
  };

  // Attack fragments biased toward the query_string DSL's reserved
  // syntax (quotes, backslashes, parens, colons, boolean keywords),
  // mixed with fully arbitrary unicode strings so both targeted and
  // unstructured input get exercised.
  const INJECTION_FRAGMENTS = [
    '"',
    "\\",
    '\\"',
    '") OR (',
    'x" OR "y',
    ") OR fecha_publicacion:[* TO *] OR (",
    " OR ",
    " AND ",
    "(",
    ")",
    ":",
    "titulo:",
    "texto:",
    "departamento@codigo:",
    "rango@codigo:",
    "materia@codigo:",
    "NOT",
    "*",
    "?",
  ] as const;

  const fieldValueArb: fc.Arbitrary<string> = fc.oneof(
    fc.string(),
    fc.constantFrom(...INJECTION_FRAGMENTS),
    fc
      .array(fc.constantFrom(...INJECTION_FRAGMENTS), {
        minLength: 1,
        maxLength: 5,
      })
      .map((fragments) => fragments.join("")),
  );

  // Every string field of BoeSearchQuery gets independently fuzzed,
  // including dateFrom/dateTo (which never reach query_string, but are
  // included so a future regression that routes them through it would
  // be caught here too).
  const boeSearchQueryArb: fc.Arbitrary<BoeSearchQuery> = fc.record(
    {
      text: fieldValueArb,
      title: fieldValueArb,
      departmentCode: fieldValueArb,
      legalRangeCode: fieldValueArb,
      matterCode: fieldValueArb,
      dateFrom: fieldValueArb,
      dateTo: fieldValueArb,
    },
    { requiredKeys: [] },
  );

  test("INVARIANT (fuzz): no field lets attacker content escape its quoted phrase", () => {
    fc.assert(
      fc.property(boeSearchQueryArb, (query) => {
        const q = extractQueryString(buildSearchQuery(query));
        const stripped = stripQuotedPhrases(q);
        expect(isParenBalanced(stripped)).toBe(true);
        expect(stripGrammarTokens(stripped)).toBe("");
      }),
      propertyConfig(),
    );
  });
});
