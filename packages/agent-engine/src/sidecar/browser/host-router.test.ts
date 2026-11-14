import { describe, expect, test } from "bun:test";

import {
  BROWSER_CONTROL_ERROR_CODE,
  type BrowserControlCommand,
} from "@stll/api-contract/browser-control";

import type { BrowserHost } from "./browser-host";
import { createHostRouter } from "./host-router";
import { localBrowserResult, readLocalBrowserResult } from "./local-result";

/** A host that answers every command with its own name, and records what it got. */
const fakeHost = (name: string, acts: boolean) => {
  const requests: string[] = [];
  const released: string[] = [];
  const cancelled: string[] = [];
  const host: BrowserHost = {
    acts,
    cancel: ({ controllerId }) => {
      cancelled.push(controllerId);
    },
    releaseChat: (controllerId) => {
      released.push(controllerId);
    },
    request: async ({ command, controllerId }) => {
      requests.push(`${controllerId}:${command.action}`);
      return await Promise.resolve(
        localBrowserResult({
          code: BROWSER_CONTROL_ERROR_CODE.executionFailed,
          message: name,
          protocolVersion: 7,
          status: "error",
        }),
      );
    },
  };
  return { cancelled, host, released, requests };
};

const OPEN = { action: "open", url: "https://research.example.com/" } as const;
const SNAPSHOT = { action: "snapshot" } as const;

const routed = async (
  router: ReturnType<typeof createHostRouter>,
  command: BrowserControlCommand,
  controllerId = "chat-1",
) => {
  const result = readLocalBrowserResult(
    await router.request(
      {
        command,
        controllerId,
        observedTab: null,
        toolCallId: "call",
        turnId: "run",
      },
      new AbortController().signal,
    ),
  );
  return result.status === "error" ? result.message : result.status;
};

const setup = ({
  extension,
  stella,
}: {
  /** null: no bridge; else whether it is ready. */
  extension: boolean | null;
  stella: boolean;
}) => {
  const chrome = fakeHost("member-chrome", true);
  const stellaBrowser = fakeHost("stella-browser", false);
  const state = { ready: extension === true };
  const router = createHostRouter({
    extension:
      extension === null
        ? null
        : { host: chrome.host, ready: () => state.ready },
    stellaBrowser: stella ? stellaBrowser.host : null,
  });
  return { chrome, router, state, stellaBrowser };
};

describe("which browser a chat's commands go to", () => {
  // switch off | on; extension: none, connected but not ready, ready
  test.each([
    { extension: true, stella: false, opens: "member-chrome" },
    { extension: false, stella: false, opens: "member-chrome" },
    { extension: true, stella: true, opens: "member-chrome" },
    { extension: false, stella: true, opens: "stella-browser" },
    { extension: null, stella: true, opens: "stella-browser" },
  ] as const)(
    "extension $extension, stella browser $stella: open goes to $opens",
    async ({ extension, opens, stella }) => {
      const { router } = setup({ extension, stella });
      expect(await routed(router, OPEN)).toBe(opens);
      expect(await routed(router, SNAPSHOT)).toBe(opens);
    },
  );

  test("with no browser at all, a command says so", async () => {
    const router = createHostRouter({ extension: null, stellaBrowser: null });
    const result = readLocalBrowserResult(
      await router.request(
        {
          command: OPEN,
          controllerId: "chat-1",
          observedTab: null,
          toolCallId: "call",
          turnId: "run",
        },
        new AbortController().signal,
      ),
    );
    expect(result).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.disconnected,
      status: "error",
    });
  });

  test("a chat stays with the browser its last open went to until it opens again", async () => {
    const { chrome, router, state, stellaBrowser } = setup({
      extension: false,
      stella: true,
    });
    expect(await routed(router, OPEN)).toBe("stella-browser");
    expect(router.actsFor("chat-1")).toBe(false);
    // The extension connects mid-chat: the chat's reads stay where its tab is.
    state.ready = true;
    expect(await routed(router, SNAPSHOT)).toBe("stella-browser");
    expect(router.actsFor("chat-1")).toBe(false);
    // A chat that has not opened anything yet goes to the member's Chrome.
    expect(router.actsFor("chat-2")).toBe(true);
    // Its next open moves to the member's Chrome and leaves its tabs behind.
    expect(await routed(router, OPEN)).toBe("member-chrome");
    expect(stellaBrowser.released).toEqual(["chat-1"]);
    expect(router.actsFor("chat-1")).toBe(true);
    expect(chrome.requests).toEqual(["chat-1:open"]);
  });

  test("a stop and a chat's end reach every browser", () => {
    const { chrome, router, stellaBrowser } = setup({
      extension: true,
      stella: true,
    });
    router.cancel({ controllerId: "chat-1", turnId: "run" });
    router.releaseChat("chat-1");
    expect(chrome.cancelled).toEqual(["chat-1"]);
    expect(stellaBrowser.cancelled).toEqual(["chat-1"]);
    expect(chrome.released).toEqual(["chat-1"]);
    expect(stellaBrowser.released).toEqual(["chat-1"]);
  });
});
