import { panic } from "better-result";

export const S3_DELETION_EFFECT_TYPE = "s3_delete" as const;
export const S3_DELETION_EFFECT_CHUNK_SIZE = 50;
export const DESTRUCTIVE_EFFECT_CHUNK_INSERT_BATCH_SIZE = 250;
const RETRY_BASE_DELAY_MS = 60_000;
const RETRY_MAX_DELAY_MS = 24 * 60 * 60_000;

export type S3DeletionEffectChunk = {
  chunkIndex: number;
  effectType: typeof S3_DELETION_EFFECT_TYPE;
  payloadHash: string;
  s3Keys: string[];
};

type ConsumeInBatchesOptions<T> = {
  batchSize: number;
  consume: (batch: T[]) => Promise<void>;
  items: readonly T[];
};

/**
 * Serial transaction connections cannot execute inserts concurrently. This
 * recursive drain keeps every statement bounded without adding a loop-lint
 * exception at each ledger producer.
 */
export const consumeInBatches = async <T>({
  batchSize,
  consume,
  items,
}: ConsumeInBatchesOptions<T>): Promise<void> => {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    panic("Batch size must be a positive safe integer");
  }
  const consumeFrom = async (start: number): Promise<void> => {
    if (start >= items.length) {
      return;
    }
    await consume(items.slice(start, start + batchSize));
    await consumeFrom(start + batchSize);
  };
  await consumeFrom(0);
};

const sha256 = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

/**
 * Canonicalize keys before paging so the same parent intent always produces
 * the same `(chunkIndex, payloadHash)` identities, independent of discovery
 * order or duplicate references.
 */
export const createS3DeletionEffectChunks = (
  keys: readonly string[],
): S3DeletionEffectChunk[] => {
  const canonicalKeys = [...new Set(keys)].sort();
  const chunks: S3DeletionEffectChunk[] = [];
  for (
    let start = 0;
    start < canonicalKeys.length;
    start += S3_DELETION_EFFECT_CHUNK_SIZE
  ) {
    const s3Keys = canonicalKeys.slice(
      start,
      start + S3_DELETION_EFFECT_CHUNK_SIZE,
    );
    const chunkIndex = chunks.length;
    chunks.push({
      chunkIndex,
      effectType: S3_DELETION_EFFECT_TYPE,
      payloadHash: sha256(JSON.stringify(s3Keys)),
      s3Keys,
    });
  }
  return chunks;
};

export const assertValidS3DeletionEffectChunk = ({
  chunkIndex,
  payloadHash,
  s3Keys,
}: Pick<
  S3DeletionEffectChunk,
  "chunkIndex" | "payloadHash" | "s3Keys"
>): void => {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    panic("Destructive-effect chunk index must be a non-negative integer");
  }
  if (s3Keys.length < 1 || s3Keys.length > S3_DELETION_EFFECT_CHUNK_SIZE) {
    panic("Destructive-effect chunk exceeds its key bound");
  }
  if (payloadHash !== sha256(JSON.stringify(s3Keys))) {
    panic("Destructive-effect chunk payload hash does not match its keys");
  }
};

export const getDestructiveEffectRetryAt = ({
  attemptCount,
  now,
}: {
  attemptCount: number;
  now: Date;
}): Date => {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 30);
  const delayMs = Math.min(
    RETRY_BASE_DELAY_MS * 2 ** exponent,
    RETRY_MAX_DELAY_MS,
  );
  return new Date(now.getTime() + delayMs);
};
