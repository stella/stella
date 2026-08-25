import { describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_CONTENT_TRUST,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  type BrowserControlResult,
} from "@stll/api-contract/browser-control";

import { createBrowserToolExecutionCache } from "./browser-tool-execution";

const success = {
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  snapshot: {
    contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
    elements: [],
    revision: "revision-1",
    text: "Ready",
    title: "Example",
    url: "https://example.com/",
  },
  status: "success",
} satisfies BrowserControlResult;

describe("chat browser tool execution cache", () => {
  test("concurrent and later retries execute one real browser action", async () => {
    let calls = 0;
    const cache = createBrowserToolExecutionCache(async () => {
      calls += 1;
      await Promise.resolve();
      return success;
    });

    const first = cache.executeOnce("call-1", { action: "click", ref: "e:0" });
    const concurrent = cache.executeOnce("call-1", {
      action: "click",
      ref: "e:0",
    });
    expect(await Promise.all([first, concurrent])).toEqual([success, success]);
    expect(
      await cache.executeOnce("call-1", { action: "click", ref: "e:0" }),
    ).toEqual(success);
    expect(calls).toBe(1);
  });

  test("different tool-call ids remain independent", async () => {
    let calls = 0;
    const cache = createBrowserToolExecutionCache(async () => {
      calls += 1;
      return success;
    });

    await cache.executeOnce("call-1", { action: "snapshot" });
    await cache.executeOnce("call-2", { action: "snapshot" });
    expect(calls).toBe(2);
  });
});
