import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import {
  BROWSER_CONTROL_CONTENT_TRUST,
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_LIMITS,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_DOWNLOAD_STAGING_FOLDER,
  BROWSER_EXTENSION_ID,
  STELLA_DESKTOP_NATIVE_HOST,
} from "@stll/api-contract/browser-control";
import { sha256Hex } from "@stll/sha256/node";

import type { BrowserBridge, BrowserBridgeDownload } from "./bridge";
import { createHostRouter, extensionHost } from "./host-router";
import { type LocalBrowserResult, localBrowserResult } from "./local-result";
import { startLocalBrowserMcp } from "./mcp-server";
import { installNativeHost } from "./native-host-manifest";
import { APPROVAL_DECISION } from "./tools";

const approve = async () => ({
  decision: APPROVAL_DECISION.approve,
  finish: () => undefined,
});

const NEVER_STOPPED = new AbortController().signal;
/** A run folder no test here downloads into. */
const UNUSED_FOLDER = "/unused-run-folder";

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
  const cancels: { controllerId: string; turnId: string }[] = [];
  const downloadListener: {
    current: (report: BrowserBridgeDownload) => void;
  } = { current: () => undefined };
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
    cancel: (run) => {
      cancels.push(run);
    },
    onDownload: (listener) => {
      downloadListener.current = listener;
    },
    stop: async () => undefined,
  };
  /** The extension reporting a download, as the bridge hands it on. */
  const reportDownload = (report: BrowserBridgeDownload) => {
    downloadListener.current(report);
  };
  return { bridge, cancels, reportDownload, requests };
};

const start = (fake = fakeBridge(), home = "/unused-home") => {
  const mcp = startLocalBrowserMcp({
    browser: createHostRouter({
      extension: extensionHost(fake.bridge),
      stellaBrowser: null,
    }),
    downloads: { home, onDownload: fake.bridge.onDownload },
    version: "1.4.0",
  });
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
  test("serves the browser tools to the run it was registered for", async () => {
    const { mcp, requests } = start();
    const binding = mcp.register({
      accountOrigin: "https://api.example-stella.com",
      approvals: "auto",
      siteGrants: new Set<string>(),
      approve,
      stopped: NEVER_STOPPED,
      runId: "run-1",
      threadId: "thread-1",
      workspaceDir: UNUSED_FOLDER,
    });
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
      "find",
      "click",
      "type",
      "press_key",
      "select",
      "go_back",
      "switch_tab",
      "wait_for_downloads",
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
    const first = mcp.register({
      accountOrigin: "https://api.example-stella.com",
      approvals: "auto",
      siteGrants: new Set<string>(),
      approve,
      stopped: NEVER_STOPPED,
      runId: "run-1",
      threadId: "thread-1",
      workspaceDir: UNUSED_FOLDER,
    });
    const second = mcp.register({
      accountOrigin: "https://api.example-stella.com",
      approvals: "auto",
      siteGrants: new Set<string>(),
      approve,
      stopped: NEVER_STOPPED,
      runId: "run-2",
      threadId: "thread-2",
      workspaceDir: UNUSED_FOLDER,
    });
    const ping = { id: 1, jsonrpc: "2.0", method: "ping" };

    expect(
      (await rpc({ url: first.url, token: second.token }, ping)).status,
    ).toBe(401);
    expect(
      (await rpc(first, ping, { origin: "https://example.com" })).status,
    ).toBe(403);
    expect((await rpc(first, ping)).status).toBe(200);

    mcp.unregister("run-1");
    expect(cancels).toEqual([{ controllerId: "thread-1", turnId: "run-1" }]);
    expect((await rpc(first, ping)).status).toBe(404);
  });

  test("a kept process's endpoint is parked between turns and serves the run that adopts it", async () => {
    const { cancels, mcp, requests } = start();
    const run = {
      accountOrigin: "https://api.example-stella.com",
      approvals: "auto",
      siteGrants: new Set<string>(),
      approve,
      stopped: NEVER_STOPPED,
      threadId: "thread-1",
      workspaceDir: UNUSED_FOLDER,
    } as const;
    const first = mcp.register({ ...run, runId: "run-1" });
    const ping = { id: 1, jsonrpc: "2.0", method: "ping" };

    const parked = mcp.park("run-1");
    expect(parked).not.toBeNull();
    expect(cancels).toEqual([{ controllerId: "thread-1", turnId: "run-1" }]);
    // Parked, it serves no run; the process keeps its address and secret.
    expect((await rpc(first, ping)).status).toBe(404);
    mcp.unregister("run-1");

    const adopted = mcp.adopt(parked ?? "", { ...run, runId: "run-2" });
    expect(adopted).toEqual(first);
    // Only a parked endpoint is adopted.
    expect(mcp.adopt(parked ?? "", { ...run, runId: "run-3" })).toBeNull();
    const call = {
      id: 2,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "open", arguments: { url: "https://example.com/" } },
    };
    expect((await rpc(first, call)).status).toBe(200);
    expect(requests.at(-1)).toMatchObject({ turnId: "run-2" });

    // An adopted endpoint goes with its run, not with a drop.
    mcp.drop(parked ?? "");
    expect((await rpc(first, ping)).status).toBe(200);
    mcp.park("run-2");
    mcp.drop(parked ?? "");
    expect(mcp.adopt(parked ?? "", { ...run, runId: "run-4" })).toBeNull();
  });
});

