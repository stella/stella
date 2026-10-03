import { QueryClient } from "@tanstack/react-query";
import { describe, expect, spyOn, test } from "bun:test";
import * as v from "valibot";

import { statutesIndexSearchSchema } from "@/features/statutes/statute-index-search.logic";
import { loadPublicStatutesIndex } from "@/routes/law/-statutes-index.logic";

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
