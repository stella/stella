import { EventType } from "@tanstack/ai";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { CHAT_LOCAL_RUN_TOOL_NAMES } from "@stll/api-contract/chat-local-run-tool";
import { waitFor } from "@stll/test-kit";

import {
  FIXTURE_CANARIES,
  FIXTURE_CITATION,
  startFakeExtension,
  startFixtureLibrary,
} from "../../../scripts/fake-browser";
import {
  SIDECAR_PROTOCOL,
  type SidecarMessage,
  sidecarMessageSchema,
} from "../protocol";
import { browserEndpointFor } from "./holder-browser";

/**
 * Proof that page content stays on the computer. The holder runs as the
 * desktop starts it, Chrome is a stand-in behind the real native host, and
 * a fake harness (Codex, then Claude Code) searches a fixture library,
 * opens a result, tries a sign-in page and cites the decision. The library
 * serves canary strings the agent reads but never repeats. Everything that
 * leaves the computer goes to the desktop (run events) or to the stand-in
 * for stella's API (the MCP proxy): neither may carry a canary byte.
 */

const MAIN = path.join(import.meta.dir, "../main.ts");
const FAKES = {
  codex: path.join(
    import.meta.dir,
    "../../../scripts/fake-codex-app-server.ts",
  ),
  "claude-code": path.join(
    import.meta.dir,
    "../../../scripts/fake-claude-code-cli.ts",
  ),
} as const;
const MODELS = { codex: "gpt-test", "claude-code": "sonnet" } as const;
const PLAIN_LAUNCH = {
  configOverrides: [],
  environment: {},
  removedEnvironment: [],
  clientName: null,
  processGrant: false,
};
const WAIT = { timeoutMs: 20_000 } as const;

// timeout: each test starts the holder, the native host and a fake harness.
setDefaultTimeout(60_000);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

/** The stand-in for stella's API: records every request it receives. */
const startApi = () => {
  const received: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body = await request.text();
      received.push(
        [
          request.method,
          request.url,
          JSON.stringify([...request.headers.entries()]),
          body,
        ].join("\n"),
      );
      const message: unknown = body === "" ? null : JSON.parse(body);
      const id =
        typeof message === "object" && message !== null
          ? Reflect.get(message, "id")
          : undefined;
      if (id === undefined) {
        return new Response(null, { status: 202 });
      }
      const method = Reflect.get(message ?? {}, "method");
      return Response.json({
        id,
        jsonrpc: "2.0",
        result:
          method === "initialize"
            ? {
                capabilities: { tools: {} },
                protocolVersion: "2025-06-18",
                serverInfo: { name: "stella", version: "0" },
              }
            : {
                content: [
                  { type: "text", text: JSON.stringify({ results: [] }) },
                ],
              },
      });
    },
  });
  cleanups.push(async () => {
    await server.stop(true);
  });
  return { origin: `http://127.0.0.1:${String(server.port)}`, received };
};

type Desktop = { lines: string[]; messages: SidecarMessage[] };

/** Connect to the holder and authenticate as the desktop. */
const connectDesktop = async (
  endpoint: string,
  secret: string,
  apiOrigin: string,
): Promise<Desktop & { send: (message: object) => void }> => {
  const socket = net.createConnection({ path: endpoint });
  cleanups.push(() => {
    socket.destroy();
  });
  const desktop: Desktop = { lines: [], messages: [] };
  const decoder = new TextDecoder();
  let buffer = "";
  socket.on("data", (bytes: Uint8Array) => {
    buffer += decoder.decode(bytes, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      desktop.lines.push(line);
      const message = v.parse(sidecarMessageSchema, JSON.parse(line));
      desktop.messages.push(message);
      // The member allows typing outside a search field.
      if (message.type === "run.approval_request") {
        send({
          type: "run.approval",
          runId: message.runId,
          requestId: message.requestId,
          decision: "approve",
        });
      }
    }
  });
  const send = (message: object) => {
    socket.write(`${JSON.stringify(message)}\n`);
  };
  send({
    type: "hello",
    protocol: SIDECAR_PROTOCOL,
    secret,
    appVersion: "1.4.0",
    apiOrigin,
    resume: [],
  });
  await waitFor(
    () =>
      desktop.messages.some(({ type }) => type === "hello") ? true : undefined,
    { ...WAIT, description: "the holder's hello" },
  );
  return { ...desktop, send };
};

