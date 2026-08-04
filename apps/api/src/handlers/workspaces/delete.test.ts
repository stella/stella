import { expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import { deleteOcrDerivativePages } from "./delete";

test("deletes every OCR derivative through bounded cursor pages", async () => {
  const runs = Array.from({ length: 1001 }, (_, index) => ({
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 1001 - index)),
    id: toSafeId<"documentProcessingRun">(Bun.randomUUIDv7()),
  }));
  const cursors: ({ createdAt: Date; id: string } | null)[] = [];
  const deletedPageSizes: number[] = [];

  await deleteOcrDerivativePages({
    readPage: async (cursor, limit) => {
      cursors.push(cursor);
      return cursor === null ? runs.slice(0, limit) : runs.slice(limit);
    },
    deletePage: async (page) => {
      deletedPageSizes.push(page.length);
    },
  });

  expect(cursors).toEqual([null, runs.at(999)]);
  expect(deletedPageSizes).toEqual([1000, 1]);
});
