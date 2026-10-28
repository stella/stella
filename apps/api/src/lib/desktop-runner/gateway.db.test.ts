import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import * as v from "valibot";

import {
  DESKTOP_RUNNER_MAX_FRAME_BYTES,
  DESKTOP_RUNNER_PROTOCOL,
  type DesktopRunnerServerMessage,
  desktopRunnerServerMessageSchema,
} from "@stll/api-contract/desktop-runner";

import { desktopRunnerEvents, desktopRunnerRuns } from "@/api/db/schema";
import type { HttpServer } from "@/api/http/context";
import { apiWebSocketHandler } from "@/api/http/websocket";
import {
  createDesktopRunnerControl,
  type DesktopRunnerControl,
} from "@/api/lib/desktop-runner/control";
import {
  createLocalDoorbell,
  type DesktopRunnerDoorbell,
} from "@/api/lib/desktop-runner/doorbell";
import {
  authorizeRunnerWith,
  createDesktopRunnerGateway,
  type DesktopRunnerGateway,
} from "@/api/lib/desktop-runner/gateway";
import {
  DESKTOP_RUNNER_CLOSE,
  DESKTOP_RUNNER_DESKTOP_ID_HEADER,
  DESKTOP_RUNNER_ROUTE_PREFIX,
  type DesktopRunnerTiming,
} from "@/api/lib/desktop-runner/protocol";
import type { MintRunToken } from "@/api/lib/desktop-runner/session";
import type { DesktopRunnerDb } from "@/api/lib/desktop-runner/store";
import { createDesktopDeviceSigner } from "@/api/tests/helpers/desktop-device-proof";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createRlsDesktopCredentials } from "@/api/tests/security/rls-desktop-credentials";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

const ids = createTestIds();
const owner = { userId: ids.userA1, organizationId: ids.orgA };
const HARNESS_VERSION = "0.50.0";
const MODEL = "gpt-5-codex";
const DAY_MS = 86_400_000;
const TIMING = {
  // Timers the tests drive explicitly stay out of the way.
  pingIntervalMs: DAY_MS,
  maxSocketLifeMs: DAY_MS,
  helloTimeoutMs: DAY_MS,
  sweepIntervalMs: DAY_MS,
  leaseMs: 60_000,
  runnerFreshnessMs: 120_000,
  drainSpreadMs: 1000,
  tokenRefreshMarginMs: 60_000,
} as const satisfies DesktopRunnerTiming;

const clock = { now: Date.now() };
const now = () => new Date(clock.now);

let db: TestDatabase;
let credentials: Awaited<ReturnType<typeof createRlsDesktopCredentials>>;
let mintedTokens = 0;
const mintRunToken: MintRunToken = async () => {
  mintedTokens += 1;
  return await Promise.resolve({
    token: `run-token-${String(mintedTokens)}`,
    expiresAt: new Date(clock.now + 15 * 60_000),
  });
};

/** A transaction held open after its work, before it commits. */
type HeldCommit = {
  reached: PromiseWithResolvers<undefined>;
  release: PromiseWithResolvers<undefined>;
};
const commitGate: { next: HeldCommit | null } = { next: null };

let gatewayDb: DesktopRunnerDb;
const sharedDoorbell = createLocalDoorbell();

type Instance = {
  gateway: DesktopRunnerGateway;
  server: HttpServer;
  url: string;
};
const instances: Instance[] = [];

const startInstance = async (
  instanceId: string,
  doorbell: DesktopRunnerDoorbell,
): Promise<Instance> => {
  const gateway = createDesktopRunnerGateway({
    db: gatewayDb,
    doorbell,
    instanceId,
    authorize: authorizeRunnerWith(credentials.authorizeDesktopAccount),
    mintRunToken,
    now,
    random: () => 0.5,
    timing: TIMING,
  });
  await gateway.start();
  const server = Bun.serve({
    port: 0,
    fetch: async (request, bunServer) =>
      (await gateway.upgrade(request, bunServer)) ?? undefined,
    websocket: apiWebSocketHandler,
  });
  const instance = {
    gateway,
    server,
    url: `http://127.0.0.1:${String(server.port)}${DESKTOP_RUNNER_ROUTE_PREFIX}`,
  };
  instances.push(instance);
  return instance;
};

let first: Instance;
let second: Instance;
let control: DesktopRunnerControl;

