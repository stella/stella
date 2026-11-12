import { panic, Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
  type BrowserControlResult,
} from "@stll/api-contract/browser-control";
import { waitFor } from "@stll/test-kit";

import { type BrowserBridge, startBrowserBridge } from "./bridge";
import { readLocalBrowserResult } from "./local-result";
import {
  encodeNativeMessage,
  nativeMessageReader,
  runNativeHost,
} from "./native-host";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

const NEEDS_MEMBER = {
  code: BROWSER_CONTROL_ERROR_CODE.needsMember,
  message: "This page asks for a sign-in.",
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  status: "error",
} as const satisfies BrowserControlResult;

const startBridge = async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "stella-bridge-"));
  cleanups.push(() => {
    rmSync(dir, { force: true, recursive: true });
  });
  const lines: string[] = [];
  const started = await startBrowserBridge({
    dir,
    endpoint: path.join(dir, "sb.sock"),
    log: (line) => {
      lines.push(line);
    },
    timeoutMs: 5000,
  });
  const bridge = Result.isOk(started)
    ? started.value
    : panic(`the bridge did not start: ${started.error.message}`);
  cleanups.push(async () => {
    await bridge.stop();
  });
  return { bridge, dir, lines };
};

/**
 * Chrome and the extension for one host: frames in on the host's standard
 * input, frames out of its standard output, answered as the extension
 * answers.
 */
const startChrome = (
  bridge: BrowserBridge,
  {
    answer,
    secret = readFileSync(bridge.secretFile, "utf-8"),
  }: {
    answer: (request: Record<string, unknown>) => unknown;
    secret?: string;
  },
) => {
  const input = new PassThrough();
  const received: Record<string, unknown>[] = [];
  const toHost = (message: unknown) => {
    const frame = encodeNativeMessage(JSON.stringify(message));
    if (frame !== null) {
      input.write(frame);
    }
  };
  const read = nativeMessageReader((json) => {
    const message: unknown = JSON.parse(json);
    if (typeof message !== "object" || message === null) {
      return;
    }
    const request = Object.fromEntries(Object.entries(message));
    received.push(request);
    const reply = answer(request);
    if (reply !== undefined) {
      toHost(reply);
    }
  });
  const exited = runNativeHost({
    endpoint: bridge.endpoint,
    input,
    output: (frame) => {
      read(frame);
    },
    retryMs: 20,
    secret,
  });
  cleanups.push(async () => {
    input.end();
    await exited;
  });
  return { exited, input, received };
};

const extension = (request: Record<string, unknown>) => {
  switch (request["type"]) {
    case "hello":
      return {
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
        type: "hello",
      };
    case "command":
      return {
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        requestId: request["requestId"],
        result: NEEDS_MEMBER,
        source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
        type: "command-result",
      };
    default:
      return undefined;
  }
};

const ready = async (bridge: BrowserBridge) =>
  await waitFor(() => (bridge.status().type === "ready" ? true : undefined), {
    description: "the extension to say which protocol it speaks",
  });

const snapshotRequest = {
  command: { action: "snapshot" },
  controllerId: "thread-1",
  observedTab: null,
  toolCallId: "call-1",
  turnId: "run-1",
} as const;

