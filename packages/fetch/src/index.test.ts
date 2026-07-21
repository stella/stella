import { describe, expect, test } from "bun:test";

import { createFetchWithTimeout } from "./index";

const waitForAbort = async (signal: AbortSignal): Promise<void> => {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
};

describe("createFetchWithTimeout", () => {
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

  test("applies the required timeout", async () => {
    let capturedSignal: AbortSignal | null | undefined;
    const fetchWithTimeout = createFetchWithTimeout(async (_input, init) => {
      capturedSignal = init?.signal;
      return new Response(null, { status: 204 });
    });

    await fetchWithTimeout("https://example.com/resource", { timeoutMs: 1 });
    if (!capturedSignal) {
      throw new Error("Missing fetch signal");
    }
    await waitForAbort(capturedSignal);

    expect(capturedSignal.aborted).toBe(true);
  });
});
