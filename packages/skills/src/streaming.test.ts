import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { readCappedBytes } from "./streaming";

describe("readCappedBytes", () => {
  test("cancels an oversized stream and releases its reader lock", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
      start: (controller) => {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
    });

    expect(await readCappedBytes(stream, 2)).toBeNull();
    expect(cancelled).toBe(true);

    const reader = stream.getReader();
    reader.releaseLock();
  });

  test("releases its reader lock when reading fails", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull: () => {
        throw new Error("stream failed");
      },
    });

    const result = await Result.tryPromise(
      async () => await readCappedBytes(stream, 10),
    );
    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("expected the stream read to fail");
    }
    expect(result.error.message).toContain("stream failed");

    const reader = stream.getReader();
    reader.releaseLock();
  });
});