describe("the browser bridge and its native host", () => {
  test("relay a command to the extension and its result back", async () => {
    const { bridge } = await startBridge();
    expect(statSync(bridge.secretFile).mode % 0o1000).toBe(0o600);
    const chrome = startChrome(bridge, { answer: extension });
    await ready(bridge);

    const result = await bridge.request(
      snapshotRequest,
      new AbortController().signal,
    );
    expect(readLocalBrowserResult(result)).toEqual(NEEDS_MEMBER);
    // Serialised, as anything bound for stella's servers is, it is empty.
    expect(JSON.stringify(result)).toBe("{}");
    expect(chrome.received.map(({ type }) => type)).toEqual([
      "hello",
      "command",
    ]);
    expect(chrome.received.at(1)).toMatchObject({
      command: { action: "snapshot" },
      controllerId: "thread-1",
      source: BROWSER_EXTENSION_MESSAGE_SOURCE.desktop,
      turnId: "run-1",
    });
  });

  test("answer disconnected while no extension is connected", async () => {
    const { bridge } = await startBridge();
    expect(
      readLocalBrowserResult(
        await bridge.request(snapshotRequest, new AbortController().signal),
      ),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.disconnected });
  });

  test("refuse a host without the secret, and a second host", async () => {
    const { bridge, lines } = await startBridge();
    const forged = startChrome(bridge, {
      answer: extension,
      secret: "0".repeat(64),
    });
    await forged.exited;
    expect(lines).toContain(
      "refused a browser host that did not present the secret",
    );

    startChrome(bridge, { answer: extension });
    await ready(bridge);
    const second = startChrome(bridge, { answer: extension });
    await second.exited;
    expect(lines).toContain("refused a second browser host");
    expect(bridge.status().type).toBe("ready");
  });

  test("name an extension on another protocol instead of sending to it", async () => {
    const { bridge } = await startBridge();
    const chrome = startChrome(bridge, {
      answer: (request) =>
        request["type"] === "hello"
          ? {
              protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION + 1,
              source: BROWSER_EXTENSION_MESSAGE_SOURCE.extension,
              type: "hello",
            }
          : undefined,
    });
    await ready(bridge);
    const result = readLocalBrowserResult(
      await bridge.request(snapshotRequest, new AbortController().signal),
    );
    expect(result).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.disconnected,
    });
    expect(JSON.stringify(result)).toContain("protocol");
    expect(chrome.received.map(({ type }) => type)).toEqual(["hello"]);
  });

  test("a stopped run cancels its command in the extension", async () => {
    const { bridge } = await startBridge();
    const chrome = startChrome(bridge, {
      // The command is never answered: only the stop ends it.
      answer: (request) =>
        request["type"] === "hello" ? extension(request) : undefined,
    });
    await ready(bridge);
    const stop = new AbortController();
    const pending = bridge.request(snapshotRequest, stop.signal);
    await waitFor(
      () =>
        chrome.received.some(({ type }) => type === "command")
          ? true
          : undefined,
      { description: "the command to reach the extension" },
    );
    stop.abort();
    expect(readLocalBrowserResult(await pending)).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.cancelled,
    });
    await waitFor(
      () =>
        chrome.received.some(({ type }) => type === "cancel")
          ? true
          : undefined,
      { description: "the cancel to reach the extension" },
    );
    expect(chrome.received.at(-1)).toMatchObject({
      controllerId: "thread-1",
      turnId: "run-1",
      type: "cancel",
    });
  });
});

describe("Chrome's native message framing", () => {
  test("round-trips messages split across reads", () => {
    const messages: string[] = [];
    const read = nativeMessageReader((json) => {
      messages.push(json);
    });
    const first = encodeNativeMessage(JSON.stringify({ a: "č" }));
    const second = encodeNativeMessage(JSON.stringify({ b: 2 }));
    if (first === null || second === null) {
      throw new TypeError("A small message did not encode.");
    }
    const joined = new Uint8Array([...first, ...second]);
    expect(read(joined.subarray(0, 3))).toBe(true);
    expect(read(joined.subarray(3, 9))).toBe(true);
    expect(read(joined.subarray(9))).toBe(true);
    expect(messages).toEqual(['{"a":"č"}', '{"b":2}']);
  });

  test("refuses what Chrome would refuse", () => {
    expect(encodeNativeMessage(`"${"x".repeat(1024 * 1024)}"`)).toBeNull();
    const oversized = new Uint8Array(4);
    new DataView(oversized.buffer).setUint32(0, 64 * 1024 * 1024 + 1, true);
    expect(nativeMessageReader(() => undefined)(oversized)).toBe(false);
  });
});
