import { Panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { readBoundedByGroup } from "./read-bounded";

describe("complete reads bounded per group", () => {
  test.each([
    { groups: [], cap: 2, overflow: false },
    { groups: [0, 2, 2], cap: 2, overflow: false },
    { groups: [3, 1], cap: 2, overflow: true },
    { groups: [1, 3], cap: 2, overflow: true },
    { groups: [2, 2, 6], cap: 2, overflow: true },
    { groups: [0], cap: 0, overflow: false },
    { groups: [1], cap: 0, overflow: true },
  ])(
    "refuses any sentinel in $groups with cap $cap",
    async ({ groups, cap, overflow }) => {
      const limited = { perGroupLimit: cap + 1 };
      const limits: number[] = [];
      const sourceRows = groups.flatMap((count, group) =>
        Array.from({ length: count }, (_unused, index) => ({ group, index })),
      );
      const result = await readBoundedByGroup(
        {
          limit: (limit) => {
            limits.push(limit);
            return limited;
          },
        },
        {
          cap,
          readRows: async (builder) => {
            expect(builder).toBe(limited);
            return Promise.resolve(
              sourceRows.filter(({ index }) => index < builder.perGroupLimit),
            );
          },
          groupKeyOf: (row) => row.group,
        },
      );
      expect(limits).toEqual([cap + 1]);
      expect(result).toEqual(
        overflow
          ? { type: "overflow", cap }
          : { type: "complete", rows: sourceRows },
      );
    },
  );

  test.each([
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
  ])("rejects invalid cap %s before limiting or reading", async (cap) => {
    const rows = [{ group: "first" }];
    let limits = 0;
    let reads = 0;
    const rejection: unknown = await readBoundedByGroup(
      {
        limit: () => {
          limits += 1;
          return rows;
        },
      },
      {
        cap,
        readRows: async (limited) => {
          reads += 1;
          return Promise.resolve(limited);
        },
        groupKeyOf: (row) => row.group,
      },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Panic);
    expect(limits).toBe(0);
    expect(reads).toBe(0);
  });

  test("query failures propagate without a complete or partial result", async () => {
    const rows = [{ group: "first" }];
    const failure = new DOMException("Read denied", "NotAllowedError");
    const rejection: unknown = await readBoundedByGroup(
      { limit: () => rows },
      {
        cap: 2,
        readRows: async () => Promise.reject(failure).then(() => rows),
        groupKeyOf: (row) => row.group,
      },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBe(failure);
  });
});