// timeout: PGlite builds the full schema before the first test
beforeAll(async () => {
  db = await getTestDb();
  await setupRlsTestData(db, ids);
  credentials = await createRlsDesktopCredentials(db, ids);
  // SAFETY: PGlite and Bun SQL expose the same Drizzle query and transaction
  // APIs the gateway uses; the transaction is wrapped to hold a commit open.
  gatewayDb = asTestRaw<DesktopRunnerDb>({
    select: db.select.bind(db),
    insert: db.insert.bind(db),
    update: db.update.bind(db),
    transaction: async (run: (tx: unknown) => Promise<unknown>) =>
      await db.transaction(async (tx) => {
        const value = await run(tx);
        const held = commitGate.next;
        if (held !== null) {
          commitGate.next = null;
          held.reached.resolve(undefined);
          await held.release.promise;
        }
        return value;
      }),
  });
  first = await startInstance("api-first", sharedDoorbell);
  second = await startInstance("api-second", sharedDoorbell);
  control = createDesktopRunnerControl({
    db: gatewayDb,
    doorbell: sharedDoorbell,
    now,
    timing: TIMING,
  });
}, 120_000);

afterAll(async () => {
  for (const instance of instances) {
    await instance.gateway.drain();
    await instance.server.stop(true);
  }
  await releaseTestDb();
});

type Closed = { code: number; reason: string };
type Signer = { signRequest: (request: Request) => Promise<Request> };

/** A desktop runner as the API sees it: one socket, a recorded inbox. */
type FakeDesktop = {
  received: DesktopRunnerServerMessage[];
  closed: Promise<Closed>;
  send: (message: unknown) => void;
  sendText: (text: string) => void;
  /** The first message of `type` not yet taken that `matches`, now or when it arrives. */
  receive: <TType extends DesktopRunnerServerMessage["type"]>(
    type: TType,
    matches?: (message: DesktopRunnerServerMessage) => boolean,
  ) => Promise<Extract<DesktopRunnerServerMessage, { type: TType }>>;
  hello: (
    activeRuns?: { runId: string; lastSeq: number }[],
    protocol?: number,
  ) => Promise<void>;
  close: () => Promise<Closed>;
};

const upgradeRequest = async (
  instance: Instance,
  desktopId: string,
  signer: Signer = credentials.a,
) =>
  await signer.signRequest(
    new Request(instance.url, {
      headers: {
        upgrade: "websocket",
        [DESKTOP_RUNNER_DESKTOP_ID_HEADER]: desktopId,
      },
    }),
  );

const openDesktop = async (
  instance: Instance,
  desktopId: string,
  signed?: Request,
): Promise<FakeDesktop> => {
  const request = signed ?? (await upgradeRequest(instance, desktopId));
  const socket = new WebSocket(instance.url.replace("http", "ws"), {
    headers: {
      authorization: request.headers.get("authorization") ?? "",
      dpop: request.headers.get("dpop") ?? "",
      [DESKTOP_RUNNER_DESKTOP_ID_HEADER]: desktopId,
    },
  });
  const received: DesktopRunnerServerMessage[] = [];
  const consumed = new Set<DesktopRunnerServerMessage>();
  const waiters = new Set<(message: DesktopRunnerServerMessage) => boolean>();
  const opened = Promise.withResolvers<undefined>();
  const closed = Promise.withResolvers<Closed>();
  socket.addEventListener("open", () => opened.resolve(undefined));
  socket.addEventListener("close", ({ code, reason }) => {
    opened.reject(new Error(`closed before open: ${String(code)}`));
    closed.resolve({ code, reason });
  });
  socket.addEventListener("message", ({ data }) => {
    const message = v.parse(
      desktopRunnerServerMessageSchema,
      JSON.parse(String(data)),
    );
    received.push(message);
    for (const waiter of waiters) {
      if (waiter(message)) {
        waiters.delete(waiter);
        return;
      }
    }
  });
  await opened.promise;
  const send = (message: unknown) => socket.send(JSON.stringify(message));
  const receive: FakeDesktop["receive"] = async (
    type,
    matches = () => true,
  ) => {
    const accepts = (
      message: DesktopRunnerServerMessage,
    ): message is Extract<DesktopRunnerServerMessage, { type: typeof type }> =>
      message.type === type && !consumed.has(message) && matches(message);
    const already = received.find(accepts);
    if (already !== undefined) {
      consumed.add(already);
      return already;
    }
    const arrived =
      Promise.withResolvers<
        Extract<DesktopRunnerServerMessage, { type: typeof type }>
      >();
    waiters.add((message) => {
      if (!accepts(message)) {
        return false;
      }
      consumed.add(message);
      arrived.resolve(message);
      return true;
    });
    // Neither side rejects, so the losing side settles unobserved harmlessly.
    const settled = await Promise.race([
      arrived.promise.then((message) => ({
        type: "message" as const,
        message,
      })),
      closed.promise.then(({ code }) => ({ type: "closed" as const, code })),
    ]);
    return settled.type === "message"
      ? settled.message
      : panic(
          `socket closed with ${String(settled.code)} while waiting for ${type}`,
        );
  };
  return {
    received,
    closed: closed.promise,
    send,
    sendText: (text) => socket.send(text),
    receive,
    hello: async (
      activeRuns = [],
      protocol = DESKTOP_RUNNER_PROTOCOL.current,
    ) => {
      // Each hello is the most recently seen runner, so routing picks it.
      clock.now += 1000;
      send({
        type: "hello",
        protocol,
        appVersion: "1.4.0",
        sidecarVersion: "1.4.0",
        harnesses: [
          {
            id: "codex",
            state: "ready",
            version: HARNESS_VERSION,
            capabilities: ["approvals", "interrupt"],
            models: [{ id: MODEL, label: "GPT-5 Codex" }],
          },
          { id: "claude-code", state: "needs_login", version: "2.1.0" },
        ],
        activeRuns,
      });
      await receive("welcome");
    },
    close: async () => {
      socket.close(1000, "done");
      return await closed.promise;
    },
  };
};

