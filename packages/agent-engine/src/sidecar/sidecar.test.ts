import { panic, Result } from "better-result";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { DESKTOP_RUNNER_INPUT_EVENT } from "@stll/api-contract/desktop-runner";

import {
  FAKE_CLAUDE_VERSION,
  type FakeScenarioName,
} from "../../scripts/fake-claude-code-cli";
import {
  FAKE_OUTDATED_VERSION,
  FAKE_THREAD_ID,
  type FakeScenario,
} from "../../scripts/fake-codex-app-server";
import { bundledHarnessCompatibility } from "../harness/compatibility";
import { PROTOCOL_LOG_OFF } from "../protocol-log";
import {
  HOLDER_ENDPOINT_FILE,
  HOLDER_LOG_FILE,
  HOLDER_SECRET_FILE,
  startHolderServer,
  SUN_PATH_BYTES,
} from "./holder-server";
import { SidecarHost } from "./host";
import {
  SIDECAR_PROTOCOL,
  type SidecarHostOutput,
  type SidecarMessage,
  sidecarMessageSchema,
  type SidecarRunMessage,
} from "./protocol";

/**
 * The holder as the desktop runs it: a process serving the protocol on a
 * real Unix socket, starting `fake-codex-app-server.ts` or
 * `fake-claude-code-cli.ts` where the managed CLI would be. Clients connect, drop and reconnect as a desktop
 * would. Limits and timers that take minutes in production are exercised
 * on an in-process holder with small values, over the same socket.
 * Nothing reaches a model provider.
 */

const MAIN = path.join(import.meta.dir, "main.ts");
const FAKE_SERVER = path.join(
  import.meta.dir,
  "../../scripts/fake-codex-app-server.ts",
);
const FAKE_CLAUDE = path.join(
  import.meta.dir,
  "../../scripts/fake-claude-code-cli.ts",
);
const API_ORIGIN = "https://api.example.test";
const RUN_TOKEN = "run-token-1";
/** A launch with nothing added: the harness's managed home only. */
const PLAIN_LAUNCH = {
  configOverrides: [],
  environment: {},
  removedEnvironment: [],
  clientName: null,
  processGrant: false,
};
const WAIT_MS = 10_000;

// timeout: each test starts real processes, the holder and the fake harness.
setDefaultTimeout(30_000);

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
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
  /** What either fake harness received; Claude's messages carry a `type`. */
  received: () => {
    method?: string;
    params?: unknown;
    result?: unknown;
    type?: string;
    request?: { subtype?: string; servers?: unknown };
  }[];
  /** How each fake harness process started, in order. */
  startups: () => unknown[];
  log: () => string;
};

/** Every line the fake harnesses logged, parsed. */
const fakeEntries = (fakeLog: string): Record<string, unknown>[] =>
  existsSync(fakeLog)
    ? readFileSync(fakeLog, "utf-8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line))
    : [];

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
    startups: () =>
      fakeEntries(fakeLog).flatMap(({ startup }) =>
        startup === undefined ? [] : [startup],
      ),
    log: () => readFileSync(path.join(dir, HOLDER_LOG_FILE), "utf-8"),
  };
};

type HolderProcess = Place & { exited: Promise<number> };

/** The holder as `main.ts`, the way the desktop starts it. */
const spawnHolder = async (
  at: Place = place(),
  environment: Readonly<Record<string, string>> = {},
): Promise<HolderProcess> => {
  const child = Bun.spawn(
    [process.execPath, MAIN, "--dir", at.dir, "--endpoint", at.endpoint],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: {
        PATH: process.env["PATH"] ?? "",
        FAKE_HARNESS_LOG: at.fakeLog,
        OPENAI_API_KEY: "inherited-key",
        ...environment,
      },
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
    `#!/bin/sh\nexec "${process.execPath}" "${FAKE_SERVER}" "${scenario}" "$@"\n`,
  );
  chmodSync(executable, 0o755);
  return executable;
};

/** The managed Claude Code CLI's place, the same way. */
const fakeClaude = (root: string, scenario: FakeScenarioName) => {
  const executable = path.join(root, `claude-${scenario}`);
  writeFileSync(
    executable,
    `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "${scenario}" "$@"\n`,
  );
  chmodSync(executable, 0o755);
  return executable;
};

const is =
  <K extends SidecarMessage["type"]>(type: K, runId?: string) =>
  (message: SidecarMessage): message is Extract<SidecarMessage, { type: K }> =>
    message.type === type &&
    (runId === undefined || ("runId" in message && message.runId === runId));

