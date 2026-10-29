import { describe, expect, test } from "bun:test";

import { createApiClient } from "@stll/api-client";
import type { FetchWithTimeoutInit } from "@stll/fetch";

import { createWebApiFetcher } from "@/lib/api";

type TestRoutes = {
  v1: {
    result: {
      get: {
        body: unknown;
        params: unknown;
        query: unknown;
        headers: unknown;
        response: { 200: { ready: boolean } };
      };
    };
  };
};

type FetchCall = {
  init: FetchWithTimeoutInit;
  url: string | URL | Request;
};

const recordingOwner = (response = Response.json({ ready: true })) => {
  const calls: FetchCall[] = [];
  const fetcher = createWebApiFetcher(async (url, init) => {
    calls.push({ init, url });
    return response;
  });
  return { calls, fetcher };
};

const testClient = (fetcher: ReturnType<typeof createWebApiFetcher>) =>
  createApiClient<TestRoutes>("https://example.test", { fetcher }).v1;

describe("web API fetcher timeout policy", () => {
  test("gives the shared fetch owner the default total request bound", async () => {
    const owner = recordingOwner();

    await owner.fetcher("https://example.test", {});

    expect(owner.calls).toHaveLength(1);
    expect(owner.calls[0]?.init.timeoutMs).toBe(30_000);
  });

  test("keeps the caller abort signal", async () => {
    const owner = recordingOwner();
    const controller = new AbortController();

    await testClient(owner.fetcher).result.get({
      fetch: { signal: controller.signal },
    });

    expect(owner.calls[0]?.init.signal).toBe(controller.signal);
  });

  test("gives the shared fetch owner a per-call total timeout override", async () => {
    const owner = recordingOwner();

    await owner.fetcher("https://example.test", { timeoutMs: 5 });

    expect(owner.calls[0]?.init.timeoutMs).toBe(5);
  });

  test("parses a completed JSON response", async () => {
    const owner = recordingOwner(
      Response.json({ ready: true }, { headers: { "x-result": "ready" } }),
    );

    const result = await testClient(owner.fetcher).result.get();

    expect(result.data).toEqual({ ready: true });
    expect(result.headers.get("x-result")).toBe("ready");
  });
});