/** A bridge whose command reports back only once its call is cut. */
const holdingBridge = () => {
  const fake = fakeBridge();
  const { promise: sent, resolve: markSent } = Promise.withResolvers<true>();
  const { promise: cut, resolve: markCut } = Promise.withResolvers<true>();
  return {
    ...fake,
    bridge: {
      ...fake.bridge,
      request: async (_request, signal) => {
        markSent(true);
        signal.addEventListener("abort", () => {
          markCut(true);
        });
        await cut;
        return localBrowserResult({
          code: BROWSER_CONTROL_ERROR_CODE.outcomeUnknown,
          message: "The run stopped before Chrome reported back.",
          protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
          status: "error",
        });
      },
    } satisfies BrowserBridge,
    cut,
    sent,
  };
};

describe("downloads of a chat's tab", () => {
  const SNAPSHOT = {
    id: 9,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: {}, name: "snapshot" },
  } as const;

  const toolText = async (response: Response): Promise<unknown> => {
    const { result } = v.parse(
      v.object({
        result: v.object({
          content: v.tuple([v.object({ text: v.string() })]),
        }),
      }),
      await response.json(),
    );
    return JSON.parse(result.content[0].text);
  };

  test("a PDF reported while the chat's run is held lands in that run's folder and in its next result", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "stella-browser-mcp-dl-"));
    cleanups.push(() => {
      rmSync(root, { force: true, recursive: true });
    });
    const workspaceDir = path.join(root, "chat");
    const staging = path.join(
      root,
      "Downloads",
      BROWSER_DOWNLOAD_STAGING_FOLDER,
    );
    mkdirSync(workspaceDir);
    mkdirSync(staging, { recursive: true });
    const staged = path.join(staging, `${crypto.randomUUID()}.pdf`);
    writeFileSync(staged, "%PDF-1.7\nfixture\n%%EOF\n");

    // The temporary root stands in for the member's home folder.
    const { mcp, reportDownload } = start(fakeBridge(), root);
    const binding = mcp.register({
      accountOrigin: "https://api.example-stella.com",
      approvals: "auto",
      siteGrants: new Set<string>(),
      approve,
      runId: "run-1",
      stopped: NEVER_STOPPED,
      threadId: "thread-1",
      workspaceDir,
    });
    reportDownload({
      controllerId: "thread-1",
      deliveryId: crypto.randomUUID(),
      shownDocument: null,
      type: "settled",
      download: {
        bytes: 23,
        mime: "application/pdf",
        outcome: "saved",
        path: staged,
        sourceUrl: "https://fixture-library.test/doc/1/file",
        suggestedName: "Decision 1.pdf",
      },
    });
    // Another chat's download never reaches this one.
    reportDownload({
      controllerId: "thread-2",
      deliveryId: crypto.randomUUID(),
      shownDocument: null,
      type: "settled",
      download: {
        outcome: "stopped",
        reason: "not-pdf",
        sourceUrl: "https://fixture-library.test/other",
        suggestedName: "other.bin",
      },
    });

    expect(await toolText(await rpc(binding, SNAPSHOT))).toMatchObject({
      downloads: [
        {
          bytes: 23,
          path: "Downloads/Decision 1.pdf",
          sourceUrl: "https://fixture-library.test/doc/1/file",
          status: "saved",
        },
      ],
    });
    const saved = path.join(workspaceDir, "Downloads", "Decision 1.pdf");
    expect(readFileSync(saved, "utf-8")).toBe("%PDF-1.7\nfixture\n%%EOF\n");
    expect(existsSync(staged)).toBe(false);
    // Reported once.
    expect(await toolText(await rpc(binding, SNAPSHOT))).not.toHaveProperty(
      "downloads",
    );
  });
});

