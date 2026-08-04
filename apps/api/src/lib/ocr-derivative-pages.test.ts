import { expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import type {
  OcrDerivativeCursor,
  OcrDerivativeRun,
} from "./ocr-derivative-pages";
import {
  forEachOcrDerivativePage,
  isAfterOcrDerivativeCursor,
} from "./ocr-derivative-pages";

const CLEANUP_BATCH_SIZE = 1000;

/**
 * Stands in for the paged `document_processing_runs` read: same total order and
 * same keyset predicate the SQL builders apply, so a walk over it exercises the
 * real page-boundary behaviour.
 */
const createPageReader = (runs: OcrDerivativeRun[]) => {
  // Ordinal id comparison, matching both Postgres's ordering and the
  // `isAfterOcrDerivativeCursor` tiebreaker. Locale collation would order
  // these opaque keys differently from the database.
  const byId = (left: string, right: string) => {
    if (left === right) {
      return 0;
    }
    return left < right ? -1 : 1;
  };
  const ordered = [...runs].sort(
    (left, right) =>
      right.createdAt.getTime() - left.createdAt.getTime() ||
      byId(left.id, right.id),
  );
  return async (cursor: OcrDerivativeCursor | null, limit: number) =>
    ordered
      .filter((run) => isAfterOcrDerivativeCursor(run, cursor))
      .slice(0, limit);
};

// Runs created in one transaction share a createdAt, so a page boundary can
// land inside a tied group. Without the id tiebreaker the walk would skip or
// repeat those members, silently orphaning or double-deleting derivatives.
test("visits every run exactly once across page boundaries, including createdAt ties", async () => {
  const runs = Array.from({ length: 2500 }, (_, index) => ({
    // Groups of 7 tied runs. 7 does not divide the 1000-run page size, so
    // both page boundaries land inside a tied group rather than between two.
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, Math.floor(index / 7))),
    id: toSafeId<"documentProcessingRun">(
      `run-${String(index).padStart(4, "0")}`,
    ),
  }));
  const visited: string[] = [];

  await forEachOcrDerivativePage({
    readPage: createPageReader(runs),
    onPage: async (page) => {
      for (const run of page) {
        visited.push(run.id);
      }
    },
  });

  expect(visited).toHaveLength(runs.length);
  expect(new Set(visited).size).toBe(runs.length);
  expect(new Set(visited)).toEqual(new Set(runs.map(({ id }) => id)));
});

test("visits every run exactly once when the total is an exact page multiple", async () => {
  const runs = Array.from({ length: CLEANUP_BATCH_SIZE * 2 }, (_, index) => ({
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index % 7)),
    id: toSafeId<"documentProcessingRun">(
      `run-${String(index).padStart(4, "0")}`,
    ),
  }));
  const visited: string[] = [];

  await forEachOcrDerivativePage({
    readPage: createPageReader(runs),
    onPage: async (page) => {
      for (const run of page) {
        visited.push(run.id);
      }
    },
  });

  expect(new Set(visited).size).toBe(runs.length);
});

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
