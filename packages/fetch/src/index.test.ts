import { describe, expect, test } from "bun:test";

import { createFetchWithTimeout } from "./index";
import type { FetchWithTimeoutInit } from "./index";

describe("createFetchWithTimeout", () => {
  for (const code of [
    "ConnectionRefused",
    "FailedToOpenSocket",
    "ConnectionClosed",
    "ENOTFOUND",
    "ETIMEDOUT",
  ]) {
    test(`preserves raw transport error identity for ${code}`, async () => {
      const cause = Object.assign(new TypeError("Recorded transport failure"), {
        code,
      });
      const request = createFetchWithTimeout(async () => {
        throw cause;
      });
      expect(
        await request("https://example.com", { timeoutMs: 1000 }).then(
          () => undefined,
          (error: unknown) => error,
        ),
      ).toBe(cause);
    });
  }

  // Both forms of a total deadline ride the transport's own signal, so the
  // caller reads the body the transport produced (and the browser's network
  // inspection sees it), never a script stream wrapped around it.
  for (const [form, deadline] of [
    ["numeric", (ms: number): FetchWithTimeoutInit => ({ timeoutMs: ms })],
    [
      "total",
      (ms: number): FetchWithTimeoutInit => ({
        timeout: { type: "total", ms },
      }),
    ],
  ] as const) {
    test(`a ${form} deadline hands back the transport's response unchanged`, async () => {
      const transportResponse = new Response("payload");
      let received: RequestInit | undefined;
      const request = createFetchWithTimeout(async (_input, init) => {
        received = init;
        return transportResponse;
      });
      const response = await request("https://example.com", deadline(1000));
      expect(response).toBe(transportResponse);
      expect(await response.text()).toBe("payload");
      expect(received?.signal?.aborted).toBe(false);
    });

    test(`a ${form} deadline still bounds the whole exchange`, async () => {
      let signal: AbortSignal | null | undefined;
      const request = createFetchWithTimeout(async (_input, init) => {
        signal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const reason: unknown = init.signal?.reason;
            reject(
              reason instanceof Error ? reason : new Error("Transport aborted"),
            );
          });
        });
      });
      const outcome = await request("https://example.com", deadline(5)).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(signal?.aborted).toBe(true);
      expect(outcome instanceof DOMException ? outcome.name : outcome).toBe(
        "TimeoutError",
      );
    });

    test(`a ${form} deadline keeps bounding the body after headers arrive`, async () => {
      let signal: AbortSignal | null | undefined;
      const aborted = Promise.withResolvers<unknown>();
      const request = createFetchWithTimeout(async (_input, init) => {
        signal = init?.signal;
        signal?.addEventListener(
          "abort",
          () => aborted.resolve(init?.signal?.reason),
          { once: true },
        );
        return new Response(new ReadableStream<Uint8Array>());
      });
      await request("https://example.com", deadline(5));
      expect(signal?.aborted).toBe(false);
      expect(await aborted.promise).toMatchObject({ name: "TimeoutError" });
    });
  }

  test("caller cancellation retains its original reason", async () => {
    const controller = new AbortController();
    const cause = new DOMException("Cycle ended", "AbortError");
    controller.abort(cause);
    const request = createFetchWithTimeout(async () => {
      throw cause;
    });
    expect(
      await request("https://example.com", {
        timeoutMs: 1000,
        signal: controller.signal,
      }).then(
        () => undefined,
        (error: unknown) => error,
      ),
    ).toBe(cause);
  });

  for (const cause of [
    Object.assign(new Error("Unexpected redirect"), {
      code: "UnexpectedRedirect",
    }),
    new TypeError("Invalid URL"),
    new TypeError("Invalid HTTP method"),
  ]) {
    test(`preserves non-transport failure: ${cause.message}`, async () => {
      const request = createFetchWithTimeout(async () => {
        throw cause;
      });
      expect(
        await request("https://example.com", { timeoutMs: 1000 }).then(
          () => undefined,
          (error: unknown) => error,
        ),
      ).toBe(cause);
    });
  }
  test("forwards request options through the configured fetcher", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchWithTimeout = createFetchWithTimeout(async (_input, init) => {
      capturedInit = init;
      return new Response(null, { status: 204 });
    });

    const response = await fetchWithTimeout("https://example.com/resource", {
      headers: { Accept: "application/json" },
      method: "POST",
      timeoutMs: 1000,
    });

    expect(response.status).toBe(204);
    expect(capturedInit).toMatchObject({
      headers: { Accept: "application/json" },
      method: "POST",
    });
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
  });

  test("composes the Request abort signal", async () => {
    const requestController = new AbortController();
    let capturedSignal: AbortSignal | null | undefined;
    const fetchWithTimeout = createFetchWithTimeout(async (_input, init) => {
      capturedSignal = init?.signal;
      return new Response(null, { status: 204 });
    });

    await fetchWithTimeout(
      new Request("https://example.com/resource", {
        signal: requestController.signal,
      }),
      { timeoutMs: 1000 },
    );

    expect(capturedSignal?.aborted).toBe(false);
    requestController.abort();
    expect(capturedSignal?.aborted).toBe(true);
  });

  test("composes the caller abort signal", async () => {
    const callerController = new AbortController();
    let capturedSignal: AbortSignal | null | undefined;
    const fetchWithTimeout = createFetchWithTimeout(async (_input, init) => {
      capturedSignal = init?.signal;
      return new Response(null, { status: 204 });
    });

    await fetchWithTimeout("https://example.com/resource", {
      signal: callerController.signal,
      timeoutMs: 1000,
    });

    expect(capturedSignal?.aborted).toBe(false);
    callerController.abort();
    expect(capturedSignal?.aborted).toBe(true);
  });
});