describe("a browser call in flight", () => {
  const OPEN = {
    id: 7,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: "open", arguments: { url: "https://example.com/" } },
  };

  test.each([
    [
      "the harness cancels it",
      async ({ binding }: { binding: { url: string; token: string } }) => {
        const cancelled = await rpc(binding, {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: OPEN.id },
        });
        expect(cancelled.status).toBe(202);
      },
    ],
    [
      "the run is stopped",
      ({ stop }: { stop: AbortController }) => {
        stop.abort();
      },
    ],
    [
      "the run ends",
      ({ mcp }: { mcp: ReturnType<typeof start>["mcp"] }) => {
        mcp.unregister("run-1");
      },
    ],
  ] as const)("is cut when %s", async (_name, end) => {
    const holding = holdingBridge();
    const { mcp } = start(holding);
    const stop = new AbortController();
    const binding = mcp.register({
      accountOrigin: "https://api.example-stella.com",
      approvals: "auto",
      siteGrants: new Set<string>(),
      approve,
      runId: "run-1",
      stopped: stop.signal,
      threadId: "thread-1",
      workspaceDir: UNUSED_FOLDER,
    });
    const answered = rpc(binding, OPEN);
    await holding.sent;
    await end({ binding, mcp, stop });
    expect(await holding.cut).toBe(true);
    expect((await answered).status).toBe(200);
  });

  test("another call's cancellation leaves it running", async () => {
    const holding = holdingBridge();
    const { mcp } = start(holding);
    const stop = new AbortController();
    const binding = mcp.register({
      accountOrigin: "https://api.example-stella.com",
      approvals: "auto",
      siteGrants: new Set<string>(),
      approve,
      runId: "run-1",
      stopped: stop.signal,
      threadId: "thread-1",
      workspaceDir: UNUSED_FOLDER,
    });
    const answered = rpc(binding, OPEN);
    await holding.sent;
    await rpc(binding, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: OPEN.id + 1 },
    });
    const state = await Promise.race([
      holding.cut,
      // The cancellation was answered, so a cut would have happened by now.
      Promise.resolve("running" as const),
    ]);
    expect(state).toBe("running");
    stop.abort();
    expect((await answered).status).toBe(200);
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

  test("writes nothing without Chrome, or where no host location is known", () => {
    const { dir, root } = home();
    expect(installNativeHost(options(root, dir))).toEqual(
      Result.ok({ reason: "no_chrome", type: "skipped" }),
    );
    expect(
      installNativeHost({ ...options(root, dir), platform: "linux" }),
    ).toEqual(Result.ok({ reason: "no_chrome", type: "skipped" }));
    expect(
      installNativeHost({ ...options(root, dir), platform: "win32" }),
    ).toEqual(Result.ok({ reason: "unsupported_platform", type: "skipped" }));
    expect(existsSync(path.join(dir, "browser-host"))).toBe(false);
  });

  test("registers the host in Chrome's Linux profile folder", () => {
    const { dir, root } = home();
    mkdirSync(path.join(root, ".config", "google-chrome"), { recursive: true });
    const installed = installNativeHost({
      ...options(root, dir),
      platform: "linux",
    });
    expect(installed).toEqual(
      Result.ok({
        manifest: path.join(
          root,
          ".config",
          "google-chrome",
          "NativeMessagingHosts",
          `${STELLA_DESKTOP_NATIVE_HOST}.json`,
        ),
        type: "installed",
      }),
    );
  });
});

