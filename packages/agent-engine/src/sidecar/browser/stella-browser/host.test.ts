import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import {
  BROWSER_CONTROL_ERROR_CODE,
  type BrowserControlCommand,
} from "@stll/api-contract/browser-control";
import { pageScript } from "@stll/browser-page/page-script";
import { waitFor } from "@stll/test-kit";

import { readLocalBrowserResult } from "../local-result";
import { CDP_METHOD_ALLOWLIST } from "./cdp-client";
import {
  createStellaBrowserHost,
  NOT_AVAILABLE_ON_STELLA_BROWSER,
} from "./host";

const ALLOWED: readonly string[] = CDP_METHOD_ALLOWLIST;

/**
 * The stella browser's lifecycle against a stand-in browser that speaks
 * the protocol over the same pipe (`scripts/fake-cdp-browser.ts`): it
 * starts on the first open, runs the shared page script in an isolated
 * world, starts again after a crash, and closes once no chat has a tab.
 */

// timeout: each test starts one or two stand-in browsers.
setDefaultTimeout(30_000);

const FAKE_BROWSER = path.join(
  import.meta.dir,
  "../../../../scripts/fake-cdp-browser.ts",
);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

const receivedSchema = v.object({
  method: v.string(),
  params: v.optional(v.record(v.string(), v.unknown())),
});

const start = () => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-browser-host-"));
  cleanups.push(() => {
    rmSync(root, { force: true, recursive: true });
  });
  const executable = path.join(root, "browser");
  writeFileSync(
    executable,
    `#!/bin/sh\nexec "${process.execPath}" "${FAKE_BROWSER}" "$@"\n`,
  );
  chmodSync(executable, 0o755);
  const lines: string[] = [];
  const host = createStellaBrowserHost({
    accountOrigin: () => "https://api.example-stella.com",
    environment: { PATH: process.env["PATH"] },
    home: null,
    log: (line) => {
      lines.push(line);
    },
    platform: process.platform,
    profileRoot: path.join(root, "browser-profiles"),
    testHooks: { args: [], executable, methodLog: null },
  });
  cleanups.push(host.stop);
  /** Every message the stand-in browsers received, in order. */
  const received = () => {
    const profiles = path.join(root, "browser-profiles");
    const member = existsSync(profiles) ? readdirSync(profiles) : [];
    const log = path.join(profiles, member[0] ?? "", "profile", "fake-cdp.log");
    return existsSync(log)
      ? readFileSync(log, "utf-8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => v.parse(receivedSchema, JSON.parse(line)))
      : [];
  };
  const send = async (
    command: BrowserControlCommand,
    controllerId = "chat-1",
  ) =>
    readLocalBrowserResult(
      await host.request(
        {
          command,
          controllerId,
          observedTab: null,
          toolCallId: "call-1",
          turnId: "run-1",
        },
        new AbortController().signal,
      ),
    );
  return { host, lines, received, send };
};

const OPEN = {
  action: "open",
  url: "https://research.example.com/",
} as const satisfies BrowserControlCommand;

describe("the stella browser host", () => {
  test("refuses a non-public address before any browser starts", async () => {
    const { lines, received, send } = start();
    for (const url of [
      "http://research.example.com/",
      "https://127.0.0.1/",
      "https://intranet/",
      "https://api.example-stella.com/",
      "https://app.stll.app/",
    ]) {
      expect(await send({ action: "open", url })).toMatchObject({
        code: BROWSER_CONTROL_ERROR_CODE.navigationFailed,
      });
    }
    expect(received()).toEqual([]);
    expect(lines).toEqual([]);
  });

  test("starts on the first open and reads through the shared page script in an isolated world", async () => {
    const { received, send } = start();
    // The stand-in's every frame asks for a sign-in: the member's.
    expect(await send(OPEN)).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.needsMember,
    });
    const messages = received();
    for (const { method } of messages) {
      expect(ALLOWED).toContain(method);
    }
    const calls = messages.filter(
      ({ method }) => method === "Runtime.callFunctionOn",
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const { params } of calls) {
      // The one page script the extension injects, not a copy.
      expect(params?.["functionDeclaration"]).toBe(pageScript.toString());
      // Only in the world the holder created for the document.
      expect(params?.["executionContextId"]).toBe(1);
    }
    expect(messages.map(({ method }) => method)).not.toContain(
      "Runtime.enable",
    );
    // Its pages download nothing until downloads reach the run's folder.
    expect(messages).toContainEqual({
      method: "Browser.setDownloadBehavior",
      params: { behavior: "deny" },
    });
  });

  test("refuses steps that change a page as not available here, sending nothing", async () => {
    const { received, send } = start();
    expect(await send(OPEN)).toMatchObject({ status: "error" });
    const before = received().length;
    expect(await send({ action: "go-back" })).toEqual({
      code: BROWSER_CONTROL_ERROR_CODE.executionFailed,
      message: NOT_AVAILABLE_ON_STELLA_BROWSER,
      protocolVersion: expect.any(Number),
      status: "error",
    });
    expect(received()).toHaveLength(before);
  });

  test("starts again on the next open after the browser crashed", async () => {
    const { lines, received, send } = start();
    expect(
      await send({ action: "open", url: "https://crash.example.com/" }),
    ).toMatchObject({ status: "error" });
    await waitFor(
      () =>
        lines.some((line) => line.startsWith("the stella browser closed"))
          ? true
          : undefined,
      { timeoutMs: 10_000, description: "the crash to be noticed" },
    );
    // The chat's tab went with the browser.
    expect(await send({ action: "snapshot" })).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.noControlledTab,
    });
    expect(await send(OPEN)).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.needsMember,
    });
    expect(
      received().filter(({ method }) => method === "Browser.getVersion"),
    ).toHaveLength(2);
  });

  test("closes once no chat has a tab, and opens again for the next chat", async () => {
    const { host, lines, received, send } = start();
    await send(OPEN, "chat-1");
    await send(OPEN, "chat-2");
    host.releaseChat("chat-1");
    await waitFor(
      () =>
        received().filter(({ method }) => method === "Target.closeTarget")
          .length === 1
          ? true
          : undefined,
      { timeoutMs: 10_000, description: "chat 1's window to close" },
    );
    expect(received().map(({ method }) => method)).not.toContain(
      "Browser.close",
    );
    host.releaseChat("chat-2");
    await waitFor(
      () =>
        lines.some((line) => line.startsWith("the stella browser closed"))
          ? true
          : undefined,
      { timeoutMs: 10_000, description: "the browser to close" },
    );
    expect(received().map(({ method }) => method)).toContain("Browser.close");
    expect(await send(OPEN, "chat-3")).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.needsMember,
    });
  });
});
