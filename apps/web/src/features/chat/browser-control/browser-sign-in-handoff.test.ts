import { afterEach, describe, expect, test } from "bun:test";

import {
  browserCommandHost,
  resetBrowserSignInHandoff,
  waitForBrowserSignIn,
} from "./browser-sign-in-handoff";

afterEach(() => {
  resetBrowserSignInHandoff();
});

describe("browser sign-in handoff", () => {
  test("extracts host from a command carrying a URL", () => {
    expect(
      browserCommandHost({
        action: "open",
        url: "https://portal.example.test/doc",
      }),
    ).toBe("portal.example.test");
    expect(browserCommandHost({ action: "snapshot" })).toBeNull();
  });

  test("resolves cancel immediately when the turn signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await waitForBrowserSignIn({
        host: "portal.example.test",
        signal: controller.signal,
      }),
    ).toBe("cancel");
  });

  test("resolves cancel if the turn is stopped while waiting", async () => {
    const controller = new AbortController();
    const pending = waitForBrowserSignIn({
      host: "portal.example.test",
      signal: controller.signal,
    });
    controller.abort();
    expect(await pending).toBe("cancel");
  });
});