describe("a chat's downloads, end to end on this computer", () => {
  const SEARCH_PAGE = "https://fixture-library.test/search?q=notice";
  const FILE_URL = "https://fixture-library.test/doc/1/file";

  /** A page the extension read, at `url`. */
  const pageAt = (url: string) =>
    localBrowserResult({
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      snapshot: {
        contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
        elements: [],
        elementsLeftOut: false,
        facts: { meta: [] },
        revision: "r-1",
        tabId: 7,
        tabs: [],
        text: "Results",
        title: "Fixture library",
        url,
        window: { cursor: "r1.d2luZG93", fromPercent: 0, toPercent: 100 },
      },
      status: "success",
    });

  const SIGN_IN = localBrowserResult({
    code: BROWSER_CONTROL_ERROR_CODE.needsMember,
    message: "This page asks for a sign-in.",
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    status: "error",
  });

  /**
   * A member's computer: a home folder with Chrome's staging folder, a
   * chat's folder, and an extension whose answers and downloads the test
   * scripts (`during` runs while a command is in the browser).
   */
  const computer = () => {
    const home = mkdtempSync(path.join(tmpdir(), "stella-browser-dl-e2e-"));
    cleanups.push(() => {
      rmSync(home, { force: true, recursive: true });
    });
    const workspaceDir = path.join(home, "chat");
    const staging = path.join(
      home,
      "Downloads",
      BROWSER_DOWNLOAD_STAGING_FOLDER,
    );
    mkdirSync(workspaceDir);
    mkdirSync(staging, { recursive: true });
    const fake = fakeBridge();
    const answers: LocalBrowserResult[] = [];
    const script: { during: () => void } = { during: () => undefined };
    const bridge: BrowserBridge = {
      ...fake.bridge,
      request: async (request) => {
        fake.requests.push(request);
        script.during();
        script.during = () => undefined;
        return answers.shift() ?? SIGN_IN;
      },
    };
    const { mcp } = start({ ...fake, bridge }, home);
    const binding = mcp.register({
      accountOrigin: "https://api.example-stella.com",
      approvals: "auto",
      siteGrants: new Set<string>(),
      approve,
      runId: "run-1",
      stopped: NEVER_STOPPED,
      threadId: "thread-1",
      workspaceDir,
    });
    /** Chrome saving `content` into the staging folder: its path. */
    const stage = (content: string) => {
      const staged = path.join(staging, `${crypto.randomUUID()}.pdf`);
      writeFileSync(staged, content);
      return staged;
    };
    const started = (deliveryId: string) => {
      fake.reportDownload({
        controllerId: "thread-1",
        deliveryId,
        shownDocument: null,
        type: "started",
      });
    };
    const settledSaved = (deliveryId: string, staged: string) => {
      fake.reportDownload({
        controllerId: "thread-1",
        deliveryId,
        download: {
          bytes: statSync(staged).size,
          mime: "application/pdf",
          outcome: "saved",
          path: staged,
          sourceUrl: FILE_URL,
          suggestedName: "Decision 1.pdf",
        },
        shownDocument: null,
        type: "settled",
      });
    };
    const call = async (name: string, args: unknown) =>
      await toolResult(
        await rpc(binding, {
          id: crypto.randomUUID(),
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: args, name },
        }),
      );
    return {
      answers,
      call,
      script,
      settledSaved,
      stage,
      started,
      workspaceDir,
    };
  };

  const toolResult = async (response: Response) => {
    const { result } = v.parse(
      v.object({
        result: v.object({
          content: v.tuple([v.object({ text: v.string() })]),
          isError: v.boolean(),
        }),
      }),
      await response.json(),
    );
    return {
      isError: result.isError,
      value: JSON.parse(result.content[0].text) as unknown,
    };
  };

  const PDF = "%PDF-1.7\nfixture\n%%EOF\n";
  const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u;

  test("a download from a page that then asks for a sign-in rides along with that answer, with the page it came from", async () => {
    const pc = computer();
    pc.answers.push(pageAt(SEARCH_PAGE));
    await pc.call("open", { url: SEARCH_PAGE });

    // The next step starts a download, and the page it lands on needs the
    // member to sign in.
    const staged = pc.stage(PDF);
    pc.script.during = () => {
      const deliveryId = crypto.randomUUID();
      pc.started(deliveryId);
      pc.settledSaved(deliveryId, staged);
    };
    const gated = await pc.call("open", {
      url: "https://fixture-library.test/doc/1",
    });

    expect(gated.isError).toBe(true);
    expect(gated.value).toMatchObject({
      downloads: [
        {
          duplicate: false,
          pageUrl: SEARCH_PAGE,
          path: "Downloads/Decision 1.pdf",
          sha256: sha256Hex(PDF),
          sourceUrl: FILE_URL,
          status: "saved",
        },
      ],
      status: "needs_member",
    });
    expect(gated.value).toHaveProperty(
      "downloads.0.downloadedAt",
      expect.stringMatching(ISO_INSTANT),
    );
    expect(
      readFileSync(path.join(pc.workspaceDir, "Downloads", "Decision 1.pdf"), {
        encoding: "utf-8",
      }),
    ).toBe(PDF);
  });

  // timeout: the step's own result waits DOWNLOAD_SETTLE_WAIT_MS (3 s) on
  // the system clock before it counts the download as still saving.
  test(
    "a download that finishes after its step returned is handed over by wait_for_downloads",
    async () => {
      const pc = computer();
      pc.answers.push(pageAt(SEARCH_PAGE), pageAt(SEARCH_PAGE));
      await pc.call("open", { url: SEARCH_PAGE });
      const deliveryId = crypto.randomUUID();
      pc.script.during = () => {
        pc.started(deliveryId);
      };

      // The step waits its moment, then returns with the download counted.
      const step = await pc.call("snapshot", {});
      expect(step.value).toMatchObject({ savingDownloads: 1 });
      expect(step.value).not.toHaveProperty("downloads");

      const waiting = pc.call("wait_for_downloads", { seconds: 20 });
      // Chrome finishes it once the step has returned.
      pc.settledSaved(deliveryId, pc.stage(PDF));

      expect((await waiting).value).toMatchObject({
        downloads: [{ pageUrl: SEARCH_PAGE, path: "Downloads/Decision 1.pdf" }],
        status: "settled",
      });
    },
    { timeout: 15_000 },
  );

  test("the same file downloaded twice is kept once, and the second names the first", async () => {
    const pc = computer();
    pc.settledSaved(crypto.randomUUID(), pc.stage(PDF));
    pc.settledSaved(crypto.randomUUID(), pc.stage(PDF));

    const waited = await pc.call("wait_for_downloads", {});

    expect(waited.value).toMatchObject({
      downloads: [
        { duplicate: false, path: "Downloads/Decision 1.pdf" },
        { duplicate: true, path: "Downloads/Decision 1.pdf" },
      ],
    });
    expect(readdirSync(path.join(pc.workspaceDir, "Downloads"))).toEqual([
      "Decision 1.pdf",
    ]);
  });

  test("a file over the size limit is refused with a reason the agent can relay, and nothing is kept", async () => {
    const pc = computer();
    const staged = pc.stage(PDF);
    // Sparse: no disk is used for the size.
    truncateSync(staged, BROWSER_CONTROL_LIMITS.downloadBytes + 1);
    pc.settledSaved(crypto.randomUUID(), staged);

    const waited = await pc.call("wait_for_downloads", {});

    expect(waited.value).toMatchObject({
      downloads: [
        {
          message: expect.stringContaining("larger than 100 MiB"),
          reason: "too_large",
          sourceUrl: FILE_URL,
          status: "refused",
        },
      ],
    });
    expect(existsSync(staged)).toBe(false);
    expect(existsSync(path.join(pc.workspaceDir, "Downloads"))).toBe(false);
  });
});
