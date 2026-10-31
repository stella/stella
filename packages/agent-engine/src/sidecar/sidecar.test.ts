import { panic, Result } from "better-result";
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

import {
  FAKE_OUTDATED_VERSION,
  FAKE_THREAD_ID,
  type FakeScenario,
} from "../../scripts/fake-codex-app-server";
import { bundledHarnessCompatibility } from "../harness/compatibility";
import {
  HOLDER_LOG_FILE,
  HOLDER_SECRET_FILE,
  startHolderServer,
  SUN_PATH_BYTES,
} from "./holder-server";
import {
  SIDECAR_PROTOCOL,
  type SidecarMessage,
  sidecarMessageSchema,
  type SidecarRunMessage,
} from "./protocol";

/**
 * The holder as the desktop runs it: a process serving the protocol on a
 * real Unix socket, starting `fake-codex-app-server.ts` where the managed
 * Codex CLI would be. Clients connect, drop and reconnect as a desktop
 * would. Limits and timers that take minutes in production are exercised
 * on an in-process holder with small values, over the same socket.
 * Nothing reaches a model provider.
 */

const MAIN = path.join(import.meta.dir, "main.ts");
const FAKE_SERVER = path.join(
  import.meta.dir,
  "../../scripts/fake-codex-app-server.ts",
);
const API_ORIGIN = "https://api.example.test";
const RUN_TOKEN = "run-token-1";
const WAIT_MS = 10_000;

// timeout: each test starts real processes, the holder and the fake harness.
setDefaultTimeout(30_000);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

