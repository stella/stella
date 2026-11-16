import { panic, Result, TaggedError } from "better-result";

import { backoffDelay } from "@stll/concurrency/backoff-delay";
import { sleep } from "@stll/concurrency/sleep";
import { FetchBoundaryError } from "@stll/errors";
import { sha256Hex } from "@stll/sha256/browser";

import { APIError } from "@/lib/errors/api";

const SEED_RECEIPT_MAX_ATTEMPTS = 5;
const SEED_RECEIPT_RETRY_BASE_MS = 1000;
const SEED_RECEIPT_RETRY_MAX_MS = 10_000;

type CompleteFolioSeedReceiptOptions = {
  snapshotBytes: Uint8Array;
  acknowledge: (snapshotSha256Hex: string) => Promise<void>;
  flushSnapshot: () => Promise<unknown>;
  isCurrent: () => boolean;
  onRetry: (error: unknown) => void;
  signal: AbortSignal;
  wait?: (delayMs: number) => Promise<void>;
};

/** Captures the pre-edit cut synchronously; only its receipt and durable flush unlock editing. */
export const completeFolioSeedReceipt = async ({
  snapshotBytes,
  acknowledge,
  flushSnapshot,
  isCurrent,
  onRetry,
  signal,
  wait = async (delayMs) => await sleep(delayMs, { signal }),
}: CompleteFolioSeedReceiptOptions) => {
  const isSuperseded = () => !isCurrent() || signal.aborted;
  const capturedBytes = Uint8Array.from(snapshotBytes);
  const snapshotSha256Hex = await sha256Hex(capturedBytes);
  for (let attempt = 0; attempt < SEED_RECEIPT_MAX_ATTEMPTS; attempt += 1) {
    if (isSuperseded()) {
      return { status: "superseded" } as const;
    }
    const receipt = await Result.tryPromise({
      try: async () => {
        await acknowledge(snapshotSha256Hex);
        if (isSuperseded()) {
          return;
        }
        await flushSnapshot();
      },
      catch: (cause) => cause,
    });
    if (isSuperseded()) {
      return { status: "superseded" } as const;
    }
    if (Result.isOk(receipt)) {
      return { status: "acknowledged" } as const;
    }
    if (
      attempt === SEED_RECEIPT_MAX_ATTEMPTS - 1 ||
      ((receipt.error instanceof FetchBoundaryError ||
        APIError.is(receipt.error)) &&
        (receipt.error.status === 403 || receipt.error.status === 409))
    ) {
      return { status: "failed", error: receipt.error } as const;
    }
    onRetry(receipt.error);
    const waited = await Result.tryPromise({
      try: async () =>
        await wait(
          backoffDelay(attempt + 1, {
            baseMs: SEED_RECEIPT_RETRY_BASE_MS,
            maxMs: SEED_RECEIPT_RETRY_MAX_MS,
          }),
        ),
      catch: (cause) => cause,
    });
    if (Result.isError(waited)) {
      return isSuperseded()
        ? ({ status: "superseded" } as const)
        : ({ status: "failed", error: waited.error } as const);
    }
  }
  return panic("Seed receipt retry policy must return an outcome");
};

export class FolioCollaborationSeedPreparingError extends TaggedError(
  "FolioCollaborationSeedPreparingError",
)<{ message: string }> {}

const SEED_JOIN_MAX_ATTEMPTS = 8;

type WaitForFolioCollaborationSeedOptions<T> = {
  join: () => Promise<T>;
  signal: AbortSignal;
  wait?: (delayMs: number) => Promise<void>;
};

/** A seed claim is temporary preparation; competing openers wait without a visible error. */
export const waitForFolioCollaborationSeed = async <T>({
  join,
  signal,
  wait = async (delayMs) => await sleep(delayMs, { signal }),
}: WaitForFolioCollaborationSeedOptions<T>) => {
  for (let attempt = 0; attempt < SEED_JOIN_MAX_ATTEMPTS; attempt += 1) {
    const joined = await Result.tryPromise({
      try: join,
      catch: (cause) => cause,
    });
    if (
      Result.isOk(joined) ||
      !(joined.error instanceof FolioCollaborationSeedPreparingError) ||
      attempt === SEED_JOIN_MAX_ATTEMPTS - 1
    ) {
      return joined;
    }
    const waited = await Result.tryPromise({
      try: async () =>
        await wait(
          backoffDelay(attempt + 1, {
            baseMs: SEED_RECEIPT_RETRY_BASE_MS,
            maxMs: SEED_RECEIPT_RETRY_MAX_MS,
          }),
        ),
      catch: (cause) => cause,
    });
    if (Result.isError(waited)) {
      return waited;
    }
  }
  return panic("Seed preparation retry policy must return an outcome");
};