const startInput = (desktopId: string, runId: string) => ({
  owner,
  runId,
  desktopId,
  harness: "codex" as const,
  harnessVersion: HARNESS_VERSION,
  model: MODEL,
  harnessSessionId: null,
  instructions: "Summarize the matter.",
  messages: [{ role: "user" as const, content: "Summarize the matter." }],
  mcp: { serverName: "stella", url: "https://api.example.test/mcp" },
  workspaceIds: [],
});

const textEvent = (runId: string, seq: number, delta: string) => ({
  type: "run.event",
  runId,
  seq,
  chunk: {
    type: "TEXT_MESSAGE_CONTENT",
    messageId: "message-1",
    delta,
    timestamp: seq,
  },
});

/** Matches a message about `runId`. */
const ofRun = (runId: string) => (message: DesktopRunnerServerMessage) => {
  switch (message.type) {
    case "welcome":
    case "upgrade_required":
    case "reconnect":
      return false;
    default:
      return message.runId === runId;
  }
};

/** A desktop holding a run it accepted. */
const acceptedRun = async (instance: Instance) => {
  const desktopId = Bun.randomUUIDv7();
  const runId = Bun.randomUUIDv7();
  const desktop = await openDesktop(instance, desktopId);
  await desktop.hello();
  expect(
    (await control.startRun(startInput(desktopId, runId))).unwrap(),
  ).toEqual({
    type: "assigned",
  });
  const start = await desktop.receive("run.start", ofRun(runId));
  desktop.send({ type: "run.accepted", runId });
  return { desktopId, runId, desktop, start };
};

const storedSeqs = async (runId: string) =>
  await db
    .select({
      seq: desktopRunnerEvents.seq,
      message: desktopRunnerEvents.message,
    })
    .from(desktopRunnerEvents)
    .where(eq(desktopRunnerEvents.runId, runId))
    .orderBy(asc(desktopRunnerEvents.seq));

const runState = async (runId: string) =>
  (await control.readRun({ owner, runId })).unwrap();

