import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { readCappedBytes } from "./streaming";

describe("readCappedBytes", () => {
  test("completed bytes do not need cancellation", async () => {
    let cancellations = 0;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.close();
      },
      cancel: () => {
        cancellations += 1;
      },
    });
    expect(await readCappedBytes(stream, 2)).toEqual(new Uint8Array([1, 2]));
    expect(cancellations).toBe(0);
    expect(stream.locked).toBe(false);
  });

  test("an overflow settles and unlocks before deferred cancellation", async () => {
    const started = Promise.withResolvers<undefined>();
    const cleanup = Promise.withResolvers<undefined>();
    const pending = Symbol("cleanup still pending");
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new Uint8Array([1, 2]));
      },
      cancel: async () => {
        started.resolve(undefined);
        await cleanup.promise;
      },
    });
    const reading = readCappedBytes(stream, 1);
    try {
      await started.promise;
      expect(
        await Promise.race([reading, Promise.resolve(pending)]),
      ).toBeNull();
      expect(stream.locked).toBe(false);
    } finally {
      cleanup.resolve(undefined);
      await reading;
    }
  });

  test("cancellation rejection does not replace an overflow", async () => {
    const cleanupFailure = new Error("Transport cleanup failed");
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new Uint8Array([1, 2]));
      },
      cancel: async () => {
        await Promise.reject(cleanupFailure);
      },
    });
    expect(await readCappedBytes(stream, 1)).toBeNull();
    expect(stream.locked).toBe(false);
  });

  test("an observer failure settles and unlocks before deferred cancellation", async () => {
    const started = Promise.withResolvers<undefined>();
    const cleanup = Promise.withResolvers<undefined>();
    const pending = Symbol("cleanup still pending");
    const failure = new Error("Chunk observation failed");
    let cancellationReason: unknown;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel: async (reason: unknown) => {
        cancellationReason = reason;
        started.resolve(undefined);
        await cleanup.promise;
      },
    });
    const reading = readCappedBytes(stream, 1, () => {
      throw failure;
    });
    try {
      await started.promise;
      const outcome = await Promise.race([
        reading,
        Promise.resolve(pending),
      ]).catch((error: unknown) => error);
      expect(outcome).toBe(failure);
      expect(cancellationReason).toBe(failure);
      expect(stream.locked).toBe(false);
    } finally {
      cleanup.resolve(undefined);
      await reading.catch((error: unknown) => {
        expect(error).toBe(failure);
      });
    }
  });

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

    expect(stream.locked).toBe(false);
  });

  test("shows every chunk read to the observer, including the overflowing one", async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
    const seen: Uint8Array[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });

    expect(
      await readCappedBytes(stream, 3, (chunk) => {
        seen.push(chunk);
      }),
    ).toBeNull();
    expect(seen).toEqual(chunks);
  });

  test("releases its reader lock when reading fails", async () => {
    const failure = new Error("stream failed");
    const stream = new ReadableStream<Uint8Array>({
      pull: () => {
        throw failure;
      },
    });

    const result = await Result.tryPromise({
      try: async () => await readCappedBytes(stream, 10),
      catch: (cause: unknown) => cause,
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("expected the stream read to fail");
    }
    expect(result.error).toBe(failure);

    expect(stream.locked).toBe(false);
  });
});