/** Wait for another process to write a file, its only readiness signal. */
const untilWritten = async (file: string, stillRunning: () => boolean) => {
  const deadline = Date.now() + WAIT_MS;
  // real-time: the holder is another process and signals readiness by file.
  while (!existsSync(file) && stillRunning()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${file}`);
    }
    // real-time: the holder is another process and signals readiness by file.
    await Bun.sleep(10);
  }
};

type Place = {
  root: string;
  dir: string;
  endpoint: string;
  fakeLog: string;
  secret: () => string;
  /** Every request the fake harness received. */
  received: () => { method?: string; params?: unknown; result?: unknown }[];
  log: () => string;
};

const place = (): Place => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-holder-"));
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const dir = path.join(root, "1.4.0");
  const fakeLog = path.join(root, "fake.log");
  return {
    root,
    dir,
    endpoint: path.join(root, "stella-holder-1.4.0.sock"),
    fakeLog,
    secret: () => readFileSync(path.join(dir, HOLDER_SECRET_FILE), "utf-8"),
    received: () =>
      existsSync(fakeLog)
        ? readFileSync(fakeLog, "utf-8")
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line))
            .filter((entry) => entry.received !== undefined)
            .map((entry) => entry.received)
        : [],
    log: () => readFileSync(path.join(dir, HOLDER_LOG_FILE), "utf-8"),
  };
};

type HolderProcess = Place & { exited: Promise<number> };

/** The holder as `main.ts`, the way the desktop starts it. */
const spawnHolder = async (at: Place = place()): Promise<HolderProcess> => {
  const child = Bun.spawn(
    [process.execPath, MAIN, "--dir", at.dir, "--endpoint", at.endpoint],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: process.env["PATH"] ?? "", FAKE_CODEX_LOG: at.fakeLog },
    },
  );
  cleanups.unshift(() => {
    child.kill();
  });
  await untilWritten(
    path.join(at.dir, HOLDER_SECRET_FILE),
    () => child.exitCode === null,
  );
  return { ...at, exited: child.exited };
};

type Client = {
  send: (message: object | string) => void;
  /** Every message so far, in order. */
  messages: SidecarMessage[];
  waitFor: <T extends SidecarMessage>(
    predicate: (message: SidecarMessage) => message is T,
  ) => Promise<T>;
  close: () => void;
  /** Settles when the holder closed the connection. */
  ended: Promise<null>;
};

const connect = async (endpoint: string): Promise<Client> => {
  const socket = net.connect(endpoint);
  cleanups.unshift(() => {
    socket.destroy();
  });
  const { promise: connected, resolve: onConnect } =
    Promise.withResolvers<null>();
  socket.once("connect", () => {
    onConnect(null);
  });
  await connected;
  const { promise: ended, resolve: onEnd } = Promise.withResolvers<null>();
  socket.once("close", () => {
    onEnd(null);
  });
  socket.on("error", () => {
    socket.destroy();
  });
  const messages: SidecarMessage[] = [];
  /** Pending waits; each returns `true` once its message arrived. */
  const waiters = new Set<(message: SidecarMessage) => boolean>();
  const decoder = new TextDecoder();
  let buffer = "";
  socket.on("data", (bytes: Buffer) => {
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
  });
  return {
    messages,
    ended,
    send: (message) => {
      socket.write(
        `${typeof message === "string" ? message : JSON.stringify(message)}\n`,
      );
    },
    waitFor: async <T extends SidecarMessage>(
      predicate: (message: SidecarMessage) => message is T,
    ) => {
      const found = messages.find(predicate);
      if (found !== undefined) {
        return found;
      }
      const { promise, resolve, reject } = Promise.withResolvers<T>();
      const timer = setTimeout(() => {
        reject(new Error("timed out waiting for a holder message"));
      }, WAIT_MS);
      waiters.add((message) => {
        if (!predicate(message)) {
          return false;
        }
        clearTimeout(timer);
        resolve(message);
        return true;
      });
      return promise;
    },
    close: () => {
      socket.destroy();
    },
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

const helloMessage = (
  at: Place,
  resume: { runId: string; afterSeq: number }[] = [],
) => ({
  type: "hello",
  protocol: SIDECAR_PROTOCOL,
  secret: at.secret(),
  appVersion: "1.4.0",
  apiOrigin: API_ORIGIN,
  resume,
});

/** Connect and authenticate as the desktop. */
const desktop = async (
  at: Place,
  resume: { runId: string; afterSeq: number }[] = [],
) => {
  const client = await connect(at.endpoint);
  client.send(helloMessage(at, resume));
  const hello = await client.waitFor(is("hello"));
  return { client, hello };
};

const runStart = (
  client: Client,
  at: Place,
  scenario: FakeScenario,
  overrides: object = {},
) => {
  const runId = crypto.randomUUID();
  const configDir = path.join(at.root, "codex-home");
  const workspaceDir = path.join(at.root, "workspace");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  client.send({
    type: "run.start",
    runId,
    threadId: "thread-1",
    harness: "codex",
    executable: fakeCodex(at.root, scenario),
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

const runMessages = (client: Client, runId: string): SidecarRunMessage[] =>
  client.messages.flatMap((message) =>
    (message.type === "run.event" ||
      message.type === "run.approval_request" ||
      message.type === "run.finished") &&
    message.runId === runId
      ? [message]
      : [],
  );

const seqs = (client: Client, runId: string) =>
  runMessages(client, runId).map(({ seq }) => seq);

const chunksOf = (client: Client, runId: string) =>
  runMessages(client, runId).flatMap((message) =>
    message.type === "run.event" ? [message.chunk] : [],
  );

const range = (from: number, to: number) =>
  Array.from(
    { length: Math.max(0, to - from + 1) },
    (_, index) => from + index,
  );

describe("harness holder over its socket", () => {
  test("closes a connection without the secret, and never answers it", async () => {
    const holder = await spawnHolder();
    const cases = [
      { ...helloMessage(holder), secret: "0".repeat(64) },
      { type: "run.cancel", runId: crypto.randomUUID() },
      "{not json",
    ];
    for (const line of cases) {
      const stranger = await connect(holder.endpoint);
      stranger.send(line);
      await stranger.ended;
      expect(stranger.messages).toEqual([]);
    }
    // The holder still serves its desktop.
    const { hello } = await desktop(holder);
    expect(hello).toEqual({
      type: "hello",
      protocol: SIDECAR_PROTOCOL,
      sidecarVersion: "0.0.0",
      mode: "serving",
      runs: [],
    });
  });

  test("answers another protocol with a rejection and keeps running", async () => {
    const holder = await spawnHolder();
    const older = await connect(holder.endpoint);
    older.send({ ...helloMessage(holder), protocol: SIDECAR_PROTOCOL - 1 });
    expect(await older.waitFor(is("rejected"))).toMatchObject({
      reason: "protocol_mismatch",
    });
    await older.ended;
    expect(older.messages.some(is("hello"))).toBe(false);
    await desktop(holder);
  });

  test("rejects unknown and invalid lines once authenticated", async () => {
    const holder = await spawnHolder();
    const { client } = await desktop(holder);
    client.send({ type: "run.input", runId: crypto.randomUUID() });
    client.send("{not json");
    client.send({ type: "run.cancel", runId: "run-1" });
    client.send(helloMessage(holder));
    const unknownRun = crypto.randomUUID();
    client.send({
      type: "run.token",
      runId: unknownRun,
      token: "t",
      expiresAt: "2026-10-28T12:00:00.000Z",
    });
    client.send({ type: "ack", runId: unknownRun, seq: 1 });
    client.send({ type: "resume", runId: unknownRun, afterSeq: 0 });
    await client.waitFor(
      (message): message is SidecarMessage =>
        message.type === "rejected" && message.messageType === "resume",
    );
    expect(
      client.messages
        .filter((message) => message.type === "rejected")
        .map((message) => [message.reason, message.messageType]),
    ).toEqual([
      ["unknown_type", "run.input"],
      ["not_json", null],
      ["invalid", "run.cancel"],
      ["hello_repeated", "hello"],
      ["unknown_run", "run.token"],
      ["unknown_run", "ack"],
      ["unknown_run", "resume"],
    ]);
  });

  test("a new desktop connection replaces the previous one", async () => {
    const holder = await spawnHolder();
    const first = await desktop(holder);
    const second = await desktop(holder);
    await first.client.ended;
    const runId = runStart(second.client, holder, "stella_tools");
    await second.client.waitFor(is("run.finished", runId));
    expect(runMessages(first.client, runId)).toEqual([]);
  });

  test("a second holder on the same endpoint exits and leaves the first serving", async () => {
    const holder = await spawnHolder();
    const secret = holder.secret();
    const second = await spawnHolder(holder);
    expect(await second.exited).toBe(0);
    expect(holder.secret()).toBe(secret);
    await desktop(holder);
  });

  test("refuses a folder other users can reach", async () => {
    const at = place();
    mkdirSync(at.dir, { mode: 0o755 });
    chmodSync(at.dir, 0o755);
    const holder = await spawnHolder(at);
    expect(await holder.exited).toBe(1);
    expect(existsSync(at.endpoint)).toBe(false);
  });

  test("refuses a socket path that does not fit the platform's limit", async () => {
    const at = place();
    const fits = path.join(
      at.root,
      "s".repeat(SUN_PATH_BYTES - 1 - Buffer.byteLength(`${at.root}/`)),
    );
    expect(Buffer.byteLength(fits)).toBe(SUN_PATH_BYTES - 1);
    const endpoint = `${fits}x`;
    const holder = await spawnHolder({ ...at, endpoint });
    expect(await holder.exited).toBe(1);
    expect(existsSync(endpoint)).toBe(false);
    expect(existsSync(path.join(at.dir, HOLDER_SECRET_FILE))).toBe(false);
    expect(at.log()).toContain(
      `endpoint_too_long: The socket path is ${SUN_PATH_BYTES} bytes`,
    );
  });

  test("refuses a socket folder other users can reach", async () => {
    const at = place();
    const shared = path.join(at.root, "shared");
    mkdirSync(shared, { mode: 0o755 });
    chmodSync(shared, 0o755);
    const endpoint = path.join(shared, "stella-holder-1.4.0.sock");
    const holder = await spawnHolder({ ...at, endpoint });
    expect(await holder.exited).toBe(1);
    expect(existsSync(endpoint)).toBe(false);
    expect(at.log()).toContain("insecure_endpoint");
  });

  test("probes the harness's version, capabilities and visible models", async () => {
    const holder = await spawnHolder();
    const { client } = await desktop(holder);
    const requestId = crypto.randomUUID();
    const configDir = path.join(holder.root, "codex-home");
    mkdirSync(configDir);
    client.send({
      type: "harness.probe",
      requestId,
      harness: "codex",
      executable: fakeCodex(holder.root, "probe"),
      configDir,
    });
    expect(await client.waitFor(is("harness.probed"))).toEqual({
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
    expect(holder.received().map(({ method }) => method)).not.toContain(
      "turn/start",
    );
  });

  test("reports a version the compatibility policy refuses as unsupported, with the recommended one", async () => {
    const holder = await spawnHolder();
    const { client } = await desktop(holder);
    const requestId = crypto.randomUUID();
    const configDir = path.join(holder.root, "codex-home");
    mkdirSync(configDir);
    client.send({
      type: "harness.probe",
      requestId,
      harness: "codex",
      executable: fakeCodex(holder.root, "outdated"),
      configDir,
    });
    const policy = bundledHarnessCompatibility().compatibility.find(
      ({ harness }) => harness === "codex",
    );
    expect((await client.waitFor(is("harness.probed"))).outcome).toEqual({
      type: "unsupported",
      version: FAKE_OUTDATED_VERSION,
      recommendedVersion: policy?.recommendedVersion ?? null,
    });
  });

  test("reports a signed-out harness and one without an adapter", async () => {
    const holder = await spawnHolder();
    const { client } = await desktop(holder);
    const configDir = path.join(holder.root, "codex-home");
    mkdirSync(configDir);
    const signedOut = crypto.randomUUID();
    client.send({
      type: "harness.probe",
      requestId: signedOut,
      harness: "codex",
      executable: fakeCodex(holder.root, "signed_out"),
      configDir,
    });
    const claude = crypto.randomUUID();
    client.send({
      type: "harness.probe",
      requestId: claude,
      harness: "claude-code",
      executable: "/nonexistent/claude",
      configDir,
    });
    const probed = async (requestId: string) =>
      client.waitFor(
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

  test("streams a run's chunks numbered from 1 and finishes with the native session", async () => {
    const holder = await spawnHolder();
    const { client } = await desktop(holder);
    const runId = runStart(client, holder, "stella_tools");
    const finished = await client.waitFor(is("run.finished", runId));
    expect(finished).toMatchObject({
      outcome: "completed",
      harnessSessionId: FAKE_THREAD_ID,
    });
    expect(seqs(client, runId)).toEqual(range(1, finished.seq));
    const chunks = chunksOf(client, runId);
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
    expect(client.messages.at(-1)).toMatchObject({ type: "run.finished" });
  });

  test("hands the harness the loopback proxy and a run secret, never the run token", async () => {
    const holder = await spawnHolder();
    const { client } = await desktop(holder);
    const runId = runStart(client, holder, "stella_tools");
    await client.waitFor(is("run.finished", runId));
    const threadStart = holder
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
    expect(JSON.stringify(holder.received())).not.toContain(RUN_TOKEN);
    const secret = holder.secret();
    client.send({ type: "shutdown" });
    expect(await holder.exited).toBe(0);
    expect(holder.log()).not.toContain(RUN_TOKEN);
    expect(holder.log()).not.toContain(secret);
  });

  test("relays an approval with one request id and returns the decision", async () => {
    const holder = await spawnHolder();
    const { client } = await desktop(holder);
    const runId = runStart(client, holder, "approval");
    const request = await client.waitFor(is("run.approval_request", runId));
    expect(request).toMatchObject({
      kind: "command",
      summary: "Deletes a file",
    });
    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    const pause = chunksOf(client, runId).at(-1);
    expect(pause).toMatchObject({
      type: "RUN_FINISHED",
      outcome: { type: "interrupt", interrupts: [{ id: request.requestId }] },
    });
    client.send({
      type: "run.approval",
      runId,
      requestId: request.requestId,
      decision: "deny",
    });
    expect(await client.waitFor(is("run.finished", runId))).toMatchObject({
      outcome: "completed",
    });
    const answer = holder
      .received()
      .find(
        (message) =>
          message.method === undefined && message.result !== undefined,
      );
    expect(answer?.result).toEqual({ decision: "decline" });
  });

  test("interrupt finishes as interrupted, cancel as cancelled", async () => {
    const holder = await spawnHolder();
    const { client } = await desktop(holder);
    for (const [type, outcome] of [
      ["run.interrupt", "interrupted"],
      ["run.cancel", "cancelled"],
    ] as const) {
      const runId = runStart(client, holder, "interrupt_queued");
      await client.waitFor(
        (message): message is SidecarMessage =>
          message.type === "run.event" &&
          message.runId === runId &&
          message.chunk.type === "TOOL_CALL_START",
      );
      client.send({ type, runId });
      expect(await client.waitFor(is("run.finished", runId))).toMatchObject({
        outcome,
      });
    }
  });

  test("maps a harness failure to the runner outcome", async () => {
    const holder = await spawnHolder();
    const { client } = await desktop(holder);
    const runId = runStart(client, holder, "auth_expired");
    expect(await client.waitFor(is("run.finished", runId))).toMatchObject({
      outcome: "needs_login",
    });
    expect(chunksOf(client, runId).at(-1)).toMatchObject({
      type: "RUN_ERROR",
      code: "harness.auth_required",
    });
  });

  test("never starts the harness for an MCP endpoint off the stella origin", async () => {
    const holder = await spawnHolder();
    const { client } = await desktop(holder);
    const runId = runStart(client, holder, "stella_tools", {
      mcp: {
        serverName: "stella",
        url: "https://evil.test/mcp",
        token: RUN_TOKEN,
        expiresAt: "2026-10-28T12:00:00.000Z",
      },
    });
    expect(await client.waitFor(is("run.finished", runId))).toEqual({
      type: "run.finished",
      runId,
      seq: 3,
      outcome: "failed",
      harnessSessionId: null,
    });
    expect(chunksOf(client, runId).map((chunk) => chunk.type)).toEqual([
      "RUN_STARTED",
      "RUN_ERROR",
    ]);
    expect(holder.received()).toEqual([]);
  });

  test("refuses a second start of a held run", async () => {
    const holder = await spawnHolder();
    const { client } = await desktop(holder);
    const runId = runStart(client, holder, "interrupt_queued");
    runStart(client, holder, "interrupt_queued", { runId });
    expect(await client.waitFor(is("rejected", runId))).toMatchObject({
      reason: "duplicate_run",
    });
    client.send({ type: "run.cancel", runId });
    await client.waitFor(is("run.finished", runId));
    expect(client.messages.filter(is("run.finished"))).toHaveLength(1);
  });

  test("a desktop that drops mid-run receives the rest exactly once after it reconnects", async () => {
    const holder = await spawnHolder();
    const first = await desktop(holder);
    const runId = runStart(first.client, holder, "approval");
    const request = await first.client.waitFor(
      is("run.approval_request", runId),
    );
    // Decide, then drop before the rest of the run arrives.
    first.client.send({
      type: "run.approval",
      runId,
      requestId: request.requestId,
      decision: "deny",
    });
    first.client.close();
    await first.client.ended;
    const held = Math.max(...seqs(first.client, runId));
    expect(held).toBeGreaterThanOrEqual(request.seq);

    const second = await desktop(holder, [{ runId, afterSeq: held }]);
    expect(second.hello.runs).toEqual([
      expect.objectContaining({ runId, harness: "codex" }),
    ]);
    const finished = await second.client.waitFor(is("run.finished", runId));
    expect(finished.outcome).toBe("completed");
    expect([
      ...seqs(first.client, runId),
      ...seqs(second.client, runId),
    ]).toEqual(range(1, finished.seq));
  });

  test("keeps a finished run until it is acked, and resends only what is not", async () => {
    const holder = await spawnHolder();
    const first = await desktop(holder);
    const runId = runStart(first.client, holder, "stella_tools");
    const finished = await first.client.waitFor(is("run.finished", runId));
    const acked = 3;
    expect(finished.seq).toBeGreaterThan(acked);
    first.client.send({ type: "ack", runId, seq: acked });
    first.client.close();
    await first.client.ended;

    // A run the desktop does not resume stays held and silent.
    const second = await desktop(holder);
    expect(second.hello.runs).toEqual([
      { runId, harness: "codex", lastSeq: finished.seq },
    ]);
    second.client.send({ type: "resume", runId, afterSeq: 0 });
    await second.client.waitFor(is("run.finished", runId));
    expect(seqs(second.client, runId)).toEqual(range(acked + 1, finished.seq));
    expect(runMessages(second.client, runId)).toEqual(
      runMessages(first.client, runId).slice(acked),
    );

    second.client.send({ type: "ack", runId, seq: finished.seq });
    second.client.close();
    await second.client.ended;
    const third = await desktop(holder, [{ runId, afterSeq: 0 }]);
    expect(third.hello.runs).toEqual([]);
    expect(await third.client.waitFor(is("rejected", runId))).toMatchObject({
      reason: "unknown_run",
      messageType: "hello",
    });
  });

  test("closing the connection keeps runs going; shutdown cancels them and exits", async () => {
    const holder = await spawnHolder();
    const first = await desktop(holder);
    const runId = runStart(first.client, holder, "interrupt_queued");
    await first.client.waitFor(is("run.event", runId));
    first.client.close();
    await first.client.ended;
    // real-time: a run wrongly cancelled on disconnect needs a moment to end.
    await Bun.sleep(200);

    const second = await desktop(holder, [{ runId, afterSeq: 0 }]);
    expect(second.hello.runs).toEqual([
      expect.objectContaining({ runId, harness: "codex" }),
    ]);
    expect(second.client.messages.some(is("run.finished", runId))).toBe(false);
    second.client.send({ type: "shutdown" });
    expect(await holder.exited).toBe(0);
    expect(
      second.client.messages.find(is("run.finished", runId)),
    ).toMatchObject({ outcome: "cancelled" });
    expect(existsSync(holder.endpoint)).toBe(false);
    expect(existsSync(path.join(holder.dir, HOLDER_SECRET_FILE))).toBe(false);
  });

  test("a draining holder refuses new runs and exits once its runs are acked", async () => {
    const holder = await spawnHolder();
    const { client } = await desktop(holder);
    const runId = runStart(client, holder, "interrupt_queued");
    await client.waitFor(is("run.event", runId));
    client.send({ type: "drain" });
    const refused = runStart(client, holder, "stella_tools");
    expect(await client.waitFor(is("rejected", refused))).toMatchObject({
      reason: "draining",
      messageType: "run.start",
    });
    client.send({ type: "run.cancel", runId });
    const finished = await client.waitFor(is("run.finished", runId));
    // real-time: a holder that wrongly exits before the ack needs a moment.
    await Bun.sleep(200);
    const reconnected = await desktop(holder);
    expect(reconnected.hello).toMatchObject({
      mode: "draining",
      runs: [{ runId, lastSeq: finished.seq }],
    });
    reconnected.client.send({ type: "ack", runId, seq: finished.seq });
    expect(await holder.exited).toBe(0);
  });
});

describe("holder limits and timers", () => {
  const startInProcess = async (
    overrides: Partial<{
      idleExitMs: number;
      unackedRetentionMs: number;
      limits: { maxMessages: number; maxBytes: number };
    }>,
  ) => {
    const at = place();
    const started = await startHolderServer({
      dir: at.dir,
      endpoint: at.endpoint,
      sidecarVersion: "1.4.0",
      environment: {
        PATH: process.env["PATH"] ?? "",
        FAKE_CODEX_LOG: at.fakeLog,
      },
      idleExitMs: 60_000,
      helloTimeoutMs: 5000,
      unackedRetentionMs: 60_000,
      limits: { maxMessages: 1000, maxBytes: 1024 * 1024 },
      ...overrides,
    });
    const server = Result.isOk(started)
      ? started.value
      : panic(`the holder did not start: ${started.error.message}`);
    cleanups.unshift(() => {
      server.holder.stop();
    });
    return { at, server };
  };

  for (const limits of [
    { name: "messages", maxMessages: 3, maxBytes: 1024 * 1024 },
    { name: "bytes", maxMessages: 1000, maxBytes: 600 },
  ]) {
    test(`a run that outgrows the buffer by ${limits.name} ends failed with a buffer_full chunk`, async () => {
      const { at } = await startInProcess({ limits });
      const { client } = await desktop(at);
      const runId = runStart(client, at, "stella_tools");
      const finished = await client.waitFor(is("run.finished", runId));
      expect(finished.outcome).toBe("failed");
      const messages = runMessages(client, runId);
      expect(seqs(client, runId)).toEqual(range(1, finished.seq));
      expect(messages.at(-2)).toMatchObject({
        type: "run.event",
        chunk: { type: "RUN_ERROR", code: "sidecar.buffer_full", runId },
      });
      const kept = messages.slice(0, -2);
      expect(kept.length).toBeLessThanOrEqual(limits.maxMessages);
      expect(
        kept.reduce(
          (bytes, message) =>
            bytes + Buffer.byteLength(`${JSON.stringify(message)}\n`),
          0,
        ),
      ).toBeLessThanOrEqual(limits.maxBytes);
    });
  }

  test("exits after the idle time with no run held and no desktop", async () => {
    const { at, server } = await startInProcess({ idleExitMs: 300 });
    const { client } = await desktop(at);
    // real-time: a connected desktop must keep the holder past its idle timer.
    await Bun.sleep(600);
    expect(existsSync(at.endpoint)).toBe(true);
    client.close();
    await server.exited;
    expect(existsSync(at.endpoint)).toBe(false);
  });

  test("forgets a finished run no desktop collected within the retention", async () => {
    const { at } = await startInProcess({ unackedRetentionMs: 200 });
    const first = await desktop(at);
    const runId = runStart(first.client, at, "stella_tools");
    await first.client.waitFor(is("run.finished", runId));
    first.client.close();
    await first.client.ended;
    // real-time: the retention is a timer the holder arms on the last message.
    await Bun.sleep(400);
    const second = await desktop(at);
    expect(second.hello.runs).toEqual([]);
  });
});
