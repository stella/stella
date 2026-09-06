import { describe, expect, test } from "bun:test";

import { insertInChunks } from "@/api/lib/db/bulk-write";

/**
 * The batch size is what keeps a caller under PostgreSQL's bind-parameter cap,
 * so the two properties worth pinning are that every row is written exactly
 * once, in the caller's order, and that no single call carries more than the
 * cap allows. A helper that silently dropped a tail would look identical to a
 * caller: the insert returns nothing either way.
 */
describe("insertInChunks", () => {
  const capture = async (rows: readonly number[]) => {
    const batches: number[][] = [];
    await insertInChunks(rows, async (batch) => {
      batches.push(batch);
    });
    return batches;
  };

  test("writes nothing when there are no rows", async () => {
    expect(await capture([])).toEqual([]);
  });

  test("writes a set below the batch size as one statement", async () => {
    expect(await capture([1, 2, 3])).toEqual([[1, 2, 3]]);
  });

  test("splits a larger set and keeps every row, in order", async () => {
    const rows = Array.from({ length: 1201 }, (_, index) => index);

    const batches = await capture(rows);

    expect(batches.map((batch) => batch.length)).toEqual([500, 500, 201]);
    expect(batches.flat()).toEqual(rows);
  });

  test("stops at the first failing batch", async () => {
    const rows = Array.from({ length: 1200 }, (_, index) => index);
    const seen: number[][] = [];

    const failure = await insertInChunks(rows, async (batch) => {
      seen.push(batch);
      if (seen.length === 2) {
        throw new TypeError("insert failed");
      }
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(TypeError);
    // The third batch is never attempted: the caller's transaction decides what
    // happens to the first, so this must not keep writing past a failure.
    expect(seen).toHaveLength(2);
  });
});
