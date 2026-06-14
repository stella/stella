import { describe, expect, test } from "bun:test";

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

  test("free text of only symbols produces an empty query (no clause)", () => {
    expect(extractQueryString(buildSearchQuery({ text: "()[]:*?" }))).toBe("");
    expect(extractQueryString(buildSearchQuery({ text: "   " }))).toBe("");
  });
});
