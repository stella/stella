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
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import {
  FAKE_THREAD_ID,
  type FakeScenario,
} from "../../scripts/fake-codex-app-server";
import {
  SIDECAR_PROTOCOL,
  type SidecarMessage,
  sidecarMessageSchema,
} from "./protocol";

/**
 * The sidecar as the desktop runs it: a child process speaking the protocol
 * on stdio, starting `fake-codex-app-server.ts` where the managed Codex CLI
 * would be. Nothing reaches a model provider.
 */

const MAIN = path.join(import.meta.dir, "main.ts");
const FAKE_SERVER = path.join(
  import.meta.dir,
  "../../scripts/fake-codex-app-server.ts",
);
const API_ORIGIN = "https://api.example.test";
const RUN_TOKEN = "run-token-1";

// timeout: each test starts real processes, the sidecar and the fake harness.
setDefaultTimeout(30_000);

type Sidecar = {
  send: (message: object | string) => void;
  /** Every message so far, in order. */
  messages: SidecarMessage[];
  waitFor: <T extends SidecarMessage>(
    predicate: (message: SidecarMessage) => message is T,
  ) => Promise<T>;
  closeInput: () => void;
  exited: Promise<number>;
  stderr: () => Promise<string>;
  root: string;
  received: () => { method?: string; params?: unknown; result?: unknown }[];
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const spawnSidecar = (): Sidecar => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-sidecar-"));
  const logPath = path.join(root, "fake.log");
  const child = Bun.spawn([process.execPath, MAIN], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env["PATH"] ?? "", FAKE_CODEX_LOG: logPath },
  });
  cleanups.push(() => {
    child.kill();
    rmSync(root, { recursive: true, force: true });
  });
  const messages: SidecarMessage[] = [];
  /** Pending waits; each returns `true` once its message arrived. */
  const waiters = new Set<(message: SidecarMessage) => boolean>();
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const bytes of child.stdout) {
      buffer += decoder.decode(bytes, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const message = v.parse(
          sidecarMessageSchema,
          JSON.parse(buffer.slice(0, newline)),
        );
        messages.push(message);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        for (const waiter of waiters) {
          if (waiter(message)) {
            waiters.delete(waiter);
          }
        }
      }
    }
  })();
  return {
    root,
    messages,
    send: (message) => {
      void child.stdin.write(
        `${typeof message === "string" ? message : JSON.stringify(message)}\n`,
      );
      void child.stdin.flush();
    },
    waitFor: async <T extends SidecarMessage>(
      predicate: (message: SidecarMessage) => message is T,
    ) => {
      const found = messages.find(predicate);
      if (found !== undefined) {
        return found;
      }
      const { promise, resolve } = Promise.withResolvers<T>();
      waiters.add((message) => {
        if (!predicate(message)) {
          return false;
        }
        resolve(message);
        return true;
      });
      return promise;
    },
    closeInput: () => {
      void child.stdin.end();
    },
    exited: child.exited,
    stderr: async () => new Response(child.stderr).text(),
    received: () =>
      existsSync(logPath)
        ? readFileSync(logPath, "utf-8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line))
            .filter((entry) => entry.received !== undefined)
            .map((entry) => entry.received)
        : [],
  };
};

/** The managed CLI's place: a script that starts the fake on a scenario. */
const fakeCodex = (root: string, scenario: FakeScenario) => {
  const executable = path.join(root, `codex-${scenario}`);
  writeFileSync(
    executable,
    `#!/bin/sh\nexec "${process.execPath}" "${FAKE_SERVER}" "${scenario}"\n`,
  );
  chmodSync(executable, 0o755);
  return executable;
};

const is =
  <K extends SidecarMessage["type"]>(type: K, runId?: string) =>
  (message: SidecarMessage): message is Extract<SidecarMessage, { type: K }> =>
    message.type === type &&
    (runId === undefined || ("runId" in message && message.runId === runId));

