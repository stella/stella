import { Result } from "better-result";
import { expect, test } from "bun:test";

import { createTtlResultCache } from "@/api/lib/legal-search/browse-facets-cache";

test("decision caches require an admission step", () => {
  // @ts-expect-error Decision candidates require admission on every read.
  createTtlResultCache({
    load: async () => Result.ok(["decision"]),
    key: () => "decisions",
    ttlMs: 60_000,
    maxEntries: 1,
  });
  createTtlResultCache({
    load: async () => Result.ok(["decision"]),
    // @ts-expect-error The readmit policy requires an admission function.
    publication: { kind: "readmit" },
    key: () => "decisions",
    ttlMs: 60_000,
    maxEntries: 1,
  });
  const publication = {
    kind: "public-static",
    reason: "Static fixture.",
  } as const;
  createTtlResultCache({
    load: async () => Result.ok(["decision"]),
    // @ts-expect-error Decision caches require readmit publication.
    publication,
    key: () => "decisions",
    ttlMs: 60_000,
    maxEntries: 1,
  });
});

test("concurrent responses admit independently while sharing candidates", async () => {
  let loads = 0;
  let admissions = 0;
  const read = createTtlResultCache({
    load: async () => {
      loads += 1;
      return Result.ok(["decision"]);
    },
    publication: {
      kind: "readmit",
      admit: async (rows) => {
        admissions += 1;
        return Result.ok(rows);
      },
    },
    key: () => "decisions",
    ttlMs: 60_000,
    maxEntries: 1,
  });
  const responses = await Promise.all([read(undefined), read(undefined)]);
  expect(loads).toBe(1);
  expect(admissions).toBe(2);
  expect(responses).toEqual([Result.ok(["decision"]), Result.ok(["decision"])]);
});

test("admission failures are returned and checked again on the next read", async () => {
  let admissions = 0;
  const read = createTtlResultCache({
    load: async () => Result.ok(["decision"]),
    publication: {
      kind: "readmit",
      admit: async (rows) => {
        admissions += 1;
        return admissions === 1
          ? Result.err("publication unavailable")
          : Result.ok(rows);
      },
    },
    key: () => "decisions",
    ttlMs: 60_000,
    maxEntries: 1,
  });
  expect(await read(undefined)).toEqual(Result.err("publication unavailable"));
  expect(await read(undefined)).toEqual(Result.ok(["decision"]));
  expect(admissions).toBe(2);
});
