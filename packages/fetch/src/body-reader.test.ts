import { afterEach, describe, expect, jest, test } from "bun:test";

import { readBodyWithIdleDeadline } from "./index";

const flush = async () => {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
};

afterEach(() => {
  jest.useRealTimers();
});

describe("idle-bounded response body reads", () => {
  test("progress on every idle window permits a longer total download", async () => {
    jest.useFakeTimers();
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
        },
      }),
    );
    const result = readBodyWithIdleDeadline(response, { idleMs: 10 });

    for (const value of ["a", "b", "c"]) {
      jest.advanceTimersByTime(9);
      stream?.enqueue(new TextEncoder().encode(value));
      await flush();
    }
    stream?.close();
    await flush();

    expect(new TextDecoder().decode(await result)).toBe("abc");
    expect(jest.getTimerCount()).toBe(0);
  });

  test("a stalled body rejects with TimeoutError and is cancelled", async () => {
    jest.useFakeTimers();
    let cancelledWith: unknown;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel(reason) {
          cancelledWith = reason;
        },
      }),
    );
    const result = readBodyWithIdleDeadline(response, { idleMs: 10 }).catch(
      (error: unknown) => error,
    );

    jest.advanceTimersByTime(10);
    await flush();
    const failure = await result;
    expect(failure).toMatchObject({ name: "TimeoutError" });
    expect(cancelledWith).toBe(failure);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("stream failure and caller abort release their timers", async () => {
    jest.useFakeTimers();
    for (const mode of ["failure", "abort"] as const) {
      let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
      let cancelledWith: unknown;
      const controller = new AbortController();
      const reason = new DOMException(mode, "AbortError");
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            stream = value;
          },
          cancel(value) {
            cancelledWith = value;
          },
        }),
      );
      const result = readBodyWithIdleDeadline(response, {
        idleMs: 10,
        signal: controller.signal,
      }).catch((error: unknown) => error);

      if (mode === "failure") {
        stream?.error(reason);
      } else {
        controller.abort(reason);
      }
      await flush();
      expect(await result).toBe(reason);
      if (mode === "abort") {
        expect(cancelledWith).toBe(reason);
      }
      expect(jest.getTimerCount()).toBe(0);
    }
  });

  test("a null body yields empty bytes without a timer", async () => {
    jest.useFakeTimers();
    const bytes = await readBodyWithIdleDeadline(
      new Response(null, { status: 204 }),
      { idleMs: 10 },
    );
    expect(bytes).toEqual(new Uint8Array());
    expect(jest.getTimerCount()).toBe(0);
  });
});