const browse = async (harness: keyof typeof FAKES) => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-canary-"));
  cleanups.push(() => {
    rmSync(root, { force: true, recursive: true });
  });
  const dir = path.join(root, "1.4.0");
  const endpoint = path.join(root, "stella-holder-1.4.0.sock");
  const api = startApi();
  const library = startFixtureLibrary();
  // A home folder with a Chrome profile, where the holder registers the
  // native host: without one it offers no browser tools.
  const home = path.join(root, "home");
  const profile = path.join(
    home,
    ...(process.platform === "darwin"
      ? ["Library", "Application Support", "Google", "Chrome"]
      : [".config", "google-chrome"]),
  );
  mkdirSync(profile, { recursive: true });
  cleanups.push(library.stop);

  const holder = Bun.spawn(
    [process.execPath, MAIN, "--dir", dir, "--endpoint", endpoint],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: {
        PATH: process.env["PATH"] ?? "",
        FAKE_HARNESS_LOG: path.join(root, "fake.log"),
        FAKE_BROWSER_START: `${library.origin}/`,
        HOME: home,
      },
    },
  );
  cleanups.push(async () => {
    holder.kill();
    await holder.exited;
  });
  const secretFile = path.join(dir, "holder.secret");
  await waitFor(() => (existsSync(secretFile) ? true : undefined), {
    ...WAIT,
    description: "the holder to start",
  });

  // Chrome starts the host the holder registers once its browser is up.
  const manifest = path.join(
    profile,
    "NativeMessagingHosts",
    "app.stll.browser.json",
  );
  await waitFor(() => (existsSync(manifest) ? true : undefined), {
    ...WAIT,
    description: "the holder to register the browser host",
  });
  const chrome = startFakeExtension({
    hostCommand: [
      process.execPath,
      MAIN,
      "--native-host",
      "--browser-endpoint",
      browserEndpointFor(endpoint),
      "--browser-secret-file",
      path.join(dir, "browser.secret"),
      "chrome-extension://fixture/",
    ],
  });
  cleanups.push(chrome.stop);
  await chrome.connected;

  const desktop = await connectDesktop(
    endpoint,
    readFileSync(secretFile, "utf-8"),
    api.origin,
  );
  const executable = path.join(root, `${harness}-browse`);
  writeFileSync(
    executable,
    `#!/bin/sh\nexec "${process.execPath}" "${FAKES[harness]}" browse "$@"\n`,
  );
  chmodSync(executable, 0o755);
  const configDir = path.join(root, `${harness}-home`);
  const workspaceDir = path.join(root, "workspace");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  const runId = crypto.randomUUID();
  desktop.send({
    type: "run.start",
    runId,
    threadId: "thread-1",
    attachments: [],
    skillFolders: [],
    toolPath: [],
    harness,
    executable,
    model: MODELS[harness],
    reasoningEffort: null,
    configDir,
    launch: PLAIN_LAUNCH,
    workspaceDir,
    cacheDir: path.join(root, "agent-package-cache"),
    instructions: "Use the stella MCP server.",
    messages: [{ role: "user", content: "Find the notice period decision." }],
    harnessSessionId: null,
    policy: { network: "open", fs: "workspace", approvals: "ask" },
    mcp: {
      serverName: "stella",
      url: `${api.origin}/mcp`,
      token: "run-token-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  });
  const finished = await waitFor(
    () =>
      desktop.messages.find(
        (message) => message.type === "run.finished" && message.runId === runId,
      ),
    { ...WAIT, description: "the run to finish" },
  );
  const chunks = desktop.messages.flatMap((message) =>
    message.type === "run.event" && message.runId === runId
      ? [message.chunk]
      : [],
  );
  return { api, chrome, chunks, desktop, finished, library };
};

/** Each tool call as the run reported it: its name and the input it kept. */
const toolCalls = (chunks: readonly Record<string, unknown>[]) => {
  const args = new Map(
    chunks.flatMap((chunk) =>
      chunk["type"] === EventType.TOOL_CALL_ARGS &&
      typeof chunk["toolCallId"] === "string" &&
      typeof chunk["delta"] === "string"
        ? [[chunk["toolCallId"], chunk["delta"]] as const]
        : [],
    ),
  );
  return chunks.flatMap((chunk) => {
    if (
      chunk["type"] !== EventType.TOOL_CALL_START ||
      typeof chunk["toolCallId"] !== "string"
    ) {
      return [];
    }
    const input = args.get(chunk["toolCallId"]);
    return [
      {
        id: chunk["toolCallId"],
        name: chunk["toolCallName"],
        input: input === undefined ? undefined : JSON.parse(input),
      },
    ];
  });
};

const toolResults = (chunks: readonly Record<string, unknown>[]) =>
  chunks.flatMap((chunk) =>
    chunk["type"] === EventType.TOOL_CALL_RESULT &&
    typeof chunk["content"] === "string"
      ? [JSON.parse(chunk["content"])]
      : [],
  );

describe.each(["codex", "claude-code"] as const)(
  "a local %s run browsing the member's Chrome",
  (harness) => {
    test("searches, opens and cites a result, and no page content leaves the computer", async () => {
      const { api, chrome, chunks, desktop, finished, library } =
        await browse(harness);
      expect(finished).toMatchObject({ outcome: "completed" });

      // The agent searched the library, opened the decision and was sent
      // to the member at the sign-in page.
      expect(chrome.commands.map(({ action }) => action)).toEqual([
        "open",
        "fill",
        "snapshot",
        "click",
        "click",
        "fill",
        "open",
      ]);
      const calls = toolCalls(chunks);
      // The member was asked before the agent typed outside a search field.
      const approvals = desktop.messages.filter(
        (message) => message.type === "run.approval_request",
      );
      expect(approvals).toHaveLength(1);
      expect(calls.filter(({ id }) => id.startsWith("browser-type-"))).toEqual([
        {
          id: expect.stringMatching(/^browser-type-/u),
          name: "local_browser",
          input: {
            action: "type",
            url: `${library.origin}${FIXTURE_CITATION.path}`,
          },
        },
      ]);
      expect(
        calls
          .filter(
            ({ id, name }) =>
              name === CHAT_LOCAL_RUN_TOOL_NAMES.browser &&
              !id.startsWith("browser-type-"),
          )
          .map(({ input, name }) => ({ input, name })),
      ).toEqual([
        {
          name: "local_browser",
          input: { action: "open", url: `${library.origin}/` },
        },
        { name: "local_browser", input: { action: "type" } },
        { name: "local_browser", input: { action: "snapshot" } },
        { name: "local_browser", input: { action: "click" } },
        { name: "local_browser", input: { action: "click" } },
        { name: "local_browser", input: { action: "type" } },
        {
          name: "local_browser",
          input: { action: "open", url: `${library.origin}/account` },
        },
      ]);
      expect(calls.some(({ name }) => name === "search_case_law")).toBe(true);
      expect(toolResults(chunks)).toContainEqual({ status: "needs_member" });

      // It cites the decision it opened.
      expect(JSON.stringify(chunks)).toContain(
        `[${FIXTURE_CITATION.title}](${library.origin}${FIXTURE_CITATION.path})`,
      );

      // Nothing of the pages it read reached the desktop or stella's API,
      // while the agent's own stella call did reach the API.
      expect(api.received.length).toBeGreaterThan(0);
      for (const canary of FIXTURE_CANARIES) {
        for (const line of desktop.lines) {
          expect(line).not.toContain(canary);
        }
        for (const request of api.received) {
          expect(request).not.toContain(canary);
        }
      }
    });
  },
);
