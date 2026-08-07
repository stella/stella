import { expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";

import type { OcrDerivativeCursor } from "./ocr-derivative-pages";
import { forEachOcrDerivativePage } from "./ocr-derivative-pages";

const CLEANUP_BATCH_SIZE = 1000;

/**
 * Stands in for the paged `document_processing_runs` read. The cursor is the
 * previous page's last run id, so the reader resumes at the position of that
 * id in the total order — the same thing `ocrDerivativeCursorFilter` asks the
 * database for. The order itself (and the microsecond boundary comparison it
 * rests on) is exercised against Postgres in `ocr-derivative-pages.db.test.ts`;
 * this file covers the walk's exactly-once and bounded-page behaviour.
 */
const createPageReader =
  (orderedIds: readonly SafeId<"documentProcessingRun">[]) =>
  async (cursor: OcrDerivativeCursor | null, limit: number) => {
    const start = cursor === null ? 0 : orderedIds.indexOf(cursor) + 1;
    return await Promise.resolve(
      orderedIds.slice(start, start + limit).map((id) => ({ id })),
    );
  };

const runIds = (count: number): SafeId<"documentProcessingRun">[] =>
  Array.from({ length: count }, (_, index) =>
    toSafeId<"documentProcessingRun">(`run-${String(index).padStart(4, "0")}`),
  );

test("visits every run exactly once across page boundaries", async () => {
  const orderedIds = runIds(2500);
  const visited: string[] = [];

  await forEachOcrDerivativePage({
    readPage: createPageReader(orderedIds),
    onPage: async (page) => {
      for (const run of page) {
        visited.push(run.id);
      }
    },
  });

  expect(visited).toEqual(orderedIds);
  expect(new Set(visited).size).toBe(orderedIds.length);
});

test("visits every run exactly once when the total is an exact page multiple", async () => {
  const orderedIds = runIds(CLEANUP_BATCH_SIZE * 2);
  const visited: string[] = [];

  await forEachOcrDerivativePage({
    readPage: createPageReader(orderedIds),
    onPage: async (page) => {
      for (const run of page) {
        visited.push(run.id);
      }
    },
  });

  expect(new Set(visited).size).toBe(orderedIds.length);
});

test("walks every OCR derivative through bounded cursor pages", async () => {
  const runs = Array.from({ length: 1001 }, () => ({
    id: toSafeId<"documentProcessingRun">(Bun.randomUUIDv7()),
  }));
  const cursors: (OcrDerivativeCursor | null)[] = [];
  const handledPageSizes: number[] = [];

  await forEachOcrDerivativePage({
    readPage: async (cursor, limit) => {
      cursors.push(cursor);
      return await Promise.resolve(
        cursor === null ? runs.slice(0, limit) : runs.slice(limit),
      );
    },
    onPage: async (page) => {
      handledPageSizes.push(page.length);
    },
  });

  expect(cursors).toEqual([null, runs.at(999)?.id ?? null]);
  expect(handledPageSizes).toEqual([1000, 1]);
});

test("handles a full page before reading past it", async () => {
  const runs = Array.from({ length: 2000 }, () => ({
    id: toSafeId<"documentProcessingRun">(Bun.randomUUIDv7()),
  }));
  const events: string[] = [];

  await forEachOcrDerivativePage({
    readPage: async (cursor, limit) => {
      events.push(cursor === null ? "read:first" : "read:next");
      return await Promise.resolve(cursor === null ? runs.slice(0, limit) : []);
    },
    onPage: async () => {
      events.push("handle");
    },
  });

  expect(events).toEqual(["read:first", "handle", "read:next"]);
});
