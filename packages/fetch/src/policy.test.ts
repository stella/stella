import { afterEach, describe, expect, jest, test } from "bun:test";

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
    chunk: (value = "x") =>
      controller?.enqueue(new TextEncoder().encode(value)),
    close: () => controller?.close(),
    signal: () => signal,
    cancelledWith: () => cancelledWith,
  };
};

afterEach(() => {
  jest.useRealTimers();
});

describe("response timeout policies", () => {
  test("passes the effective timeout value to the owned transport", async () => {
    let observed: number | undefined;
    const request = createFetchWithTimeout(async (_input, init) => {
      observed = init?.timeoutMs;
      return new Response(null);
    });
    await request("https://example.com", {
      timeout: { type: "total", ms: 1234 },
    });
    expect(observed).toBe(1234);
  });

  test("reports a caller abort as the caller's typed abort reason", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Caller aborted", "AbortError");
    const request = createFetchWithTimeout(async (_input, init) => {
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () =>
            reject(
              init.signal?.reason instanceof Error
                ? init.signal.reason
                : new DOMException("Fetch aborted", "AbortError"),
            ),
          { once: true },
        );
      });
      throw new Error("unreachable");
    });
    const result = request("https://example.com", {
      signal: controller.signal,
      timeout: { type: "total", ms: 1000 },
    }).catch((error: unknown) => error);
    await flush();
    controller.abort(reason);
    expect(await result).toBe(reason);
  });

  test("a transport response that wins a caller abort remains settled without affecting the next request", async () => {
    const controller = new AbortController();
    let requests = 0;
    const request = createFetchWithTimeout(async () => {
      requests += 1;
      if (requests === 1) {
        controller.abort();
      }
      return new Response(String(requests));
    });

    const completed = await request("https://example.com/first", {
      signal: controller.signal,
      timeout: { type: "total", ms: 1000 },
    });
    const resumed = await request("https://example.com/second", {
      timeout: { type: "total", ms: 1000 },
    });

    expect(await completed.text()).toBe("1");
    expect(await resumed.text()).toBe("2");
  });

  test("abort after an ignoring fetcher resolves cancels the response body", async () => {
    for (const type of ["headers"] as const) {
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

  for (const policy of [{ timeout: { type: "headers", ms: 20 } }] as const) {
    const { type } = policy.timeout;
    test(`${type} policy clears its timer when the transport rejects before headers`, async () => {
      jest.useFakeTimers();
      const reason = new TypeError("Transport failed");
      const request = createFetchWithTimeout(async () => {
        throw reason;
      });
      expect(
        await request("https://example.com", policy).catch(
          (error: unknown) => error,
        ),
      ).toBe(reason);
      expect(jest.getTimerCount()).toBe(0);
    });
  }

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

  for (const type of ["headers"] as const) {
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
});