/** The `harness.process` report for a run or probe id. */
const processOf =
  (id: string) =>
  (
    message: SidecarMessage,
  ): message is Extract<SidecarMessage, { type: "harness.process" }> =>
    message.type === "harness.process" && message.id === id;

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

type RunLaunch = {
  harness: "codex" | "claude-code";
  executable: string;
  model: string;
};

const startRun = (
  client: Client,
  at: Place,
  launch: RunLaunch,
  overrides: object = {},
) => {
  const runId = crypto.randomUUID();
  const configDir = path.join(at.root, `${launch.harness}-home`);
  const workspaceDir = path.join(at.root, "workspace");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  client.send({
    type: "run.start",
    runId,
    threadId: "thread-1",
    attachments: [],
    skillFolders: [],
    toolPath: [],
    ...launch,
    configDir,
    launch: PLAIN_LAUNCH,
    workspaceDir,
    cacheDir: path.join(at.root, "agent-package-cache"),
    instructions: "Use the stella MCP server.",
    messages: [{ role: "user", content: "Find the lease decision." }],
    harnessSessionId: null,
    reasoningEffort: null,
    policy: { network: "open", fs: "workspace", approvals: "ask" },
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

const runStart = (
  client: Client,
  at: Place,
  scenario: FakeScenario,
  overrides: object = {},
) =>
  startRun(
    client,
    at,
    {
      harness: "codex",
      executable: fakeCodex(at.root, scenario),
      model: "gpt-test",
    },
    overrides,
  );

const claudeRunStart = (
  client: Client,
  at: Place,
  scenario: FakeScenarioName,
) =>
  startRun(client, at, {
    harness: "claude-code",
    executable: fakeClaude(at.root, scenario),
    model: "sonnet",
  });

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

  test("a newer desktop's hello makes a holder with no runs exit, after the rejection", async () => {
    const holder = await spawnHolder();
    const newer = await connect(holder.endpoint);
    newer.send({ ...helloMessage(holder), protocol: SIDECAR_PROTOCOL + 1 });
    expect(await newer.waitFor(is("rejected"))).toMatchObject({
      reason: "protocol_mismatch",
    });
    expect(await holder.exited).toBe(0);
  });

  test("a newer desktop's hello lets a holder finish its runs before it exits", async () => {
    const holder = await spawnHolder();
    const { client } = await desktop(holder);
    const runId = runStart(client, holder, "interrupt_queued");
    await client.waitFor(is("run.event", runId));
    const newer = await connect(holder.endpoint);
    newer.send({ ...helloMessage(holder), protocol: SIDECAR_PROTOCOL + 1 });
    await newer.waitFor(is("rejected"));
    // The run it holds still runs and reaches its desktop.
    client.send({ type: "run.cancel", runId });
    const finished = await client.waitFor(is("run.finished", runId));
    client.send({ type: "ack", runId, seq: finished.seq });
    expect(await holder.exited).toBe(0);
  });

  test("rejects unknown and invalid lines once authenticated", async () => {
    const holder = await spawnHolder();
    const { client } = await desktop(holder);
    client.send({ type: "run.pause", runId: crypto.randomUUID() });
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
      ["unknown_type", "run.pause"],
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
      launch: PLAIN_LAUNCH,
    });
    expect(await client.waitFor(is("harness.probed"))).toEqual({
      type: "harness.probed",
      requestId,
      harness: "codex",
      outcome: {
        type: "ready",
        version: "0.166.0",
        capabilities: [
          "approvals",
          "interrupt",
          "resume",
          "image_input",
          "steer",
        ],
        approvalModes: ["ask"],
        models: [
          {
            id: "gpt-test",
            label: "GPT Test",
            isDefault: true,
            reasoningEfforts: ["medium", "high"],
          },
        ],
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
      launch: PLAIN_LAUNCH,
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
      launch: PLAIN_LAUNCH,
    });
    const opencode = crypto.randomUUID();
    client.send({
      type: "harness.probe",
      requestId: opencode,
      harness: "opencode",
      executable: "/nonexistent/opencode",
      configDir,
      launch: PLAIN_LAUNCH,
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
      version: "0.166.0",
    });
    expect((await probed(opencode)).outcome).toMatchObject({
      type: "failed",
      reason: "unsupported",
    });
  });

  test("reports Claude Code's exhausted plan limit, and a missing CLI as unavailable", async () => {
    const holder = await spawnHolder();
    const { client } = await desktop(holder);
    const configDir = path.join(holder.root, "claude-code-home");
    mkdirSync(configDir);
    const limited = crypto.randomUUID();
    client.send({
      type: "harness.probe",
      requestId: limited,
      harness: "claude-code",
      executable: fakeClaude(holder.root, "probe"),
      configDir,
      launch: PLAIN_LAUNCH,
    });
    const missing = crypto.randomUUID();
    client.send({
      type: "harness.probe",
      requestId: missing,
      harness: "claude-code",
      executable: "/nonexistent/claude",
      configDir,
      launch: PLAIN_LAUNCH,
    });
    const probed = async (requestId: string) =>
      client.waitFor(
        (
          message,
        ): message is Extract<SidecarMessage, { type: "harness.probed" }> =>
          message.type === "harness.probed" && message.requestId === requestId,
      );
    expect((await probed(limited)).outcome).toEqual({
      type: "limit_until",
      version: FAKE_CLAUDE_VERSION,
      resetsAt: "2099-10-28T14:00:00Z",
    });
    expect((await probed(missing)).outcome).toMatchObject({
      type: "failed",
      reason: "harness_unavailable",
    });
  });

  test("runs Claude Code on the loopback proxy and a run secret, never the run token", async () => {
    const holder = await spawnHolder();
    const { client } = await desktop(holder);
    const runId = claudeRunStart(client, holder, "stella_tools");
    const finished = await client.waitFor(is("run.finished", runId));
    expect(finished).toMatchObject({ outcome: "completed" });
    expect(finished.harnessSessionId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(chunksOf(client, runId)).toContainEqual(
      expect.objectContaining({
        type: "TOOL_CALL_START",
        toolCallName: "search_case_law",
      }),
    );
    const registered = holder
      .received()
      .find(({ request }) => request?.subtype === "mcp_set_servers");
    const server = v.parse(
      v.object({
        stella: v.object({
          url: v.string(),
          headers: v.object({ Authorization: v.string() }),
        }),
      }),
      registered?.request?.servers,
    ).stella;
    expect(server.url).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:\\d+/mcp/${runId}$`, "u"),
    );
    expect(server.headers.Authorization).toMatch(/^Bearer \S{43,}$/u);
    expect(JSON.stringify(holder.received())).not.toContain(RUN_TOKEN);
  });

  test("hands each harness the turn's attached image from its copy; a PDF reaches Claude only", async () => {
    // A real 1x1 PNG and a one-page PDF, already copied by an earlier turn,
    // so nothing is fetched: the link below is never read.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
      "latin1",
    );
    const image = "attachments/019a0000-0000-7000-8000-0000000000a1/plan.png";
    const document =
      "attachments/019a0000-0000-7000-8000-0000000000a2/smlouva.pdf";
    const earlier =
      "attachments/019a0000-0000-7000-8000-0000000000a3/earlier.png";
    const holder = await spawnHolder();
    const workspaceDir = path.join(holder.root, "workspace");
    for (const [at, bytes] of [
      [image, png],
      [document, pdf],
      [earlier, png],
    ] as const) {
      mkdirSync(path.join(workspaceDir, path.dirname(at)), {
        recursive: true,
      });
      writeFileSync(path.join(workspaceDir, at), bytes);
    }
    const turn = {
      attachments: [image, document, earlier].map((at) => ({
        path: at,
        url: "https://files.example.test/never-read",
      })),
      messages: [
        { role: "user", content: `Earlier: ${earlier}` },
        { role: "assistant", content: "Seen." },
        {
          role: "user",
          content: [
            { type: "text", content: "Compare the plan with the contract." },
            { type: "text", content: `The plan is at ${image}.` },
            { type: "text", content: `The contract is at ${document}.` },
          ],
        },
      ],
    };
    const { client } = await desktop(holder);
    const claudeRun = startRun(
      client,
      holder,
      {
        harness: "claude-code",
        executable: fakeClaude(holder.root, "stella_tools"),
        model: "sonnet",
      },
      turn,
    );
    expect(await client.waitFor(is("run.finished", claudeRun))).toMatchObject({
      outcome: "completed",
    });
    const codexRun = runStart(client, holder, "stella_tools", turn);
    expect(await client.waitFor(is("run.finished", codexRun))).toMatchObject({
      outcome: "completed",
    });

    const userMessage = holder.received().find(({ type }) => type === "user");
    expect(userMessage).toMatchObject({
      message: {
        content: [
          {
            type: "image",
            source: { media_type: "image/png", data: png.toString("base64") },
          },
          {
            type: "document",
            source: {
              media_type: "application/pdf",
              data: pdf.toString("base64"),
            },
          },
          {
            type: "text",
            text: expect.stringContaining(`The contract is at ${document}.`),
          },
        ],
      },
    });
    const turnStart = holder
      .received()
      .find(({ method }) => method === "turn/start");
    expect(turnStart?.params).toMatchObject({
      input: [
        {
          type: "image",
          url: `data:image/png;base64,${png.toString("base64")}`,
        },
        {
          type: "text",
          text: expect.stringContaining(`The contract is at ${document}.`),
        },
      ],
    });
    expect(holder.log()).toContain(
      "an attached file stays a path only: not_accepted",
    );
  });

  test("a Claude Code run finishes as interrupted or cancelled", async () => {
    for (const [type, outcome] of [
      ["run.interrupt", "interrupted"],
      ["run.cancel", "cancelled"],
    ] as const) {
      const holder = await spawnHolder();
      const { client } = await desktop(holder);
      const runId = claudeRunStart(client, holder, "interrupt");
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
      expect(
        holder
          .received()
          .filter(({ request }) => request?.subtype === "interrupt"),
      ).toHaveLength(1);
    }
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

  test("with the protocol log on, the holder log has each message's structure and none of its content", async () => {
    const holder = await spawnHolder(place(), {
      STELLA_AGENT_PROTOCOL_LOG: "redacted",
    });
    const { client } = await desktop(holder);
    const codexRun = runStart(client, holder, "stella_tools");
    await client.waitFor(is("run.finished", codexRun));
    const claudeRun = claudeRunStart(client, holder, "stella_tools");
    await client.waitFor(is("run.finished", claudeRun));
    const secret = holder.secret();
    client.send({ type: "shutdown" });
    expect(await holder.exited).toBe(0);
    const log = holder.log();
    expect(log).toContain("the protocol log is on");
    for (const line of [
      /protocol sidecar connection=1 in type=run\.start runId=#[0-9a-f]{8} /u,
      /protocol sidecar connection=1 out type=run\.finished /u,
      /protocol codex pid=\d+ out method=turn\/start id=\d+ /u,
      /protocol codex pid=\d+ in method=turn\/completed /u,
      /protocol claude-code pid=\d+ out type=user /u,
      /protocol claude-code pid=\d+ in type=result /u,
    ]) {
      expect(log).toMatch(line);
    }
    // What the member and the model wrote, and where the run's files are.
    const written = [codexRun, claudeRun]
      .flatMap((runId) => chunksOf(client, runId))
      .flatMap((chunk) =>
        ["delta", "content", "args", "result"].flatMap((key) => {
          const value: unknown = chunk[key];
          return typeof value === "string" && value.length >= 6 ? [value] : [];
        }),
      );
    expect(written.length).toBeGreaterThan(0);
    for (const content of [
      "Find the lease decision.",
      "Use the stella MCP server.",
      RUN_TOKEN,
      secret,
      holder.root,
      ...written,
    ]) {
      expect(log).not.toContain(content);
    }
  });

  test("hands the harness the run's approval mode and the computer's package cache", async () => {
    const holder = await spawnHolder();
    const { client } = await desktop(holder);
    const runId = runStart(client, holder, "stella_tools");
    await client.waitFor(is("run.finished", runId));
    const threadStart = v.parse(
      v.looseObject({
        approvalPolicy: v.string(),
        sandbox: v.string(),
        config: v.record(v.string(), v.unknown()),
      }),
      holder.received().find(({ method }) => method === "thread/start")?.params,
    );
    expect(threadStart).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    expect(
      threadStart.config["sandbox_workspace_write.writable_roots"],
    ).toEqual([path.join(holder.root, "agent-package-cache")]);
    const claudeRunId = startRun(
      client,
      holder,
      {
        harness: "claude-code",
        executable: fakeClaude(holder.root, "stella_tools"),
        model: "sonnet",
      },
      { policy: { network: "open", fs: "workspace", approvals: "auto" } },
    );
    await client.waitFor(is("run.finished", claudeRunId));
    expect(JSON.stringify(holder.startups())).toContain(
      '"--permission-mode","auto"',
    );
  });

  test("hands the harness the run's reasoning effort", async () => {
    const holder = await spawnHolder();
    const { client } = await desktop(holder);
    const runId = startRun(
      client,
      holder,
      {
        harness: "claude-code",
        executable: fakeClaude(holder.root, "stella_tools"),
        model: "sonnet",
      },
      { reasoningEffort: "high" },
    );
    await client.waitFor(is("run.finished", runId));
    expect(JSON.stringify(holder.startups())).toContain('"--effort","high"');
  });

  test("relays an approval with one request id and returns the decision", async () => {
    const holder = await spawnHolder();
    const { client } = await desktop(holder);
    const runId = runStart(client, holder, "approval");
    const request = await client.waitFor(is("run.approval_request", runId));
    // A command approval names the command; the harness's reason rides along.
    expect(request).toMatchObject({
      kind: "command",
      summary: "rm draft.md",
    });
    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    const pause = chunksOf(client, runId).at(-1);
    expect(pause).toMatchObject({
      type: "RUN_FINISHED",
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: request.requestId,
            message: "rm draft.md",
            metadata: { reason: "Deletes a file" },
          },
        ],
      },
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

  test("a command approval without a reason still names what it would run", async () => {
    const holder = await spawnHolder();
    const { client } = await desktop(holder);
    const runId = runStart(client, holder, "approval_without_reason");
    const request = await client.waitFor(is("run.approval_request", runId));
    expect(request.summary).toBe("rm draft.md");
    client.send({
      type: "run.approval",
      runId,
      requestId: request.requestId,
      decision: "deny",
    });
    expect(await client.waitFor(is("run.finished", runId))).toMatchObject({
      outcome: "completed",
    });
  });

  test("answers a blocking question under the request id its pause carries", async () => {
    const holder = await spawnHolder();
    const { client } = await desktop(holder);
    const runId = runStart(client, holder, "blocking_question");
    const pause = await client.waitFor(
      (message): message is Extract<SidecarMessage, { type: "run.event" }> =>
        message.type === "run.event" &&
        message.runId === runId &&
        message.chunk.type === "RUN_FINISHED",
    );
    const outcome = v.parse(
      v.object({
        type: v.literal("interrupt"),
        interrupts: v.tuple([
          v.object({ id: v.string(), toolCallId: v.string() }),
        ]),
      }),
      pause.chunk["outcome"],
    );
    const [{ id: requestId, toolCallId }] = outcome.interrupts;
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(toolCallId).toBe("ask-1");
    // A response to a request the run does not hold changes nothing.
    client.send({
      type: "run.answer",
      runId,
      requestId: crypto.randomUUID(),
      answers: { law: ["Slovak"] },
    });
    client.send({
      type: "run.answer",
      runId,
      requestId,
      answers: { law: ["Czech"] },
    });
    expect(await client.waitFor(is("run.finished", runId))).toMatchObject({
      outcome: "completed",
    });
    const replies = holder
      .received()
      .filter(
        (message) =>
          message.method === undefined && message.result !== undefined,
      )
      .map(({ result }) => result);
    expect(replies).toEqual([{ answers: { law: { answers: ["Czech"] } } }]);
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

  test("hands a run.input to the running turn and reports on the run's stream that the harness took it", async () => {
    const holder = await spawnHolder();
    const { client } = await desktop(holder);
    const runId = runStart(client, holder, "steered");
    await client.waitFor(
      (message): message is SidecarMessage =>
        message.type === "run.event" &&
        message.runId === runId &&
        message.chunk.type === "TOOL_CALL_START",
    );
    const inputId = crypto.randomUUID();
    client.send({
      type: "run.input",
      runId,
      inputId,
      message: { role: "user", content: "Also check the annex." },
    });
    expect(await client.waitFor(is("run.finished", runId))).toMatchObject({
      outcome: "completed",
    });
    const reports = chunksOf(client, runId).filter(
      (chunk) =>
        chunk.type === "CUSTOM" && chunk["name"] === DESKTOP_RUNNER_INPUT_EVENT,
    );
    expect(reports.map((chunk) => chunk["value"])).toEqual([
      { inputId, status: "accepted" },
    ]);
    // The harness was handed the text as the running turn's input.
    expect(
      holder.received().find(({ method }) => method === "turn/steer")?.params,
    ).toMatchObject({
      input: [{ type: "text", text: "Also check the annex." }],
    });
  });

  test("starts Codex with the launch's overrides and environment, and only asks it anything once the desktop granted its process", async () => {
    const holder = await spawnHolder();
    const { client } = await desktop(holder);
    const override = 'model_provider="openai_chatgpt_plan"';
    const runId = runStart(client, holder, "stella_tools", {
      launch: {
        configOverrides: [override],
        environment: { STELLA_CODEX_TOKEN_BROKER: "/tmp/broker/s" },
        removedEnvironment: ["OPENAI_API_KEY"],
        clientName: "Stella",
        processGrant: true,
      },
    });
    const reported = await client.waitFor(processOf(runId));
    // real-time: give an ungated harness the time to be asked something.
    await Bun.sleep(300);
    expect(holder.received()).toEqual([]);
    expect(runMessages(client, runId)).toEqual([]);
    client.send({ type: "harness.process_granted", id: runId });
    expect(await client.waitFor(is("run.finished", runId))).toMatchObject({
      outcome: "completed",
    });
    expect(holder.startups()).toEqual([
      expect.objectContaining({
        pid: reported.pid,
        args: ["app-server", "-c", override],
        launchEnvironment: { STELLA_CODEX_TOKEN_BROKER: "/tmp/broker/s" },
      }),
    ]);
    expect(
      holder.received().find(({ method }) => method === "initialize")?.params,
    ).toMatchObject({ clientInfo: { name: "Stella" } });
    // A run without a grant in its launch reports no process.
    const plain = runStart(client, holder, "stella_tools");
    await client.waitFor(is("run.finished", plain));
    expect(client.messages.filter(processOf(plain))).toEqual([]);
    expect(holder.startups().at(-1)).toMatchObject({
      args: ["app-server"],
      launchEnvironment: { OPENAI_API_KEY: "inherited-key" },
    });
  });

  test("a desktop that reconnects is told a granted run's harness process again, and a finished run's never", async () => {
    const holder = await spawnHolder();
    const first = await desktop(holder);
    const runId = runStart(first.client, holder, "interrupt_queued", {
      launch: { ...PLAIN_LAUNCH, processGrant: true },
    });
    const reported = await first.client.waitFor(processOf(runId));
    first.client.send({ type: "harness.process_granted", id: runId });
    await first.client.waitFor(
      (message): message is SidecarMessage =>
        message.type === "run.event" &&
        message.runId === runId &&
        message.chunk.type === "TOOL_CALL_START",
    );
    first.client.close();
    await first.client.ended;
    const held = Math.max(...seqs(first.client, runId));
    const second = await desktop(holder, [{ runId, afterSeq: held }]);
    expect(await second.client.waitFor(processOf(runId))).toEqual(reported);
    // A repeated grant changes nothing.
    second.client.send({ type: "harness.process_granted", id: runId });
    second.client.send({ type: "run.cancel", runId });
    const finished = await second.client.waitFor(is("run.finished", runId));
    expect(finished.outcome).toBe("cancelled");
    const third = await desktop(holder, [{ runId, afterSeq: held }]);
    await third.client.waitFor(is("run.finished", runId));
    expect(third.client.messages.filter(processOf(runId))).toEqual([]);
  });

  test("Claude Code refuses launch settings it cannot apply", async () => {
    const holder = await spawnHolder();
    const { client } = await desktop(holder);
    const runId = startRun(
      client,
      holder,
      {
        harness: "claude-code",
        executable: fakeClaude(holder.root, "stella_tools"),
        model: "sonnet",
      },
      { launch: { ...PLAIN_LAUNCH, processGrant: true } },
    );
    expect(await client.waitFor(is("run.finished", runId))).toMatchObject({
      outcome: "failed",
    });
    expect(holder.received()).toEqual([]);
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

  test("fails a run whose transcript holds a message it cannot read, without starting the harness", async () => {
    const holder = await spawnHolder();
    const { client } = await desktop(holder);
    const runId = runStart(client, holder, "tool_calls", {
      messages: [{ role: "user", content: [{ type: "text", content: 42 }] }],
    });
    expect(await client.waitFor(is("run.finished", runId))).toMatchObject({
      outcome: "failed",
    });
    expect(holder.received().map(({ method }) => method)).not.toContain(
      "turn/start",
    );
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

  test("a run whose message cannot be written stops, writes nothing more, and finishes failed", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "stella-sidecar-host-"));
    const configDir = path.join(root, "codex-home");
    const workspaceDir = path.join(root, "workspace");
    mkdirSync(configDir);
    mkdirSync(workspaceDir);
    const written: SidecarHostOutput[] = [];
    const { promise: finished, resolve } =
      Promise.withResolvers<
        Extract<SidecarHostOutput, { type: "run.finished" }>
      >();
    // The first tool call's chunk stands in for one over the line limit.
    const refused = (message: SidecarHostOutput) =>
      message.type === "run.event" && message.chunk.type === "TOOL_CALL_START";
    const refusedAt: number[] = [];
    const host = new SidecarHost({
      send: (message) => {
        if (refused(message)) {
          refusedAt.push(written.length);
          return false;
        }
        written.push(message);
        if (message.type === "run.finished") {
          resolve(message);
        }
        return true;
      },
      log: () => {},
      protocolLog: PROTOCOL_LOG_OFF,
      environment: {
        PATH: process.env["PATH"] ?? "",
        FAKE_HARNESS_LOG: path.join(root, "fake.log"),
      },
      processGrantTimeoutMs: WAIT_MS,
    });
    cleanups.push(() => {
      rmSync(root, { recursive: true, force: true });
    });
    host.configure("1.4.0", API_ORIGIN);
    const runId = crypto.randomUUID();
    host.handle({
      type: "run.start",
      runId,
      threadId: "thread-1",
      harness: "codex",
      executable: fakeCodex(root, "interrupt_queued"),
      configDir,
      launch: PLAIN_LAUNCH,
      workspaceDir,
      cacheDir: path.join(root, "agent-package-cache"),
      model: "gpt-test",
      reasoningEffort: null,
      instructions: "Use the stella MCP server.",
      messages: [{ role: "user", content: "Find the lease decision." }],
      attachments: [],
      skillFolders: [],
      toolPath: [],
      harnessSessionId: null,
      policy: { network: "open", fs: "workspace", approvals: "ask" },
      mcp: {
        serverName: "stella",
        url: `${API_ORIGIN}/mcp`,
        token: RUN_TOKEN,
        expiresAt: "2026-10-28T12:00:00.000Z",
      },
    });
    expect(await finished).toEqual({
      type: "run.finished",
      runId,
      outcome: "failed",
      harnessSessionId: FAKE_THREAD_ID,
    });
    // One refusal, and nothing of the run after it but its end.
    expect(refusedAt).toHaveLength(1);
    expect(written.slice(refusedAt[0])).toEqual([await finished]);
    await host.shutdown();
  });

  describe("files a turn writes to its outputs folder", () => {
    /**
     * A real host and fake harness against a real listener standing in for the
     * API. The turn pauses on an approval: what is planted during the pause
     * was written by the turn, as far as the folder can tell.
     */
    const runWritingOutputs = async (
      answer: (request: Request) => Promise<Response>,
    ) => {
      const root = mkdtempSync(path.join(tmpdir(), "stella-sidecar-outputs-"));
      const configDir = path.join(root, "codex-home");
      const workspaceDir = path.join(root, "workspace");
      const outputs = path.join(workspaceDir, "outputs");
      mkdirSync(configDir);
      mkdirSync(outputs, { recursive: true });
      writeFileSync(path.join(outputs, "earlier.txt"), "an earlier turn");
      const api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: answer });
      const apiOrigin = `http://127.0.0.1:${String(api.port)}`;
      const written: SidecarHostOutput[] = [];
      const { promise: finished, resolve } =
        Promise.withResolvers<
          Extract<SidecarHostOutput, { type: "run.finished" }>
        >();
      const { promise: paused, resolve: pause } =
        Promise.withResolvers<string>();
      const host = new SidecarHost({
        send: (message) => {
          written.push(message);
          if (message.type === "run.approval_request") {
            pause(message.requestId);
          }
          if (message.type === "run.finished") {
            resolve(message);
          }
          return true;
        },
        log: () => {},
        protocolLog: PROTOCOL_LOG_OFF,
        environment: {
          PATH: process.env["PATH"] ?? "",
          FAKE_HARNESS_LOG: path.join(root, "fake.log"),
        },
        processGrantTimeoutMs: WAIT_MS,
      });
      cleanups.push(async () => {
        await host.shutdown();
        await api.stop(true);
        rmSync(root, { recursive: true, force: true });
      });
      host.configure("1.4.0", apiOrigin);
      const runId = crypto.randomUUID();
      host.handle({
        type: "run.start",
        runId,
        threadId: "thread-1",
        harness: "codex",
        executable: fakeCodex(root, "approval"),
        configDir,
        launch: PLAIN_LAUNCH,
        workspaceDir,
        cacheDir: path.join(root, "agent-package-cache"),
        model: "gpt-test",
        reasoningEffort: null,
        instructions: "Use the stella MCP server.",
        messages: [{ role: "user", content: "Write the report." }],
        attachments: [],
        skillFolders: [],
        toolPath: [],
        harnessSessionId: null,
        policy: { network: "open", fs: "workspace", approvals: "ask" },
        mcp: {
          serverName: "stella",
          url: `${apiOrigin}/mcp`,
          token: RUN_TOKEN,
          expiresAt: "2026-10-28T12:00:00.000Z",
        },
      });
      const requestId = await paused;
      writeFileSync(path.join(outputs, "report.txt"), "written this turn");
      host.handle({
        type: "run.approval",
        runId,
        requestId,
        decision: "deny",
      });
      return { finished: await finished, runId, written };
    };

    const chunksOfRun = (written: readonly SidecarHostOutput[]) =>
      written.flatMap((message) =>
        message.type === "run.event" ? [message.chunk] : [],
      );

    test("upload what the turn wrote, with the run's token, before the turn's finish", async () => {
      const received: { body: string; authorization: string | null }[] = [];
      const fileId = crypto.randomUUID();
      const { finished, written } = await runWritingOutputs(async (request) => {
        received.push({
          body: await request.text(),
          authorization: request.headers.get("authorization"),
        });
        return Response.json({ fileId });
      });
      // The file that was there when the run started stays out of it.
      expect(received).toEqual([
        {
          body: expect.stringContaining('filename="report.txt"'),
          authorization: `Bearer ${RUN_TOKEN}`,
        },
      ]);
      expect(finished.outcome).toBe("completed");
      const chunks = chunksOfRun(written);
      const reportAt = chunks.findIndex(
        (chunk) => chunk["name"] === "stella.run-output",
      );
      expect(chunks[reportAt]?.["value"]).toEqual({
        status: "uploaded",
        fileId,
        fileName: "report.txt",
      });
      const lastFinish = chunks.findLastIndex(
        (chunk) => chunk.type === "RUN_FINISHED",
      );
      expect(reportAt).toBeGreaterThanOrEqual(0);
      expect(reportAt).toBeLessThan(lastFinish);
    });

    test("an API that refuses the file leaves the run completed and says so", async () => {
      const { finished, written } = await runWritingOutputs(
        async () => await Promise.resolve(new Response(null, { status: 500 })),
      );
      expect(finished.outcome).toBe("completed");
      const reports = chunksOfRun(written).filter(
        (chunk) => chunk["name"] === "stella.run-output",
      );
      expect(reports.map((chunk) => chunk["value"])).toEqual([
        { status: "failed", fileName: "report.txt" },
      ]);
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
    expect(existsSync(path.join(holder.dir, HOLDER_ENDPOINT_FILE))).toBe(false);
  });

  test("records the endpoint it listens on next to its secret", async () => {
    const holder = await spawnHolder();
    const file = path.join(holder.dir, HOLDER_ENDPOINT_FILE);
    expect(readFileSync(file, "utf-8")).toBe(holder.endpoint);
    expect(statSync(file).mode % 0o1000).toBe(0o600);
    expect(
      statSync(path.join(holder.dir, HOLDER_SECRET_FILE)).mode % 0o1000,
    ).toBe(0o600);
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
      processGrantTimeoutMs: number;
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
        FAKE_HARNESS_LOG: at.fakeLog,
      },
      idleExitMs: 60_000,
      helloTimeoutMs: 5000,
      unackedRetentionMs: 60_000,
      processGrantTimeoutMs: 60_000,
      limits: { maxMessages: 1000, maxBytes: 1024 * 1024 },
      protocolLog: { type: "set", setting: "off" },
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

  test("a harness process the desktop never authorizes is ended unused, and its run or probe fails", async () => {
    const { at } = await startInProcess({ processGrantTimeoutMs: 200 });
    const { client } = await desktop(at);
    const launch = { ...PLAIN_LAUNCH, processGrant: true };
    const runId = runStart(client, at, "stella_tools", { launch });
    const configDir = path.join(at.root, "codex-home");
    const requestId = crypto.randomUUID();
    client.send({
      type: "harness.probe",
      requestId,
      harness: "codex",
      executable: fakeCodex(at.root, "probe"),
      configDir,
      launch,
    });
    await client.waitFor(processOf(runId));
    await client.waitFor(processOf(requestId));
    expect(await client.waitFor(is("run.finished", runId))).toMatchObject({
      outcome: "failed",
    });
    const probed = await client.waitFor(
      (
        message,
      ): message is Extract<SidecarMessage, { type: "harness.probed" }> =>
        message.type === "harness.probed" && message.requestId === requestId,
    );
    expect(probed.outcome).toMatchObject({
      type: "failed",
      reason: "harness_unavailable",
    });
    // Neither process was asked anything.
    expect(at.received()).toEqual([]);
  });
});
