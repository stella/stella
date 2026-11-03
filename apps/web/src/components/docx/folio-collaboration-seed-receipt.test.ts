import { Result } from "better-result";
import { expect, test } from "bun:test";
import { Doc, encodeStateAsUpdate } from "yjs";

import { sha256Hex } from "@stll/sha256/browser";

import { APIError } from "@/lib/errors/api";

import {
  completeFolioSeedReceipt,
  FolioCollaborationSeedPreparingError,
  waitForFolioCollaborationSeed,
} from "./folio-collaboration-seed-receipt";

test("captures the pristine cut before later edits and waits for its receipt plus durable flush", async () => {
  const document = new Doc();
  document.getText("body").insert(0, "Saved clause");
  const pristine = encodeStateAsUpdate(document);
  const pristineHash = await sha256Hex(pristine);
  const acknowledged = Promise.withResolvers<undefined>();
  const flushed = Promise.withResolvers<undefined>();
  const flushing = Promise.withResolvers<undefined>();
  let receivedHash: string | undefined;
  let firstStoredHash: string | undefined;
  let outcome: string | undefined;
  const pending = completeFolioSeedReceipt({
    snapshotBytes: pristine,
    acknowledge: async (hash) => {
      receivedHash = hash;
      await acknowledged.promise;
    },
    flushSnapshot: async () => {
      firstStoredHash = await sha256Hex(encodeStateAsUpdate(document));
      flushing.resolve(undefined);
      await flushed.promise;
    },
    isCurrent: () => true,
    onRetry: () => undefined,
    signal: new AbortController().signal,
  }).then((result) => {
    outcome = result.status;
    return result;
  });
  document.getText("body").insert(0, "Unsaved edit. ");
  // Even callers that reuse their input buffer cannot change the captured cut.
  pristine.fill(0);
  expect(outcome).toBeUndefined();
  acknowledged.resolve(undefined);
  await flushing.promise;
  expect(receivedHash).toBe(pristineHash);
  expect(receivedHash).not.toBe(firstStoredHash);
  expect(outcome).toBeUndefined();
  flushed.resolve(undefined);
  expect(await pending).toEqual({ status: "acknowledged" });
  document.destroy();
});

test("an old generation receipt cannot flush or unlock its replacement", async () => {
  const acknowledged = Promise.withResolvers<undefined>();
  const acknowledging = Promise.withResolvers<undefined>();
  let generation = 1;
  let flushes = 0;
  const pending = completeFolioSeedReceipt({
    snapshotBytes: new Uint8Array([1, 2, 3]),
    acknowledge: async () => {
      acknowledging.resolve(undefined);
      await acknowledged.promise;
    },
    flushSnapshot: async () => {
      flushes += 1;
    },
    isCurrent: () => generation === 1,
    onRetry: () => undefined,
    signal: new AbortController().signal,
  });
  await acknowledging.promise;
  generation = 2;
  acknowledged.resolve(undefined);
  expect(await pending).toEqual({ status: "superseded" });
  expect(flushes).toBe(0);
});

test("transient receipt retries replay the same immutable hash", async () => {
  const hashes: string[] = [];
  const waits: number[] = [];
  const result = await completeFolioSeedReceipt({
    snapshotBytes: new Uint8Array([1, 2, 3]),
    acknowledge: async (hash) => {
      hashes.push(hash);
      if (hashes.length === 1) {
        throw new TypeError("Connection interrupted");
      }
    },
    flushSnapshot: async () => undefined,
    isCurrent: () => true,
    onRetry: () => undefined,
    signal: new AbortController().signal,
    wait: async (delayMs) => {
      waits.push(delayMs);
    },
  });
  expect(result).toEqual({ status: "acknowledged" });
  expect(hashes).toHaveLength(2);
  expect(new Set(hashes).size).toBe(1);
  expect(waits).toHaveLength(1);
  expect(waits.at(0)).toBeGreaterThan(0);
});

test("persistent receipt failure exhausts a bounded retry policy", async () => {
  let attempts = 0;
  let waits = 0;
  const failure = new TypeError("Connection interrupted");
  const result = await completeFolioSeedReceipt({
    snapshotBytes: new Uint8Array([1, 2, 3]),
    acknowledge: async () => {
      attempts += 1;
      throw failure;
    },
    flushSnapshot: async () => undefined,
    isCurrent: () => true,
    onRetry: () => undefined,
    signal: new AbortController().signal,
    wait: async () => {
      waits += 1;
    },
  });
  expect(result).toEqual({ status: "failed", error: failure });
  expect(attempts).toBe(5);
  expect(waits).toBe(4);
});

test.each([403, 409])(
  "an API refusal with status %i stops stale seed receipt retries",
  async (status) => {
    let attempts = 0;
    let waits = 0;
    const failure = new APIError({
      message: "Room generation changed",
      status,
    });
    const result = await completeFolioSeedReceipt({
      snapshotBytes: new Uint8Array([1, 2, 3]),
      acknowledge: async () => {
        attempts += 1;
        throw failure;
      },
      flushSnapshot: async () => undefined,
      isCurrent: () => true,
      onRetry: () => undefined,
      signal: new AbortController().signal,
      wait: async () => {
        waits += 1;
      },
    });

    expect(result).toEqual({ status: "failed", error: failure });
    expect(attempts).toBe(1);
    expect(waits).toBe(0);
  },
);

test("another opener waits silently until the seed receipt and initial snapshot are ready", async () => {
  let attempts = 0;
  let waits = 0;
  const joined = await waitForFolioCollaborationSeed({
    join: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new FolioCollaborationSeedPreparingError({
          message: "Preparing",
        });
      }
      return { generation: 4, shouldSeed: false };
    },
    signal: new AbortController().signal,
    wait: async () => {
      waits += 1;
    },
  });
  expect(joined.unwrap()).toEqual({ generation: 4, shouldSeed: false });
  expect(attempts).toBe(3);
  expect(waits).toBe(2);
});

test("a permanent join refusal is returned without preparation retries", async () => {
  const failure = new TypeError("Access refused");
  let waits = 0;
  const joined = await waitForFolioCollaborationSeed({
    join: async () => {
      throw failure;
    },
    signal: new AbortController().signal,
    wait: async () => {
      waits += 1;
    },
  });
  expect(Result.isError(joined) && joined.error).toBe(failure);
  expect(waits).toBe(0);
});
