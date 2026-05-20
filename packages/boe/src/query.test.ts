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
});
