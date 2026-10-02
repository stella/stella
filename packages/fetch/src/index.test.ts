import { describe, expect, test } from "bun:test";

import { FetchBoundaryError } from "@stll/errors";

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
  for (const message of [
    "Unable to connect",
    "TLS handshake failed",
    "DNS lookup failed",
  ]) {
    test(`classifies ${message} at the shared boundary`, async () => {
      const cause = new TypeError(message);
      const request = createFetchWithTimeout(async () => {
        throw cause;
      });
      const error = await request("https://example.com", {
        timeoutMs: 1000,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(FetchBoundaryError);
      expect(error).toMatchObject({ failureKind: "source_unreachable", cause });
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
