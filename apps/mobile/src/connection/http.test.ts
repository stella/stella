import { afterEach, describe, expect, jest, test } from "bun:test";
import * as ReactNativeFetch from "whatwg-fetch";

import { fetchWithTimeout } from "./http";

const flush = async (): Promise<void> => {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
};

afterEach(() => {
  jest.useRealTimers();
});

describe("HTTP request deadline", () => {
  test("rejects when headers arrive but the response body stalls", async () => {
    jest.useFakeTimers();
    const fetch = async (): Promise<Response> =>
      new Response(new ReadableStream<Uint8Array>(), {
        headers: { "content-type": "application/json" },
      });

    const response = await fetchWithTimeout(fetch, "https://example.com");
    const body = response.json().catch((error: unknown) => error);
    await flush();
    expect(jest.getTimerCount()).toBe(1);

    jest.advanceTimersByTime(20_000);
    await flush();

    expect(await body).toMatchObject({ name: "AbortError" });
    expect(jest.getTimerCount()).toBe(0);
  });

  test("errors a stream read when the body stalls past the deadline", async () => {
    jest.useFakeTimers();
    // The fetch ignores its signal, so only the deadline can end the read.
    const fetch = async (): Promise<Response> =>
      new Response(new ReadableStream<Uint8Array>(), {
        headers: { "content-type": "application/octet-stream" },
      });

    const response = await fetchWithTimeout(fetch, "https://example.com");
    const stream = response.body;
    if (stream === null) {
      throw new Error("The response has a body");
    }
    const read = stream
      .getReader()
      .read()
      .catch((error: unknown) => error);
    await flush();
    expect(jest.getTimerCount()).toBe(1);

    jest.advanceTimersByTime(20_000);
    await flush();

    expect(await read).toMatchObject({ name: "AbortError" });
    expect(jest.getTimerCount()).toBe(0);
  });

  test("holds a clone's body to the same deadline", async () => {
    jest.useFakeTimers();
    const fetch = async (): Promise<Response> =>
      new Response(new ReadableStream<Uint8Array>(), {
        headers: { "content-type": "application/json" },
      });

    const response = await fetchWithTimeout(fetch, "https://example.com");
    const body = response
      .clone()
      .text()
      .catch((error: unknown) => error);
    await flush();

    jest.advanceTimersByTime(20_000);
    await flush();

    expect(await body).toMatchObject({ name: "AbortError" });
    expect(jest.getTimerCount()).toBe(0);
  });

  test("keeps the deadline for one branch when another is cancelled", async () => {
    jest.useFakeTimers();
    const fetch = async (): Promise<Response> =>
      new Response(new ReadableStream<Uint8Array>(), {
        headers: { "content-type": "application/json" },
      });

    const response = await fetchWithTimeout(fetch, "https://example.com");
    const clone = response.clone();
    const body = response.text().catch((error: unknown) => error);
    // A clone is one branch of a tee, whose cancel settles only once both
    // branches are cancelled, so it is started and not awaited.
    const cancelled = clone.body?.cancel("not needed");
    await flush();
    expect(jest.getTimerCount()).toBe(1);

    jest.advanceTimersByTime(20_000);
    await flush();

    expect(await body).toMatchObject({ name: "AbortError" });
    expect(jest.getTimerCount()).toBe(0);
    expect(cancelled).toBeInstanceOf(Promise);
  });

  test("cancels a stalled read through to the source", async () => {
    jest.useFakeTimers();
    const reasons: unknown[] = [];
    const fetch = async (): Promise<Response> =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel(reason) {
            reasons.push(reason);
          },
        }),
        { headers: { "content-type": "application/octet-stream" } },
      );

    const response = await fetchWithTimeout(fetch, "https://example.com");
    const stream = response.body;
    if (stream === null) {
      throw new Error("The response has a body");
    }
    const reader = stream.getReader();
    const read = reader.read();
    await flush();

    await reader.cancel("closed by the screen");

    expect(await read).toEqual({ done: true, value: undefined });
    expect(reasons).toEqual(["closed by the screen"]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("returns a complete response without leaving a timer", async () => {
    jest.useFakeTimers();
    const fetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ ready: true }), {
        headers: { "content-type": "application/json" },
      });

    const response = await fetchWithTimeout(fetch, "https://example.com");

    expect(await response.json()).toEqual({ ready: true });
    expect(jest.getTimerCount()).toBe(0);
  });

  test("reads a streamed body under React Native's fetch classes", async () => {
    const platform = {
      Headers: globalThis.Headers,
      Request: globalThis.Request,
      Response: globalThis.Response,
    };
    const streamed = () =>
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(
            new TextEncoder().encode(JSON.stringify({ ready: true })),
          );
          stream.close();
        },
      });
    // The phone's `Response` cannot take a stream: it keeps it as text.
    expect(await new ReactNativeFetch.Response(streamed()).text()).toBe(
      "[object ReadableStream]",
    );
    // Expo's fetch answers with its own streaming response, as the platform
    // one does here; the globals are the ones React Native installs.
    const fetch = async (): Promise<Response> =>
      new platform.Response(streamed(), {
        headers: { "content-type": "application/json" },
        status: 201,
      });
    Object.assign(globalThis, {
      Headers: ReactNativeFetch.Headers,
      Request: ReactNativeFetch.Request,
      Response: ReactNativeFetch.Response,
    });
    try {
      const response = await fetchWithTimeout(fetch, "https://example.com");

      expect(response.status).toBe(201);
      expect(response.ok).toBe(true);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.json()).toEqual({ ready: true });
    } finally {
      Object.assign(globalThis, platform);
    }
  });
});
