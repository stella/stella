import { afterEach, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";
import { BLOB_HASH_CHUNK_BYTES, sha256Hex } from "@stll/sha256/browser";

import {
  hasActiveUpload,
  hashUploadFile,
  resetActiveUploadsForTests,
  retainActiveUpload,
  withActiveUpload,
} from "@/lib/files/active-uploads";

afterEach(() => {
  resetActiveUploadsForTests();
});

test("overlapping upload batches stay active until each one releases", () => {
  const releaseFirst = retainActiveUpload();
  const releaseSecond = retainActiveUpload();
  expect(hasActiveUpload()).toBe(true);

  releaseFirst();
  releaseFirst();
  expect(hasActiveUpload()).toBe(true);

  releaseSecond();
  expect(hasActiveUpload()).toBe(false);
});

test("an upload counts while it runs and releases when it fails", async () => {
  const pending = Promise.withResolvers<never>();
  const upload = withActiveUpload(async () => await pending.promise);
  expect(hasActiveUpload()).toBe(true);

  pending.reject(new Error("network"));
  expect(await rejectionOf(upload)).toBeInstanceOf(Error);
  expect(hasActiveUpload()).toBe(false);
});

test("an upload hash keeps the reload guard on until its last chunk is read", async () => {
  const bytes = new Uint8Array(BLOB_HASH_CHUNK_BYTES * 2 + 3).fill(7);
  const firstChunkRead = Promise.withResolvers<undefined>();
  const releaseFirstChunk = Promise.withResolvers<undefined>();
  let chunkReads = 0;
  // Holds the first chunk read open, the way a slow disk would.
  class GatedChunk extends Blob {
    override async arrayBuffer(): Promise<ArrayBuffer> {
      chunkReads += 1;
      if (chunkReads === 1) {
        firstChunkRead.resolve(undefined);
        await releaseFirstChunk.promise;
      }
      return await super.arrayBuffer();
    }
  }
  class GatedFile extends Blob {
    override slice(start?: number, end?: number): Blob {
      return new GatedChunk([super.slice(start, end)]);
    }
  }
  const file = new GatedFile([bytes]);

  const hashed = withActiveUpload(
    async (active) => await hashUploadFile(active, file),
  );
  await firstChunkRead.promise;
  expect(hasActiveUpload()).toBe(true);

  releaseFirstChunk.resolve(undefined);
  expect(await hashed).toBe(await sha256Hex(bytes));
  expect(chunkReads).toBe(3);
  expect(hasActiveUpload()).toBe(false);
});
