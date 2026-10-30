import { describe, expect, test } from "bun:test";

import { createFetchWithTimeout } from "./index";
import type { FetchWithTimeoutInit } from "./index";

const policies = [
  { timeoutMs: 1000 },
  { timeout: { type: "total", ms: 1000 } },
  { timeout: { type: "headers", ms: 1000 } },
  { timeout: { type: "idle", ms: 1000 } },
] as const satisfies readonly FetchWithTimeoutInit[];

describe("response body identity", () => {
  for (const policy of policies) {
    test(`preserves the response for ${JSON.stringify(policy)}`, async () => {
      const underlyingResponse = new Response(
        JSON.stringify({ authenticated: true }),
        { headers: { "content-type": "application/json" } },
      );
      const request = createFetchWithTimeout(async () => underlyingResponse);
      const result = await request("https://example.com", policy);

      expect(result).toBe(underlyingResponse);
      // whatwg-fetch's readers operate on the Response instance rather than a
      // replacement body, as do the text/arrayBuffer-only Playwright readers.
      expect(await result.json()).toEqual({ authenticated: true });
    });

    test(`supports text-only consumers for ${JSON.stringify(policy)}`, async () => {
      const underlyingResponse = new Response("signed in");
      const request = createFetchWithTimeout(async () => underlyingResponse);
      const result = await request("https://example.com", policy);
      const playwrightReader = {
        arrayBuffer: result.arrayBuffer.bind(result),
        text: result.text.bind(result),
      };

      expect(result).toBe(underlyingResponse);
      expect(await playwrightReader.text()).toBe("signed in");
    });
  }

  test("a total deadline rejects a body read with its deadline reason", async () => {
    let deadlineSignal: AbortSignal | undefined;
    const request = createFetchWithTimeout(async (_input, init) => {
      deadlineSignal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener(
            "abort",
            () => controller.error(init.signal?.reason),
            { once: true },
          );
        },
      });
      return new Response(body);
    });
    const response = await request("https://example.com", {
      timeout: { type: "total", ms: 5 },
    });

    const failure = await response.text().catch((error: unknown) => error);
    expect(failure).toBe(deadlineSignal?.reason);
    expect(failure).toMatchObject({ name: "TimeoutError" });
  });
});
