import { QueryClient } from "@tanstack/react-query";
import { describe, expect, spyOn, test } from "bun:test";
import * as v from "valibot";

import { statutesInfiniteOptions } from "@/features/statutes/queries/statutes";
import { statutesIndexSearchSchema } from "@/features/statutes/statute-index-search.logic";
import { statuteDocumentIdentity } from "@/lib/legal/statute-act-number";
import {
  createStatuteListFilters,
  loadPublicStatutesIndex,
} from "@/routes/law/-statutes-index.logic";

test.each([
  { eli: "/eli/cz/sb/2012/89", country: "CZE" },
  { eli: "/eli/sk/zz/1964/40", country: "SVK" },
  { eli: "/eli/sk/zz/2015/300", country: "SVK" },
  { eli: "CZ/2012/89", country: "CZE" },
])(
  "the year list filter agrees with the displayed statute identity for $eli",
  ({ eli, country }) => {
    const identity = statuteDocumentIdentity(eli);
    const search = v.parse(statutesIndexSearchSchema, {
      year: identity.year === null ? undefined : Number(identity.year),
    });
    const filters = createStatuteListFilters(country, search);
    expect(filters.year ?? null).toBe(statuteDocumentIdentity(eli).year);
  },
);

test("publication year scopes statute list filters and cache identity", () => {
  const search = v.parse(statutesIndexSearchSchema, {
    type: "statute",
    year: 2012,
  });
  const filters = createStatuteListFilters("cze", search);
  expect(filters).toEqual({
    country: "CZE",
    documentType: "statute",
    year: "2012",
  });
  const options = statutesInfiniteOptions(filters);
  expect(options.queryKey.at(-1)).toMatchObject({ year: "2012" });
  expect(options.queryKey).not.toEqual(
    statutesInfiniteOptions({ ...filters, year: "2013" }).queryKey,
  );
});

test("publication year reaches the public statute list request", async () => {
  const requests: URL[] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof globalThis.fetch>[0]) => {
        requests.push(
          new URL(input instanceof Request ? input.url : String(input)),
        );
        return Response.json({ items: [], nextCursor: null });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const queryClient = new QueryClient();
  try {
    await queryClient.fetchInfiniteQuery(
      statutesInfiniteOptions(
        createStatuteListFilters(
          "svk",
          v.parse(statutesIndexSearchSchema, { year: 1964 }),
        ),
      ),
    );
    expect(requests).toHaveLength(1);
    expect(requests.at(0)?.pathname).toBe("/v1/law/statutes");
    expect(requests.at(0)?.searchParams.get("country")).toBe("SVK");
    expect(requests.at(0)?.searchParams.get("year")).toBe("1964");
  } finally {
    fetch.mockRestore();
    queryClient.clear();
  }
});

describe("public statute full-text loader", () => {
  for (const cause of ["enter", "preload", "stay"] as const) {
    test(`${cause} returns the server shell without starting API queries`, async () => {
      const requests: string[] = [];
      const fetch = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          async (input: Parameters<typeof globalThis.fetch>[0]) => {
            requests.push(input instanceof Request ? input.url : String(input));
            return Response.json({ items: [], nextCursor: null });
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      );
      const queryClient = new QueryClient();
      const searches = ["contractual obligations", "občanské právo"];
      try {
        for (const q of searches) {
          const result = await loadPublicStatutesIndex({
            cause,
            country: "cze",
            queryClient,
            search: v.parse(statutesIndexSearchSchema, { q, type: "statute" }),
          });
          expect(result).toEqual({ statutes: [] });
          // Query creation precedes a request: an empty cache rules out background prefetch too.
          expect(queryClient.getQueryCache().getAll()).toEqual([]);
          expect(requests).toEqual([]);
        }
      } finally {
        fetch.mockRestore();
        queryClient.clear();
      }
    });
  }
});