describe("upgrade authentication", () => {
  test("a token without a proof, another device's proof and a replayed proof are refused before upgrade", async () => {
    const desktopId = Bun.randomUUIDv7();
    const unsigned = new Request(first.url, {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${credentials.a.credential}`,
        [DESKTOP_RUNNER_DESKTOP_ID_HEADER]: desktopId,
      },
    });
    const withoutProof = await first.gateway.upgrade(unsigned, first.server);
    expect(withoutProof?.status).toBe(401);
    expect(await withoutProof?.json()).toMatchObject({
      code: "desktop_proof_invalid",
    });

    const otherDevice = await createDesktopDeviceSigner();
    const foreign = await otherDevice.signRequest({
      request: unsigned,
      credential: credentials.a.credential,
    });
    const wrongKey = await first.gateway.upgrade(foreign, first.server);
    expect(wrongKey?.status).toBe(401);
    expect(await wrongKey?.json()).toMatchObject({
      code: "desktop_device_mismatch",
    });

    const signed = await upgradeRequest(first, desktopId);
    const desktop = await openDesktop(first, desktopId, signed);
    await desktop.hello();
    const replayed = await first.gateway.upgrade(
      new Request(first.url, { headers: signed.headers }),
      first.server,
    );
    expect(replayed?.status).toBe(401);
    expect(await replayed?.json()).toMatchObject({
      code: "desktop_proof_replayed",
    });
    await desktop.close();
  });

  test("a request without an installation id is refused", async () => {
    const signed = await credentials.a.signRequest(
      new Request(first.url, { headers: { upgrade: "websocket" } }),
    );
    expect((await first.gateway.upgrade(signed, first.server))?.status).toBe(
      400,
    );
  });
});

describe("hello negotiation", () => {
  test("the accepted protocol range gets welcome, any other gets upgrade_required", async () => {
    const { minimum, current } = DESKTOP_RUNNER_PROTOCOL;
    // N-2 through N+1, clipped to what the protocol field can carry.
    const protocols = [current - 2, current - 1, current, current + 1].filter(
      (protocol) => protocol >= 0,
    );
    expect(protocols).toContain(minimum - 1);
    for (const protocol of protocols) {
      const desktop = await openDesktop(first, Bun.randomUUIDv7());
      if (protocol >= minimum && protocol <= current) {
        await desktop.hello([], protocol);
        await desktop.close();
        continue;
      }
      desktop.send({ type: "hello", protocol });
      expect(await desktop.receive("upgrade_required")).toEqual({
        type: "upgrade_required",
        minimumProtocol: minimum,
        currentProtocol: current,
      });
      expect((await desktop.closed).code).toBe(
        DESKTOP_RUNNER_CLOSE.upgradeRequired.code,
      );
    }
  });

  test("a message before hello closes the socket", async () => {
    const desktop = await openDesktop(first, Bun.randomUUIDv7());
    desktop.send({ type: "run.accepted", runId: Bun.randomUUIDv7() });
    expect(await desktop.closed).toEqual({
      code: 1008,
      reason: "hello_required",
    });
  });
});

describe("run messages", () => {
  test("ack follows the stored message, a duplicate is stored once and a gap closes the socket", async () => {
    const { runId, desktop } = await acceptedRun(first);
    desktop.send(textEvent(runId, 1, "Hello"));
    expect(await desktop.receive("ack")).toEqual({
      type: "ack",
      runId,
      seq: 1,
    });
    expect((await runState(runId))?.state).toBe("running");

    const held: HeldCommit = {
      reached: Promise.withResolvers<undefined>(),
      release: Promise.withResolvers<undefined>(),
    };
    commitGate.next = held;
    desktop.send(textEvent(runId, 2, " there"));
    await held.reached.promise;
    // The message is written but not committed: nothing acknowledges it yet.
    expect(desktop.received.filter(({ type }) => type === "ack")).toHaveLength(
      1,
    );
    held.release.resolve(undefined);
    expect(await desktop.receive("ack")).toEqual({
      type: "ack",
      runId,
      seq: 2,
    });

    desktop.send(textEvent(runId, 1, "Replaced"));
    expect(await desktop.receive("ack")).toEqual({
      type: "ack",
      runId,
      seq: 2,
    });
    const stored = await storedSeqs(runId);
    expect(stored.map(({ seq }) => seq)).toEqual([1, 2]);
    expect(stored.at(0)?.message).toMatchObject({ chunk: { delta: "Hello" } });

    desktop.send(textEvent(runId, 4, "skipped"));
    expect(await desktop.closed).toEqual({
      code: DESKTOP_RUNNER_CLOSE.sequenceGap.code,
      reason: DESKTOP_RUNNER_CLOSE.sequenceGap.reason,
    });
    expect((await storedSeqs(runId)).map(({ seq }) => seq)).toEqual([1, 2]);
  });

  test("a chunk that is not a valid AG-UI event is refused unstored", async () => {
    const { runId, desktop } = await acceptedRun(first);
    desktop.send({
      type: "run.event",
      runId,
      seq: 1,
      chunk: { type: "TEXT_MESSAGE_CONTENT" },
    });
    expect(await desktop.closed).toEqual({
      code: 1008,
      reason: "unfoldable_chunk",
    });
    expect(await storedSeqs(runId)).toEqual([]);
  });

  test("a frame over the limit closes the socket with 1009", async () => {
    const desktop = await openDesktop(first, Bun.randomUUIDv7());
    await desktop.hello();
    desktop.sendText("x".repeat(DESKTOP_RUNNER_MAX_FRAME_BYTES + 1));
    expect((await desktop.closed).code).toBe(
      DESKTOP_RUNNER_CLOSE.tooLarge.code,
    );
  });
});

describe("command delivery", () => {
  test("commands are replayed after a reconnect, once per key, without the start of a held run", async () => {
    const { desktopId, runId, desktop, start } = await acceptedRun(first);
    const requestId = Bun.randomUUIDv7();
    desktop.send({
      type: "run.approval_request",
      runId,
      seq: 1,
      requestId,
      kind: "command",
      summary: "Run the test suite",
    });
    await desktop.receive("ack");
    const inputId = Bun.randomUUIDv7();
    const input = {
      owner,
      runId,
      inputId,
      message: { role: "user" as const, content: "Also check the dates." },
    };
    expect((await control.sendInput(input)).unwrap()).toEqual({
      type: "queued",
    });
    expect((await control.sendInput(input)).unwrap()).toEqual({
      type: "duplicate",
    });
    expect(
      (
        await control.answerApproval({
          owner,
          runId,
          requestId: Bun.randomUUIDv7(),
          decision: "approve",
        })
      ).unwrap(),
    ).toEqual({ type: "approval_not_requested" });
    expect(
      (
        await control.answerApproval({
          owner,
          runId,
          requestId,
          decision: "approve",
        })
      ).unwrap(),
    ).toEqual({ type: "queued" });
    await desktop.receive("run.input");
    await desktop.receive("run.approval");
    expect(desktop.received.map(({ type }) => type)).toEqual([
      "welcome",
      "run.start",
      "ack",
      "run.input",
      "run.approval",
    ]);
    expect(start.mcp.token).toMatch(/^run-token-/u);
    await desktop.close();

    const reconnected = await openDesktop(second, desktopId);
    reconnected.send({
      type: "hello",
      protocol: DESKTOP_RUNNER_PROTOCOL.current,
      appVersion: "1.4.0",
      sidecarVersion: "1.4.0",
      harnesses: [],
      activeRuns: [{ runId, lastSeq: 1 }],
    });
    expect(await reconnected.receive("welcome")).toEqual({
      type: "welcome",
      protocol: DESKTOP_RUNNER_PROTOCOL.current,
      resume: [{ runId, ackSeq: 1 }],
    });
    const token = await reconnected.receive("run.token");
    expect(token.runId).toBe(runId);
    // Minted for this socket, never replayed from storage.
    expect(token.token).not.toBe(start.mcp.token);
    // Queued after the replay, so everything replayed arrives before it.
    expect((await control.interruptRun({ owner, runId })).unwrap()).toEqual({
      type: "queued",
    });
    await reconnected.receive("run.interrupt");
    expect(reconnected.received.map(({ type }) => type)).toEqual([
      "welcome",
      "run.token",
      "run.input",
      "run.approval",
      "run.interrupt",
    ]);
    await reconnected.close();
  });

  test("a newer socket of the same installation replaces the older one", async () => {
    const desktopId = Bun.randomUUIDv7();
    const older = await openDesktop(first, desktopId);
    await older.hello();
    const newer = await openDesktop(second, desktopId);
    await newer.hello();
    expect(await older.closed).toEqual({
      code: DESKTOP_RUNNER_CLOSE.superseded.code,
      reason: DESKTOP_RUNNER_CLOSE.superseded.reason,
    });
    await newer.close();
  });
});

describe("leases", () => {
  test("an expired lease waits for the same computer, which gets a cancel queued while it was away", async () => {
    const { desktopId, runId, desktop } = await acceptedRun(first);
    desktop.send(textEvent(runId, 1, "Working"));
    await desktop.receive("ack");
    await desktop.close();

    clock.now += TIMING.leaseMs + 1;
    await first.gateway.sweep();
    expect(await runState(runId)).toMatchObject({
      state: "waiting_for_computer",
      desktopId,
    });
    expect(
      (await control.startRun(startInput(Bun.randomUUIDv7(), runId))).unwrap(),
    ).toEqual({ type: "conflict" });
    expect((await control.cancelRun({ owner, runId })).unwrap()).toEqual({
      type: "queued",
    });

    const back = await openDesktop(second, desktopId);
    back.send({
      type: "hello",
      protocol: DESKTOP_RUNNER_PROTOCOL.current,
      appVersion: "1.4.0",
      sidecarVersion: "1.4.0",
      harnesses: [],
      activeRuns: [{ runId, lastSeq: 1 }],
    });
    expect((await back.receive("welcome")).resume).toEqual([
      { runId, ackSeq: 1 },
    ]);
    await back.receive("run.cancel", ofRun(runId));
    expect((await runState(runId))?.state).toBe("running");
    back.send({
      type: "run.finished",
      runId,
      seq: 2,
      outcome: "cancelled",
      harnessSessionId: null,
    });
    await back.receive("ack");
    expect(await runState(runId)).toMatchObject({
      state: "finished",
      outcome: "cancelled",
    });
    expect((await control.cancelRun({ owner, runId })).unwrap()).toEqual({
      type: "run_ended",
      state: "finished",
    });
    await back.close();
  });

  test("a computer back without a run it accepted loses it, and one it never accepted is offered again", async () => {
    const { desktopId, runId: accepted, desktop } = await acceptedRun(first);
    desktop.send(textEvent(accepted, 1, "Working"));
    await desktop.receive("ack");
    const unaccepted = Bun.randomUUIDv7();
    expect(
      (await control.startRun(startInput(desktopId, unaccepted))).unwrap(),
    ).toEqual({ type: "assigned" });
    await desktop.receive("run.start", ofRun(unaccepted));
    await desktop.close();

    const back = await openDesktop(first, desktopId);
    await back.hello();
    await back.receive("run.start", ofRun(unaccepted));
    expect((await runState(accepted))?.state).toBe("lost");
    expect((await runState(unaccepted))?.state).toBe("assigned");
    const [row] = await db
      .select({ desktopId: desktopRunnerRuns.desktopId })
      .from(desktopRunnerRuns)
      .where(eq(desktopRunnerRuns.runId, accepted));
    expect(row?.desktopId).toBe(desktopId);
    await back.close();
  });
});

describe("routing and delivery across API tasks", () => {
  test("the doorbell reaches the task holding the socket, and the sweep delivers a lost ring", async () => {
    const desktopId = Bun.randomUUIDv7();
    const desktop = await openDesktop(second, desktopId);
    await desktop.hello();
    const picked = (
      await control.pickDesktop({ owner, harness: "codex" })
    ).unwrap();
    expect(picked).toMatchObject({ type: "available", desktopId });
    expect(
      (await control.pickDesktop({ owner, harness: "claude-code" })).unwrap(),
    ).toMatchObject({
      type: "harness_unavailable",
      desktopId,
      report: { state: "needs_login" },
    });

    const runId = Bun.randomUUIDv7();
    // Queued through the first task's view; the socket lives on the second.
    expect(
      (await control.startRun(startInput(desktopId, runId))).unwrap(),
    ).toEqual({
      type: "assigned",
    });
    await desktop.receive("run.start", ofRun(runId));
    desktop.send({ type: "run.accepted", runId });

    const silent = createDesktopRunnerControl({
      db: gatewayDb,
      doorbell: {
        ring: () => undefined,
        listen: async () =>
          await Promise.resolve(async () => await Promise.resolve()),
      },
      now,
      timing: TIMING,
    });
    const inputId = Bun.randomUUIDv7();
    expect(
      (
        await silent.sendInput({
          owner,
          runId,
          inputId,
          message: { role: "user", content: "One more thing." },
        })
      ).unwrap(),
    ).toEqual({ type: "queued" });
    expect(desktop.received.some(({ type }) => type === "run.input")).toBe(
      false,
    );
    await second.gateway.sweep();
    expect(
      (
        await desktop.receive(
          "run.input",
          (message) =>
            message.type === "run.input" && message.inputId === inputId,
        )
      ).inputId,
    ).toBe(inputId);
    await desktop.close();
  });

  test("draining asks every socket to reconnect after a spread delay and refuses new ones", async () => {
    const draining = await startInstance("api-draining", sharedDoorbell);
    const desktop = await openDesktop(draining, Bun.randomUUIDv7());
    await desktop.hello();
    await draining.gateway.drain();
    const reconnect = await desktop.receive("reconnect");
    expect(reconnect.afterMs).toBeGreaterThanOrEqual(0);
    expect(reconnect.afterMs).toBeLessThanOrEqual(TIMING.drainSpreadMs);
    expect((await desktop.closed).code).toBe(
      DESKTOP_RUNNER_CLOSE.goingAway.code,
    );
    const refused = await draining.gateway.upgrade(
      await upgradeRequest(draining, Bun.randomUUIDv7()),
      draining.server,
    );
    expect(refused?.status).toBe(503);
  });
});
