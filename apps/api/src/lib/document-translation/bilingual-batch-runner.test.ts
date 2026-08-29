import { Result } from "better-result";
import { expect, test } from "bun:test";

import {
  DOCUMENT_TRANSLATION_BATCH_SIZE,
  runBilingualTranslationBatches,
} from "./bilingual-batch-runner";

const rows = Array.from(
  { length: DOCUMENT_TRANSLATION_BATCH_SIZE * 5 },
  (_, index) => index,
);

test("preserves translated context between larger ordered batches", async () => {
  const started: number[][] = [];
  const translated = new Set<number>();
  const precedingTargets: (number | null)[] = [];

  const outcome = await runBilingualTranslationBatches({
    items: rows,
    translate: async (batch) => {
      started.push([...batch]);
      const first = batch.at(0);
      if (first !== undefined) {
        precedingTargets.push(
          first === 0 || !translated.has(first - 1) ? null : first - 1,
        );
      }
      for (const row of batch) {
        translated.add(row);
      }
      return Result.ok();
    },
  });

  expect(Result.isOk(outcome)).toBe(true);
  expect(started).toHaveLength(5);
  expect(precedingTargets).toEqual([
    null,
    DOCUMENT_TRANSLATION_BATCH_SIZE - 1,
    DOCUMENT_TRANSLATION_BATCH_SIZE * 2 - 1,
    DOCUMENT_TRANSLATION_BATCH_SIZE * 3 - 1,
    DOCUMENT_TRANSLATION_BATCH_SIZE * 4 - 1,
  ]);
  expect(started.flat()).toEqual(rows);
});

test("does not start another wave after a translation batch fails", async () => {
  const started: number[][] = [];
  const outcome = await runBilingualTranslationBatches({
    items: rows,
    translate: async (batch) => {
      started.push([...batch]);
      return batch.at(0) === DOCUMENT_TRANSLATION_BATCH_SIZE
        ? Result.err("provider_failed" as const)
        : Result.ok();
    },
  });

  expect(outcome).toEqual(Result.err("provider_failed"));
  expect(started).toHaveLength(2);
});
