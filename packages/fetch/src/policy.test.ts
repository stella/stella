import { afterEach, describe, expect, jest, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { createFetchWithTimeout } from "./index";

const flush = async () => {
  // Stream pulls and reader continuations each enqueue a microtask.
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
};

const advance = async (ms: number) => {
  jest.advanceTimersByTime(ms);
  await flush();
};

const streamFixture = () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelledWith: unknown;
  let signal: AbortSignal | null | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel(reason) {
      cancelledWith = reason;
    },
  });
  const request = createFetchWithTimeout(async (_input, init) => {
    signal = init?.signal;
    return new Response(body, { headers: { "content-type": "text/plain" } });
  });
  return {
    request,
    chunk: () => controller?.enqueue(new Uint8Array([120])),
    close: () => controller?.close(),
    signal: () => signal,
    cancelledWith: () => cancelledWith,
  };
};

afterEach(() => {
  jest.useRealTimers();
});

describe("response timeout policies", () => {
  test("abort after an ignoring fetcher resolves cancels the response body", async () => {
    for (const type of ["headers", "idle"] as const) {
      const controller = new AbortController();
      const reason = new DOMException("Caller aborted", "AbortError");
      let cancelledWith: unknown;
      const body = new ReadableStream<Uint8Array>({
        cancel(value) {
          cancelledWith = value;
        },
      });
      const request = createFetchWithTimeout(async () => {
        const response = new Response(body);
        queueMicrotask(() => controller.abort(reason));
        return response;
      });
      const failure = await request("https://example.com", {
        signal: controller.signal,
        timeout: { type, ms: 1000 },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBe(reason);
      expect(cancelledWith).toBe(reason);
    }
  });

  test("idle timeout preserves a completed body when consumption starts later", async () => {
    jest.useFakeTimers();
    const fixture = streamFixture();
    fixture.chunk();
    fixture.close();
    const response = await fixture.request("https://example.com", {
      timeout: { type: "idle", ms: 20 },
    });
    await flush();
    await advance(100);
    expect(fixture.signal()?.aborted).toBe(false);
    expect(await response.text()).toBe("x");
    expect(jest.getTimerCount()).toBe(0);
  });

  test("idle timeout excludes consumer pauses while a body chunk is buffered", async () => {
    jest.useFakeTimers();
    const fixture = streamFixture();
    fixture.chunk();
    fixture.chunk();
    fixture.close();
    const response = await fixture.request("https://example.com", {
      timeout: { type: "idle", ms: 20 },
    });
    const reader = response.body?.getReader();
    expect(await reader?.read()).toEqual({
      done: false,
      value: new Uint8Array([120]),
    });
    await flush();
    await advance(100);
    expect(fixture.signal()?.aborted).toBe(false);
    expect(await reader?.read()).toEqual({
      done: false,
      value: new Uint8Array([120]),
    });
    expect(await reader?.read()).toEqual({ done: true, value: undefined });
    reader?.releaseLock();
    expect(jest.getTimerCount()).toBe(0);
  });

  test("idle timeout still aborts an upstream read pending after buffered chunks are consumed", async () => {
    jest.useFakeTimers();
    const fixture = streamFixture();
    fixture.chunk();
    const response = await fixture.request("https://example.com", {
      timeout: { type: "idle", ms: 20 },
    });
    const reader = response.body?.getReader();
    expect(await reader?.read()).toEqual({
      done: false,
      value: new Uint8Array([120]),
    });
    const pending = reader?.read().catch((error: unknown) => error);
    await flush();
    await advance(19);
    expect(fixture.signal()?.aborted).toBe(false);
    await advance(1);
    expect(await pending).toMatchObject({ name: "TimeoutError" });
    expect(fixture.signal()?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("idle wrapper preserves response status, headers and transport metadata", async () => {
    jest.useFakeTimers();
    const original = new Response("content", {
      status: 206,
      statusText: "Partial Content",
      headers: { "content-type": "text/plain", "x-source": "upstream" },
    });
    Object.defineProperties(original, {
      url: { value: "https://example.com/redirected" },
      redirected: { value: true },
      type: { value: "cors" },
    });
    const request = createFetchWithTimeout(async () => original);
    const response = await request("https://example.com", {
      timeout: { type: "idle", ms: 20 },
    });
    expect(response.status).toBe(original.status);
    expect(response.statusText).toBe(original.statusText);
    expect([...response.headers]).toEqual([...original.headers]);
    expect(response.url).toBe(original.url);
    expect(response.redirected).toBe(original.redirected);
    expect(response.type).toBe(original.type);
    expect(await response.text()).toBe("content");
    expect(jest.getTimerCount()).toBe(0);
  });

  test("response without a body leaves no idle timer", async () => {
    jest.useFakeTimers();
    const request = createFetchWithTimeout(
      async () => new Response(null, { status: 204 }),
    );
    const response = await request("https://example.com", {
      timeout: { type: "idle", ms: 20 },
    });
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  test("transport failure before headers retains its reason and clears its timer", async () => {
    jest.useFakeTimers();
    const reason = new TypeError("Transport failed");
    const request = createFetchWithTimeout(async () => {
      throw reason;
    });
    expect(
      await request("https://example.com", {
        timeout: { type: "idle", ms: 20 },
      }).catch((error: unknown) => error),
    ).toBe(reason);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("synchronous transport failure clears its timer", async () => {
    jest.useFakeTimers();
    const reason = new TypeError("Synchronous transport failure");
    const request = createFetchWithTimeout(() => {
      throw reason;
    });
    expect(
      await request("https://example.com", {
        timeout: { type: "headers", ms: 20 },
      }).catch((error: unknown) => error),
    ).toBe(reason);
    expect(jest.getTimerCount()).toBe(0);
  });

  for (const ms of [Number.NaN, Number.POSITIVE_INFINITY, -1, 2_147_483_648]) {
    test(`invalid timeout duration ${ms} rejects before calling the transport`, async () => {
      jest.useFakeTimers();
      let requests = 0;
      const request = createFetchWithTimeout(async () => {
        requests += 1;
        return new Response(null);
      });
      expect(
        await request("https://example.com", {
          timeout: { type: "headers", ms },
        }).catch((error: unknown) => error),
      ).toMatchObject({ name: "NotSupportedError" });
      expect(requests).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
    });
  }

  test("header timeout stops when headers arrive and leaves the body readable", async () => {
    jest.useFakeTimers();
    const fixture = streamFixture();
    const response = await fixture.request("https://example.com", {
      timeout: { type: "headers", ms: 20 },
    });
    expect(jest.getTimerCount()).toBe(0);
    const result = response.text();
    await advance(100);
    fixture.chunk();
    fixture.close();
    expect(await result).toBe("x");
    expect(fixture.signal()?.aborted).toBe(false);
  });

  for (const type of ["headers", "idle"] as const) {
    test(`${type} timeout aborts a request whose headers never arrive`, async () => {
      jest.useFakeTimers();
      const request = createFetchWithTimeout(
        async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.throwIfAborted();
            init?.signal?.addEventListener(
              "abort",
              () => {
                if (init.signal?.reason instanceof Error) {
                  reject(init.signal.reason);
                }
              },
              {
                once: true,
              },
            );
          }),
      );
      const result = request("https://example.com", {
        timeout: { type, ms: 20 },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      await flush();
      await advance(20);
      expect(await result).toMatchObject({ name: "TimeoutError" });
      expect(jest.getTimerCount()).toBe(0);
    });
  }

  test("idle timeout permits a transfer longer than its window while chunks keep arriving", async () => {
    jest.useFakeTimers();
    const fixture = streamFixture();
    const response = await fixture.request("https://example.com", {
      timeout: { type: "idle", ms: 20 },
    });
    const result = response.text().then(
      (text) => ({ type: "complete", text }) as const,
      (error: unknown) => ({ type: "failed", error }) as const,
    );
    for (let index = 0; index < 6; index += 1) {
      await advance(15);
      expect(fixture.signal()?.aborted).toBe(false);
      fixture.chunk();
      await flush();
    }
    fixture.close();
    expect(await result).toEqual({ type: "complete", text: "xxxxxx" });
    expect(fixture.signal()?.aborted).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("idle timeout aborts a stalled body and cancels the source", async () => {
    jest.useFakeTimers();
    const fixture = streamFixture();
    const response = await fixture.request("https://example.com", {
      timeout: { type: "idle", ms: 20 },
    });
    const result = response.text().then(
      () => undefined,
      (error: unknown) => error,
    );
    await advance(10);
    fixture.chunk();
    await flush();
    await advance(19);
    expect(fixture.signal()?.aborted).toBe(false);
    await advance(1);
    const reason = await result;
    expect(reason).toMatchObject({ name: "TimeoutError" });
    expect(fixture.signal()?.reason).toBe(reason);
    expect(fixture.cancelledWith()).toBe(reason);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("caller abort during a body read retains its reason and clears the timer", async () => {
    jest.useFakeTimers();
    const fixture = streamFixture();
    const controller = new AbortController();
    const reason = new DOMException("Caller cancelled", "AbortError");
    const response = await fixture.request("https://example.com", {
      timeout: { type: "idle", ms: 20 },
      signal: controller.signal,
    });
    const result = response.text().then(
      () => undefined,
      (error: unknown) => error,
    );
    await flush();
    controller.abort(reason);
    expect(await result).toBe(reason);
    expect(fixture.cancelledWith()).toBe(reason);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("reader cancellation clears the idle timer and cancels the source", async () => {
    jest.useFakeTimers();
    const fixture = streamFixture();
    const response = await fixture.request("https://example.com", {
      timeout: { type: "idle", ms: 20 },
    });
    const reason = "Reader cancelled";
    await response.body?.cancel(reason);
    expect(fixture.cancelledWith()).toBe(reason);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("body failure retains its reason and clears the idle timer", async () => {
    jest.useFakeTimers();
    const reason = new TypeError("Source failed");
    const request = createFetchWithTimeout(
      async () =>
        new Response(
          new ReadableStream({
            start: (controller) => controller.error(reason),
          }),
        ),
    );
    const response = await request("https://example.com", {
      timeout: { type: "idle", ms: 20 },
    });
    expect(await response.text().catch((error: unknown) => error)).toBe(reason);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("idle windows follow chunk gaps independently of total transfer duration", async () => {
    jest.useFakeTimers();
    await assertProperty(
      "idle windows follow chunk gaps independently of total transfer duration",
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 30 }), {
          minLength: 1,
          maxLength: 8,
        }),
        async (gaps) => {
          const timersBefore = jest.getTimerCount();
          const fixture = streamFixture();
          const response = await fixture.request("https://example.com", {
            timeout: { type: "idle", ms: 20 },
          });
          const result = response.text().then(
            (text) => ({ type: "complete", text }) as const,
            (error: unknown) => ({ type: "failed", error }) as const,
          );
          let chunks = 0;
          let stalled = false;
          for (const gap of gaps) {
            await advance(gap);
            if (gap >= 20) {
              stalled = true;
              break;
            }
            fixture.chunk();
            chunks += 1;
            await flush();
          }
          if (!stalled) {
            fixture.close();
          }
          const outcome = await result;
          if (stalled) {
            expect(outcome).toMatchObject({
              type: "failed",
              error: { name: "TimeoutError" },
            });
          } else {
            expect(outcome).toEqual({
              type: "complete",
              text: "x".repeat(chunks),
            });
          }
          expect(jest.getTimerCount()).toBe(timersBefore);
        },
      ),
      { numRuns: 50 },
    );
  });
});
