import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import {
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_ID,
  STELLA_DESKTOP_NATIVE_HOST,
} from "@stll/api-contract/browser-control";

import type { BrowserBridge } from "./bridge";
import { localBrowserResult } from "./local-result";
import { startLocalBrowserMcp } from "./mcp-server";
import { installNativeHost } from "./native-host-manifest";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

type Requested = Parameters<BrowserBridge["request"]>[0];

/** A bridge whose extension answers every command with a sign-in. */
const fakeBridge = () => {
  const requests: Requested[] = [];
  const cancels: [string, string][] = [];
  const bridge: BrowserBridge = {
    endpoint: "/unused.sock",
    secretFile: "/unused.secret",
    status: () => ({
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      type: "ready",
    }),
    request: async (request) => {
      requests.push(request);
      return localBrowserResult({
        code: BROWSER_CONTROL_ERROR_CODE.needsMember,
        message: "This page asks for a sign-in.",
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        status: "error",
      });
    },
    cancel: (controllerId, turnId) => {
      cancels.push([controllerId, turnId]);
    },
    stop: async () => undefined,
  };
  return { bridge, cancels, requests };
};

const start = () => {
  const fake = fakeBridge();
  const mcp = startLocalBrowserMcp({ bridge: fake.bridge, version: "1.4.0" });
  cleanups.push(async () => {
    await mcp.stop();
  });
  return { ...fake, mcp };
};

const rpc = async (
  binding: { url: string; token: string },
  body: unknown,
  headers: Record<string, string> = {},
) =>
  await fetch(binding.url, {
    body: JSON.stringify(body),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${binding.token}`,
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  });

describe("the local browser MCP endpoint", () => {
  test("serves the four tools to the run it was registered for", async () => {
    const { mcp, requests } = start();
    const binding = mcp.register({ runId: "run-1", threadId: "thread-1" });
    expect(binding.serverName).toBe("stella_browser");
    expect(binding.url.startsWith(`${mcp.origin}/browser/`)).toBe(true);

    const initialized = await rpc(binding, {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {} },
    });
    expect(await initialized.json()).toMatchObject({
      id: 1,
      result: {
        capabilities: { tools: {} },
        protocolVersion: "2025-03-26",
      },
    });
    const notified = await rpc(binding, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(notified.status).toBe(202);

    const listed = await rpc(binding, {
      id: 2,
      jsonrpc: "2.0",
      method: "tools/list",
    });
    const { result } = v.parse(
      v.object({
        result: v.object({ tools: v.array(v.object({ name: v.string() })) }),
      }),
      await listed.json(),
    );
    expect(result.tools.map(({ name }) => name)).toEqual([
      "open",
      "snapshot",
      "click",
      "type",
    ]);

    const called = await rpc(binding, {
      id: 3,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: { url: "https://fixture-library.test/account" },
        name: "open",
      },
    });
    expect(await called.json()).toMatchObject({
      id: 3,
      result: { isError: true },
    });
    expect(requests).toMatchObject([
      {
        command: {
          action: "open",
          url: "https://fixture-library.test/account",
        },
        controllerId: "thread-1",
        turnId: "run-1",
      },
    ]);
  });

  test("refuses another run's secret, a browser page and an ended run", async () => {
    const { cancels, mcp } = start();
    const first = mcp.register({ runId: "run-1", threadId: "thread-1" });
    const second = mcp.register({ runId: "run-2", threadId: "thread-2" });
    const ping = { id: 1, jsonrpc: "2.0", method: "ping" };

    expect(
      (await rpc({ url: first.url, token: second.token }, ping)).status,
    ).toBe(401);
    expect(
      (await rpc(first, ping, { origin: "https://example.com" })).status,
    ).toBe(403);
    expect((await rpc(first, ping)).status).toBe(200);

    mcp.unregister("run-1");
    expect(cancels).toEqual([["thread-1", "run-1"]]);
    expect((await rpc(first, ping)).status).toBe(404);
  });
});

describe("registering the host with Chrome", () => {
  const home = () => {
    const root = mkdtempSync(path.join(tmpdir(), "stella-home-"));
    cleanups.push(() => {
      rmSync(root, { force: true, recursive: true });
    });
    const dir = path.join(root, "holder");
    mkdirSync(dir, { mode: 0o700 });
    return { dir, root };
  };
  const options = (root: string, dir: string) => ({
    command: ["/Applications/stella.app/sidecar's binary"],
    dir,
    endpoint: "/tmp/sb.sock",
    extensionIds: [BROWSER_EXTENSION_ID],
    home: root,
    platform: "darwin" as const,
    secretFile: path.join(dir, "browser.secret"),
  });

  test("writes the manifest and a script that starts this sidecar as the host", () => {
    const { dir, root } = home();
    mkdirSync(
      path.join(root, "Library", "Application Support", "Google", "Chrome"),
      {
        recursive: true,
      },
    );
    const installed = installNativeHost(options(root, dir));
    const outcome = Result.isOk(installed) ? installed.value : null;
    if (outcome?.type !== "installed") {
      throw new TypeError("The host was not registered.");
    }
    const manifest: unknown = JSON.parse(
      readFileSync(outcome.manifest, "utf-8"),
    );
    expect(path.basename(outcome.manifest)).toBe(
      `${STELLA_DESKTOP_NATIVE_HOST}.json`,
    );
    expect(manifest).toEqual({
      allowed_origins: [`chrome-extension://${BROWSER_EXTENSION_ID}/`],
      description: "stella desktop",
      name: STELLA_DESKTOP_NATIVE_HOST,
      path: path.join(dir, "browser-host"),
      type: "stdio",
    });
    const script = readFileSync(path.join(dir, "browser-host"), "utf-8");
    expect(script).toBe(
      `#!/bin/sh\nexec '/Applications/stella.app/sidecar'\\''s binary' '--native-host' '--browser-endpoint' '/tmp/sb.sock' '--browser-secret-file' '${path.join(dir, "browser.secret")}' "$@"\n`,
    );
    expect(statSync(path.join(dir, "browser-host")).mode % 0o1000).toBe(0o700);
  });

  test("writes nothing without Chrome, or off macOS", () => {
    const { dir, root } = home();
    expect(installNativeHost(options(root, dir))).toEqual(
      Result.ok({ reason: "no_chrome", type: "skipped" }),
    );
    expect(
      installNativeHost({ ...options(root, dir), platform: "linux" }),
    ).toEqual(Result.ok({ reason: "unsupported_platform", type: "skipped" }));
  });
});
