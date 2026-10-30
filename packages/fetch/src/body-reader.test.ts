import { afterEach, describe, expect, jest, test } from "bun:test";

import {
  BodyByteLimitError,
  iterateBodyWithIdleDeadline,
  readBodyWithIdleDeadline,
} from "./index";
import { raceAbort } from "./race-abort";

const flush = async () => {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
};

afterEach(() => {
  jest.useRealTimers();
});

describe("idle-bounded response body reads", () => {
  test("the iterator re-arms its deadline for each progressing chunk", async () => {
    jest.useFakeTimers();
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
        },
      }),
    );
    const values: number[] = [];
    const result = (async () => {
      for await (const chunk of iterateBodyWithIdleDeadline(response, {
        idleMs: 10,
      })) {
        values.push(chunk[0] ?? 0);
      }
    })();
    for (const value of [1, 2, 3]) {
      jest.advanceTimersByTime(9);
      stream?.enqueue(Uint8Array.of(value));
      await flush();
    }
    stream?.close();
    await result;
    expect(values).toEqual([1, 2, 3]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("the iterator propagates abort identity and detaches its listener", async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    let listeners = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(
      controller.signal,
    );
    controller.signal.addEventListener = (
      type: string,
      callback: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      listeners += 1;
      return add(type, callback, options);
    };
    controller.signal.removeEventListener = (
      type: string,
      callback: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      listeners -= 1;
      return remove(type, callback, options);
    };
    const reason = new DOMException("caller stopped", "AbortError");
    const result = (async () => {
      for await (const _chunk of iterateBodyWithIdleDeadline(
        new Response(new ReadableStream<Uint8Array>()),
        { idleMs: 10, signal: controller.signal },
      )) {
        // The fixture never yields.
      }
    })().catch((error: unknown) => error);
    controller.abort(reason);
    await flush();
    expect(await result).toBe(reason);
    expect(listeners).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("the abort race detaches its listener after completion", async () => {
    const controller = new AbortController();
    let listeners = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(
      controller.signal,
    );
    controller.signal.addEventListener = (
      type: string,
      callback: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      listeners += 1;
      return add(type, callback, options);
    };
    controller.signal.removeEventListener = (
      type: string,
      callback: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      listeners -= 1;
      return remove(type, callback, options);
    };
    expect(await raceAbort(Promise.resolve("done"), controller.signal)).toBe(
      "done",
    );
    expect(listeners).toBe(0);
  });
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

  test("a body over its byte limit is cancelled before another chunk is buffered", async () => {
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelledWith: unknown;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
        },
        cancel(reason) {
          cancelledWith = reason;
        },
      }),
    );
    const result = readBodyWithIdleDeadline(response, {
      idleMs: 1000,
      maxBytes: 3,
    }).catch((error: unknown) => error);

    stream?.enqueue(Uint8Array.of(1, 2));
    stream?.enqueue(Uint8Array.of(3, 4));
    await flush();

    const failure = await result;
    expect(failure).toBeInstanceOf(BodyByteLimitError);
    expect(failure).toMatchObject({ limit: 3 });
    await flush();
    expect(cancelledWith).toBe(failure);
  });

  test("a never-settling cancellation cannot delay an idle timeout", async () => {
    jest.useFakeTimers();
    let cancelledWith: unknown;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        async cancel(reason) {
          cancelledWith = reason;
          await new Promise<void>(() => {});
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

  test("a rejected cancellation does not replace the timeout reason", async () => {
    jest.useFakeTimers();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        async cancel() {
          await Promise.reject(new Error("cancel failed"));
        },
      }),
    );
    const result = readBodyWithIdleDeadline(response, { idleMs: 10 }).catch(
      (error: unknown) => error,
    );

    jest.advanceTimersByTime(10);
    await flush();

    expect(await result).toMatchObject({ name: "TimeoutError" });
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
