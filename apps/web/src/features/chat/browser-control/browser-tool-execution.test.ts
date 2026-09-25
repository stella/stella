import { describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_CONTENT_TRUST,
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  type BrowserControlResult,
} from "@stll/api-contract/browser-control";

import { createBrowserApprovalStore } from "./browser-approval-mode";
import { createBrowserToolExecutionCache } from "./browser-tool-execution";

const success = {
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  snapshot: {
    contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
    elements: [],
    revision: "revision-1",
    text: "Ready",
    textOffset: 0,
    textTotalChars: 5,
    title: "Example",
    url: "https://example.com/",
  },
  status: "success",
} satisfies BrowserControlResult;

const redirected = {
  code: BROWSER_CONTROL_ERROR_CODE.redirected,
  message: "The page redirected to another website.",
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  status: "error",
} satisfies BrowserControlResult;

const untracked = () => () => undefined;

const sessionStore = () =>
  createBrowserApprovalStore(() => {
    throw new DOMException("No storage in tests", "SecurityError");
  });

describe("chat browser tool execution cache", () => {
  test("concurrent and later retries execute one real browser action", async () => {
    let calls = 0;
    const cache = createBrowserToolExecutionCache(async () => {
      calls += 1;
      await Promise.resolve();
      return success;
    }, untracked);

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
    }, untracked);

    await cache.executeOnce("call-1", { action: "snapshot" });
    await cache.executeOnce("call-2", { action: "snapshot" });
    expect(calls).toBe(2);
  });

  test("a redirected result stops later reads from auto-approving", async () => {
    const store = sessionStore();
    const results: BrowserControlResult[] = [success, redirected];
    const cache = createBrowserToolExecutionCache(
      async () => results.shift() ?? success,
      store.beginCommand,
    );

    await cache.executeOnce("call-1", { action: "snapshot" });
    expect(store.lastCommandSucceeded()).toBe(true);
    await cache.executeOnce("call-2", {
      action: "open",
      url: "https://a.test",
    });
    expect(store.lastCommandSucceeded()).toBe(false);
    // A coalesced retry of the earlier success is not a new outcome.
    await cache.executeOnce("call-1", { action: "snapshot" });
    expect(store.lastCommandSucceeded()).toBe(false);
  });

  test("a command still running blocks read auto-approval", async () => {
    const store = sessionStore();
    store.beginCommand()(true);
    let answer: (result: BrowserControlResult) => void = () => undefined;
    const cache = createBrowserToolExecutionCache(
      async () =>
        await new Promise<BrowserControlResult>((resolve) => {
          answer = resolve;
        }),
      store.beginCommand,
    );

    const pending = cache.executeOnce("call-1", { action: "snapshot" });
    expect(store.lastCommandSucceeded()).toBe(false);
    answer(success);
    await pending;
    expect(store.lastCommandSucceeded()).toBe(true);
  });

  test("an executor failure counts as a failed command", async () => {
    const store = sessionStore();
    store.beginCommand()(true);
    const cache = createBrowserToolExecutionCache(
      async () => await Promise.reject(new Error("postMessage failed")),
      store.beginCommand,
    );

    const outcome = await cache
      .executeOnce("call-1", { action: "snapshot" })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(outcome).toBeInstanceOf(Error);
    expect(store.lastCommandSucceeded()).toBe(false);
  });
});
