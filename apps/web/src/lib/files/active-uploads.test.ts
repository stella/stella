import { afterEach, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";
import { BLOB_HASH_CHUNK_BYTES, sha256Hex } from "@stll/sha256/browser";

import {
  hasActiveUpload,
  hashActiveUploadFile,
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

  const hashed = hashActiveUploadFile(file);
  await firstChunkRead.promise;
  expect(hasActiveUpload()).toBe(true);

  releaseFirstChunk.resolve(undefined);
  expect(await hashed).toBe(await sha256Hex(bytes));
  expect(chunkReads).toBe(3);
  expect(hasActiveUpload()).toBe(false);
});

test("a failed standalone hash releases only its own reload guard", async () => {
  const releaseUpload = retainActiveUpload();
  const readFailure = new DOMException("File read failed", "NotReadableError");
  class UnreadableChunk extends Blob {
    override async arrayBuffer(): Promise<ArrayBuffer> {
      return await Promise.reject(readFailure);
    }
  }
  class UnreadableFile extends Blob {
    override slice(): Blob {
      return new UnreadableChunk();
    }
  }

  expect(
    await rejectionOf(hashActiveUploadFile(new UnreadableFile(["bytes"]))),
  ).toBe(readFailure);
  expect(hasActiveUpload()).toBe(true);
  releaseUpload();
  expect(hasActiveUpload()).toBe(false);
});