const hello = async (sidecar: Sidecar) => {
  sidecar.send({
    type: "hello",
    protocol: SIDECAR_PROTOCOL,
    appVersion: "1.4.0",
    apiOrigin: API_ORIGIN,
  });
  return sidecar.waitFor(is("hello"));
};

const runStart = (
  sidecar: Sidecar,
  scenario: FakeScenario,
  overrides: object = {},
) => {
  const runId = crypto.randomUUID();
  const configDir = path.join(sidecar.root, "codex-home");
  const workspaceDir = path.join(sidecar.root, "workspace");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  sidecar.send({
    type: "run.start",
    runId,
    threadId: "thread-1",
    harness: "codex",
    executable: fakeCodex(sidecar.root, scenario),
    configDir,
    workspaceDir,
    model: "gpt-test",
    instructions: "Use the stella MCP server.",
    messages: [{ role: "user", content: "Find the lease decision." }],
    harnessSessionId: null,
    policy: { network: "open", fs: "workspace" },
    mcp: {
      serverName: "stella",
      url: `${API_ORIGIN}/mcp`,
      token: RUN_TOKEN,
      expiresAt: "2026-10-28T12:00:00.000Z",
    },
    ...overrides,
  });
  return runId;
};

const chunksOf = (sidecar: Sidecar, runId: string) =>
  sidecar.messages.flatMap((message) =>
    message.type === "run.event" && message.runId === runId
      ? [message.chunk]
      : [],
  );

