import { expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import { forEachOcrDerivativePage } from "./ocr-derivative-pages";

test("walks every OCR derivative through bounded cursor pages", async () => {
  const runs = Array.from({ length: 1001 }, (_, index) => ({
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 1001 - index)),
    id: toSafeId<"documentProcessingRun">(Bun.randomUUIDv7()),
  }));
  const cursors: ({ createdAt: Date; id: string } | null)[] = [];
  const handledPageSizes: number[] = [];

  await forEachOcrDerivativePage({
    readPage: async (cursor, limit) => {
      cursors.push(cursor);
      return cursor === null ? runs.slice(0, limit) : runs.slice(limit);
    },
    onPage: async (page) => {
      handledPageSizes.push(page.length);
    },
  });

  expect(cursors).toEqual([null, runs.at(999) ?? null]);
  expect(handledPageSizes).toEqual([1000, 1]);
});

test("handles a full page before reading past it", async () => {
  const runs = Array.from({ length: 2000 }, (_, index) => ({
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 2000 - index)),
    id: toSafeId<"documentProcessingRun">(Bun.randomUUIDv7()),
  }));
  const events: string[] = [];

  await forEachOcrDerivativePage({
    readPage: async (cursor, limit) => {
      events.push(cursor === null ? "read:first" : "read:next");
      return cursor === null ? runs.slice(0, limit) : [];
    },
    onPage: async () => {
      events.push("handle");
    },
  });

  expect(events).toEqual(["read:first", "handle", "read:next"]);
});
