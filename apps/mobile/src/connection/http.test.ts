import { afterEach, describe, expect, jest, test } from "bun:test";

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
});
