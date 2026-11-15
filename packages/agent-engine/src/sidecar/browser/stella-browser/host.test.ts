import { Result } from "better-result";
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
  BROWSER_CONTROL_LIMITS,
  type BrowserControlCommand,
} from "@stll/api-contract/browser-control";
import { pageScript } from "@stll/browser-page/page-script";
import { waitFor } from "@stll/test-kit";

import { readLocalBrowserResult } from "../local-result";
import { CDP_METHOD_ALLOWLIST } from "./cdp-client";
import {
  chatQueues,
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
  sessionId: v.optional(v.string()),
});

const alive = (pid: number) =>
  Result.isOk(Result.try(() => process.kill(pid, 0)));

/** The pid each start of the browser logged. */
const startedPids = (lines: readonly string[]) =>
  lines.flatMap((line) => {
    const pid = /\(pid (\d+)\)$/u.exec(line)?.[1];
    return pid === undefined ? [] : [Number(pid)];
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
  const account = { origin: "https://api.example-stella.com" };
  const host = createStellaBrowserHost({
    accountOrigin: () => account.origin,
    environment: { PATH: process.env["PATH"] },
    home: null,
    log: (line) => {
      lines.push(line);
    },
    platform: process.platform,
    profileRoot: path.join(root, "browser-profiles"),
    testHooks: { args: [], browserLog: null, executable, methodLog: null },
  });
  cleanups.push(host.stop);
  /** Every message the stand-in browsers received, by account profile. */
  const receivedBy = () => {
    const profiles = path.join(root, "browser-profiles");
    return (existsSync(profiles) ? readdirSync(profiles) : []).map((member) => {
      const log = path.join(profiles, member, "profile", "fake-cdp.log");
      return existsSync(log)
        ? readFileSync(log, "utf-8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => v.parse(receivedSchema, JSON.parse(line)))
        : [];
    });
  };
  /** Every message the stand-in browsers received, in order per profile. */
  const received = () => receivedBy().flat();
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
  const methods = () => received().map(({ method }) => method);
  return { account, host, lines, methods, received, receivedBy, send };
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

  test("never uses one account's browser for another: it closes and the other's starts", async () => {
    const { account, receivedBy, send } = start();
    expect(await send(OPEN)).toMatchObject({ status: "error" });
    account.origin = "https://api.other-stella.com";
    expect(await send(OPEN, "chat-2")).toMatchObject({ status: "error" });
    const [first, second] = receivedBy();
    expect(receivedBy()).toHaveLength(2);
    for (const profile of [first ?? [], second ?? []]) {
      expect(profile.map(({ method }) => method)).toContain(
        "Browser.getVersion",
      );
    }
    // One of the two profiles' browsers was closed for the other.
    expect(
      [first ?? [], second ?? []].filter((profile) =>
        profile.some(({ method }) => method === "Browser.close"),
      ),
    ).toHaveLength(1);
  });

  test("reads an opened page only on the origin it was opened on, wherever it moved meanwhile", async () => {
    const { received, send } = start();
    expect(
      await send({
        action: "open",
        url: "https://research.example.com/moves-away",
      }),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.redirected });
    // Every read of the page named the origin it must still be on.
    const reads = received().filter(
      ({ method, params }) =>
        method === "Runtime.callFunctionOn" &&
        JSON.stringify(params).includes('"purpose":"read"'),
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const { params } of reads) {
      expect(JSON.stringify(params)).toContain(
        '"expectedTopOrigin":"https://research.example.com"',
      );
    }
  });

  test("lets frames inside a frame in another process attach too", async () => {
    const { received, send } = start();
    await send({ action: "open", url: "https://research.example.com/framed" });
    await waitFor(
      () =>
        received().some(
          ({ method, sessionId }) =>
            method === "Target.setAutoAttach" && sessionId === "FRAME-SESSION",
        )
          ? true
          : undefined,
      { description: "the frame's own auto-attach", timeoutMs: 10_000 },
    );
  });

  test("keeps a chat to the tab limit, refused before a window is made", async () => {
    const { methods, send } = start();
    for (let opened = 0; opened < BROWSER_CONTROL_LIMITS.tabs; opened += 1) {
      await send({ ...OPEN, newTab: true });
    }
    expect(await send({ ...OPEN, newTab: true })).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.tabLimitReached,
    });
    expect(
      methods().filter((method) => method === "Target.createTarget"),
    ).toHaveLength(BROWSER_CONTROL_LIMITS.tabs);
  });

  test("a chat released while its open waits for the browser leaves no window, and the idle browser closes", async () => {
    const { host, lines, methods, send } = start();
    const opening = send(OPEN);
    host.releaseChat("chat-1");
    expect(await opening).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.cancelled,
    });
    const created = methods().filter(
      (method) => method === "Target.createTarget",
    ).length;
    expect(
      methods().filter((method) => method === "Target.closeTarget").length,
    ).toBe(created);
    await waitFor(
      () =>
        lines.every((line) => !line.startsWith("the stella browser started")) ||
        lines.some((line) => line.startsWith("the stella browser closed"))
          ? true
          : undefined,
      { description: "no browser left running", timeoutMs: 10_000 },
    );
  });

  test("stopping while the browser starts closes it, and starts none again", async () => {
    const { host, methods, send } = start();
    const opening = send(OPEN);
    // The browser has been asked for its version: it is starting.
    await waitFor(
      () => (methods().includes("Browser.getVersion") ? true : undefined),
      { description: "the browser to start", timeoutMs: 10_000 },
    );
    await host.stop();
    expect(await opening).toMatchObject({ status: "error" });
    expect(await send(OPEN)).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.disconnected,
    });
    expect(
      methods().filter((method) => method === "Browser.getVersion"),
    ).toHaveLength(1);
    expect(methods()).toContain("Browser.close");
  });

  test("a browser whose pipe ends but that ignores SIGTERM is killed", async () => {
    const { lines, send } = start();
    expect(
      await send({ action: "open", url: "https://research.example.com/hang" }),
    ).toMatchObject({ status: "error" });
    const [pid] = startedPids(lines);
    expect(pid).toBeDefined();
    await waitFor(() => (pid !== undefined && !alive(pid) ? true : undefined), {
      description: "the hung browser to be killed",
      timeoutMs: 15_000,
    });
  });
});

describe("a chat's command queue", () => {
  test("runs the next command after one that failed, and a cancel stops the queued ones too", async () => {
    const queues = chatQueues();
    const signal = new AbortController().signal;
    const failing = queues.run("chat-1", signal, async () => {
      await Promise.resolve();
      throw new TypeError("the command failed");
    });
    const held = Promise.withResolvers<null>();
    const running = queues.run("chat-1", signal, async (stop) => {
      await held.promise;
      return stop.aborted;
    });
    const queued = queues.run(
      "chat-1",
      signal,
      async (stop) => await Promise.resolve(stop.aborted),
    );
    queues.cancel("chat-1");
    held.resolve(null);
    expect(
      Result.isError(await Result.tryPromise(async () => await failing)),
    ).toBe(true);
    expect(await running).toBe(true);
    expect(await queued).toBe(true);
    // A later command of the chat starts fresh.
    expect(
      await queues.run(
        "chat-1",
        signal,
        async (stop) => await Promise.resolve(stop.aborted),
      ),
    ).toBe(false);
  });
});