describe("harness sidecar over stdio", () => {
  test("answers hello and rejects lines before it, unknown and invalid ones", async () => {
    const sidecar = spawnSidecar();
    sidecar.send({ type: "run.cancel", runId: crypto.randomUUID() });
    sidecar.send({ type: "run.input", runId: crypto.randomUUID() });
    sidecar.send("{not json");
    sidecar.send({ type: "run.cancel", runId: "run-1" });
    expect(await hello(sidecar)).toEqual({
      type: "hello",
      protocol: SIDECAR_PROTOCOL,
      sidecarVersion: "0.0.0",
    });
    sidecar.send({
      type: "hello",
      protocol: SIDECAR_PROTOCOL,
      appVersion: "1.4.0",
      apiOrigin: API_ORIGIN,
    });
    const unknownRun = crypto.randomUUID();
    sidecar.send({
      type: "run.token",
      runId: unknownRun,
      token: "t",
      expiresAt: "2026-10-28T12:00:00.000Z",
    });
    await sidecar.waitFor(is("rejected", unknownRun));
    expect(
      sidecar.messages
        .filter((message) => message.type === "rejected")
        .map((message) => [message.reason, message.messageType]),
    ).toEqual([
      ["hello_required", "run.cancel"],
      ["unknown_type", "run.input"],
      ["not_json", null],
      ["invalid", "run.cancel"],
      ["hello_repeated", "hello"],
      ["unknown_run", "run.token"],
    ]);
    sidecar.send({ type: "shutdown" });
    expect(await sidecar.exited).toBe(0);
  });

  test("ends on a protocol mismatch", async () => {
    const sidecar = spawnSidecar();
    sidecar.send({
      type: "hello",
      protocol: SIDECAR_PROTOCOL + 1,
      appVersion: "1.4.0",
      apiOrigin: API_ORIGIN,
    });
    expect(await sidecar.waitFor(is("rejected"))).toMatchObject({
      reason: "protocol_mismatch",
    });
    expect(await sidecar.exited).toBe(0);
    expect(sidecar.messages.some(is("hello"))).toBe(false);
  });

  test("probes the harness's version, capabilities and visible models", async () => {
    const sidecar = spawnSidecar();
    await hello(sidecar);
    const requestId = crypto.randomUUID();
    const configDir = path.join(sidecar.root, "codex-home");
    mkdirSync(configDir);
    sidecar.send({
      type: "harness.probe",
      requestId,
      harness: "codex",
      executable: fakeCodex(sidecar.root, "probe"),
      configDir,
    });
    expect(await sidecar.waitFor(is("harness.probed"))).toEqual({
      type: "harness.probed",
      requestId,
      harness: "codex",
      outcome: {
        type: "ready",
        version: "0.165.0",
        capabilities: ["approvals", "interrupt", "resume"],
        models: [{ id: "gpt-test", label: "GPT Test", isDefault: true }],
      },
    });
    expect(sidecar.received().map(({ method }) => method)).not.toContain(
      "turn/start",
    );
  });

  test("reports a signed-out harness and one without an adapter", async () => {
    const sidecar = spawnSidecar();
    await hello(sidecar);
    const configDir = path.join(sidecar.root, "codex-home");
    mkdirSync(configDir);
    const signedOut = crypto.randomUUID();
    sidecar.send({
      type: "harness.probe",
      requestId: signedOut,
      harness: "codex",
      executable: fakeCodex(sidecar.root, "signed_out"),
      configDir,
    });
    const claude = crypto.randomUUID();
    sidecar.send({
      type: "harness.probe",
      requestId: claude,
      harness: "claude-code",
      executable: "/nonexistent/claude",
      configDir,
    });
    const probed = (requestId: string) =>
      sidecar.waitFor(
        (
          message,
        ): message is Extract<SidecarMessage, { type: "harness.probed" }> =>
          message.type === "harness.probed" && message.requestId === requestId,
      );
    expect((await probed(signedOut)).outcome).toEqual({
      type: "needs_login",
      version: "0.165.0",
    });
    expect((await probed(claude)).outcome).toMatchObject({
      type: "failed",
      reason: "unsupported",
    });
  });

  test("streams a run's chunks and finishes with the native session", async () => {
    const sidecar = spawnSidecar();
    await hello(sidecar);
    const runId = runStart(sidecar, "stella_tools");
    expect(await sidecar.waitFor(is("run.finished", runId))).toEqual({
      type: "run.finished",
      runId,
      outcome: "completed",
      harnessSessionId: FAKE_THREAD_ID,
    });
    const chunks = chunksOf(sidecar, runId);
    expect(chunks[0]).toMatchObject({ type: "RUN_STARTED", runId });
    expect(chunks.at(-1)).toMatchObject({ type: "RUN_FINISHED", runId });
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: "CUSTOM",
        name: "codex.session-id",
        value: { sessionId: FAKE_THREAD_ID },
      }),
    );
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: "TOOL_CALL_START",
        toolCallName: "search_case_law",
      }),
    );
    // Nothing after the run's last message.
    expect(sidecar.messages.at(-1)).toMatchObject({ type: "run.finished" });
  });

  test("hands the harness the loopback proxy and a run secret, never the run token", async () => {
    const sidecar = spawnSidecar();
    await hello(sidecar);
    const runId = runStart(sidecar, "stella_tools");
    await sidecar.waitFor(is("run.finished", runId));
    const threadStart = sidecar
      .received()
      .find(({ method }) => method === "thread/start");
    const server = v.parse(
      v.object({
        url: v.string(),
        http_headers: v.object({ Authorization: v.string() }),
      }),
      v.parse(
        v.object({ config: v.record(v.string(), v.unknown()) }),
        threadStart?.params,
      ).config["mcp_servers.stella"],
    );
    expect(server.url).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:\\d+/mcp/${runId}$`, "u"),
    );
    expect(server.http_headers.Authorization).toMatch(/^Bearer \S{43,}$/u);
    expect(JSON.stringify(sidecar.received())).not.toContain(RUN_TOKEN);
    sidecar.closeInput();
    expect(await sidecar.exited).toBe(0);
    expect(await sidecar.stderr()).not.toContain(RUN_TOKEN);
  });

  test("relays an approval with one request id and returns the decision", async () => {
    const sidecar = spawnSidecar();
    await hello(sidecar);
    const runId = runStart(sidecar, "approval");
    const request = await sidecar.waitFor(is("run.approval_request", runId));
    expect(request).toMatchObject({
      kind: "command",
      summary: "Deletes a file",
    });
    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    const pause = chunksOf(sidecar, runId).at(-1);
    expect(pause).toMatchObject({
      type: "RUN_FINISHED",
      outcome: { type: "interrupt", interrupts: [{ id: request.requestId }] },
    });
    sidecar.send({
      type: "run.approval",
      runId,
      requestId: request.requestId,
      decision: "deny",
    });
    expect(await sidecar.waitFor(is("run.finished", runId))).toMatchObject({
      outcome: "completed",
    });
    const answer = sidecar
      .received()
      .find(
        (message) =>
          message.method === undefined && message.result !== undefined,
      );
    expect(answer?.result).toEqual({ decision: "decline" });
  });

  test("interrupt finishes as interrupted, cancel as cancelled", async () => {
    for (const [type, outcome] of [
      ["run.interrupt", "interrupted"],
      ["run.cancel", "cancelled"],
    ] as const) {
      const sidecar = spawnSidecar();
      await hello(sidecar);
      const runId = runStart(sidecar, "interrupt_queued");
      await sidecar.waitFor(
        (message): message is SidecarMessage =>
          message.type === "run.event" &&
          message.runId === runId &&
          message.chunk.type === "TOOL_CALL_START",
      );
      sidecar.send({ type, runId });
      expect(await sidecar.waitFor(is("run.finished", runId))).toMatchObject({
        outcome,
      });
    }
  });

  test("maps a harness failure to the runner outcome", async () => {
    const sidecar = spawnSidecar();
    await hello(sidecar);
    const runId = runStart(sidecar, "auth_expired");
    expect(await sidecar.waitFor(is("run.finished", runId))).toMatchObject({
      outcome: "needs_login",
    });
    expect(chunksOf(sidecar, runId).at(-1)).toMatchObject({
      type: "RUN_ERROR",
      code: "harness.auth_required",
    });
  });

  test("never starts the harness for an MCP endpoint off the stella origin", async () => {
    const sidecar = spawnSidecar();
    await hello(sidecar);
    const runId = runStart(sidecar, "stella_tools", {
      mcp: {
        serverName: "stella",
        url: "https://evil.test/mcp",
        token: RUN_TOKEN,
        expiresAt: "2026-10-28T12:00:00.000Z",
      },
    });
    expect(await sidecar.waitFor(is("run.finished", runId))).toEqual({
      type: "run.finished",
      runId,
      outcome: "failed",
      harnessSessionId: null,
    });
    expect(chunksOf(sidecar, runId).map((chunk) => chunk.type)).toEqual([
      "RUN_STARTED",
      "RUN_ERROR",
    ]);
    expect(sidecar.received()).toEqual([]);
  });

  test("refuses a second start of a running run", async () => {
    const sidecar = spawnSidecar();
    await hello(sidecar);
    const runId = runStart(sidecar, "interrupt_queued");
    runStart(sidecar, "interrupt_queued", { runId });
    expect(await sidecar.waitFor(is("rejected", runId))).toMatchObject({
      reason: "duplicate_run",
    });
    sidecar.send({ type: "run.cancel", runId });
    await sidecar.waitFor(is("run.finished", runId));
    expect(sidecar.messages.filter(is("run.finished"))).toHaveLength(1);
  });

  test("closing stdin cancels running runs and exits", async () => {
    const sidecar = spawnSidecar();
    await hello(sidecar);
    const runId = runStart(sidecar, "interrupt_queued");
    await sidecar.waitFor(is("run.event", runId));
    sidecar.closeInput();
    expect(await sidecar.exited).toBe(0);
    expect(sidecar.messages.find(is("run.finished", runId))).toMatchObject({
      outcome: "cancelled",
    });
  });
});
