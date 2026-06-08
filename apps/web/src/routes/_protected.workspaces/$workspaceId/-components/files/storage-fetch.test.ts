import { afterEach, describe, expect, mock, test } from "bun:test";

import { APIError } from "@/lib/errors";
import { fetchStorageArrayBuffer } from "@/routes/_protected.workspaces/$workspaceId/-components/files/storage-fetch";

const originalFetch = globalThis.fetch;
type FetchHandler = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("storage fetches", () => {
  test("returns the response body and forwards the abort signal", async () => {
    const controller = new AbortController();
    const response = new Response("hello");
    const fetchMock = setFetch(mock(async () => response));

    const buffer = await fetchStorageArrayBuffer("https://storage.local/file", {
      signal: controller.signal,
      purpose: "display",
    });

    expect(new TextDecoder().decode(buffer)).toBe("hello");
    expect(fetchMock).toHaveBeenCalledWith("https://storage.local/file", {
      signal: controller.signal,
    });
  });

  test("preserves storage HTTP status failures", async () => {
    setFetch(mock(async () => new Response("denied", { status: 403 })));

    const error = await catchError(
      async () =>
        await fetchStorageArrayBuffer("https://storage.local/file", {
          signal: new AbortController().signal,
          purpose: "download",
        }),
    );

    expect(APIError.is(error)).toBe(true);
    expect(error).toMatchObject({
      status: 403,
      details: { phase: "response", purpose: "download" },
    });
  });

  test("wraps pre-response storage network failures without raw browser text", async () => {
    setFetch(
      mock(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    const error = await catchError(
      async () =>
        await fetchStorageArrayBuffer("https://storage.local/file", {
          signal: new AbortController().signal,
          purpose: "display",
        }),
    );

    expect(APIError.is(error)).toBe(true);
    expect(error).toMatchObject({
      status: 0,
      details: {
        causeType: "TypeError",
        phase: "response",
        purpose: "display",
      },
    });
    expect(
      error instanceof Error ? error.message : String(error),
    ).not.toContain("Failed to fetch");
    expect(JSON.stringify(error)).not.toContain("Failed to fetch");
  });

  test("wraps response body storage network failures", async () => {
    const response = new Response("ignored");
    Object.defineProperty(response, "arrayBuffer", {
      value: mock(async () => {
        throw new TypeError("NetworkError when attempting to fetch resource.");
      }),
    });
    setFetch(mock(async () => response));

    const error = await catchError(
      async () =>
        await fetchStorageArrayBuffer("https://storage.local/file", {
          signal: new AbortController().signal,
          purpose: "native-display",
        }),
    );

    expect(APIError.is(error)).toBe(true);
    expect(error).toMatchObject({
      status: 0,
      details: {
        causeType: "TypeError",
        phase: "body",
        purpose: "native-display",
      },
    });
    expect(JSON.stringify(error)).not.toContain(
      "NetworkError when attempting to fetch resource.",
    );
  });

  test("rethrows aborted fetch and body-read errors", async () => {
    const fetchAbort = new DOMException("Aborted", "AbortError");
    const fetchController = new AbortController();
    fetchController.abort();
    setFetch(
      mock(async () => {
        throw fetchAbort;
      }),
    );

    const fetchError = await catchError(
      async () =>
        await fetchStorageArrayBuffer("https://storage.local/file", {
          signal: fetchController.signal,
          purpose: "display",
        }),
    );

    expect(fetchError).toBe(fetchAbort);

    const bodyAbort = new DOMException("Aborted", "AbortError");
    const bodyController = new AbortController();
    bodyController.abort();
    const response = new Response("ignored");
    Object.defineProperty(response, "arrayBuffer", {
      value: mock(async () => {
        throw bodyAbort;
      }),
    });
    setFetch(mock(async () => response));

    const bodyError = await catchError(
      async () =>
        await fetchStorageArrayBuffer("https://storage.local/file", {
          signal: bodyController.signal,
          purpose: "download",
        }),
    );

    expect(bodyError).toBe(bodyAbort);
  });
});

const setFetch = (handler: FetchHandler) => {
  const nextFetch = Object.assign(handler, {
    preconnect: originalFetch.preconnect,
  });
  globalThis.fetch = nextFetch;
  return nextFetch;
};

const catchError = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error;
  }

  throw new Error("Expected operation to throw");
};
