import { describe, expect, test } from "bun:test";

import {
  S3_DELETION_EFFECT_CHUNK_SIZE,
  assertValidS3DeletionEffectChunk,
  consumeInBatches,
  createS3DeletionEffectChunks,
} from "@/api/lib/destructive-effect-chunks";

describe("destructive external-effect chunks", () => {
  test("canonical input reaches the same bounded fixed point", () => {
    const keys = Array.from(
      { length: S3_DELETION_EFFECT_CHUNK_SIZE * 2 + 1 },
      (_, index) => `tenant/object-${index.toString().padStart(3, "0")}`,
    );
    const first = createS3DeletionEffectChunks([
      ...keys.toReversed(),
      keys.at(0) ?? "",
      keys.at(-1) ?? "",
    ]);
    const replay = createS3DeletionEffectChunks(keys);

    expect(first).toEqual(replay);
    expect(first.map(({ s3Keys }) => s3Keys.length)).toEqual([
      S3_DELETION_EFFECT_CHUNK_SIZE,
      S3_DELETION_EFFECT_CHUNK_SIZE,
      1,
    ]);
    for (const chunk of first) {
      expect(() => assertValidS3DeletionEffectChunk(chunk)).not.toThrow();
    }
  });

  test("rejects payload drift under a pinned hash", () => {
    const chunk = createS3DeletionEffectChunks(["tenant/object-a"])[0];
    if (!chunk) {
      throw new Error("Expected one effect chunk");
    }

    expect(() =>
      assertValidS3DeletionEffectChunk({
        ...chunk,
        s3Keys: ["tenant/object-b"],
      }),
    ).toThrow("payload hash");
  });

  test("drains persistence batches serially without changing order", async () => {
    const consumed: number[][] = [];
    await consumeInBatches({
      batchSize: 2,
      consume: async (batch) => {
        consumed.push(batch);
      },
      items: [0, 1, 2, 3, 4],
    });

    expect(consumed).toEqual([[0, 1], [2, 3], [4]]);
  });

  test("rejects a non-positive persistence batch size", async () => {
    const rejection: unknown = await consumeInBatches({
      batchSize: 0,
      consume: async () => undefined,
      items: [1],
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({
      message: "Batch size must be a positive safe integer",
    });
  });
});
