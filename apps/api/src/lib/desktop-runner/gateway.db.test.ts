import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import * as v from "valibot";

import {
  DESKTOP_RUNNER_FEATURE_ID,
  DESKTOP_RUNNER_LIMITS,
  DESKTOP_RUNNER_MAX_FRAME_BYTES,
  DESKTOP_RUNNER_PROTOCOL,
  type DesktopRunnerLimits,
  type DesktopRunnerServerMessage,
  desktopRunnerServerMessageSchema,
} from "@stll/api-contract/desktop-runner";

import { user } from "@/api/db/auth-schema";
import {
  desktopRunnerEvents,
  desktopRunnerRuns,
  desktopRunners,
} from "@/api/db/schema";
import type { HttpServer } from "@/api/http/context";
import {
  type ApiServerWebSocket,
  type ApiSocketData,
  type ApiSocketSession,
  apiWebSocketHandler,
} from "@/api/http/websocket";
import { desktopKeyLiveness } from "@/api/lib/business-registries/desktop/liveness";
import { revokeDesktopRegistryCredential } from "@/api/lib/business-registries/desktop/revocation";
import { queryCountLogger } from "@/api/lib/db-query-counter";
import {
  createDesktopRunnerControl,
  type DesktopRunnerControl,
} from "@/api/lib/desktop-runner/control";
import {
  createLocalDoorbell,
  type DesktopRunnerDoorbell,
} from "@/api/lib/desktop-runner/doorbell";
import {
  type RunnerFeatureAccess,
  runnerFeatureAccess,
} from "@/api/lib/desktop-runner/feature-access";
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
import type {
  MintRunToken,
  RunnerTimers,
} from "@/api/lib/desktop-runner/session";
import type { DesktopRunnerDb } from "@/api/lib/desktop-runner/store";
import type { FeatureAccessGrants } from "@/api/lib/feature-access/grants-schema";
import { createDesktopDeviceSigner } from "@/api/tests/helpers/desktop-device-proof";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { desktopRunnerUpgradeScalingScenario } from "@/api/tests/read-scaling/desktop-runner-upgrade";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";
import { createRlsDesktopCredentials } from "@/api/tests/security/rls-desktop-credentials";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";
import {
  getTestDb,
  releaseTestDb,
  withQueryLogger,
} from "@/api/tests/security/test-utils";

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

/** Both fixture organizations hold the runner feature unless a test takes it away. */
const RUNNER_GRANTS: FeatureAccessGrants = {
  [DESKTOP_RUNNER_FEATURE_ID]: [
    { type: "organization", organizationId: ids.orgA },
    { type: "organization", organizationId: ids.orgB },
  ],
};
const runnerGrants: { current: FeatureAccessGrants } = {
  current: RUNNER_GRANTS,
};
/** The real feature decision over the test database and the grants above. */
const isRunnerEnabled: RunnerFeatureAccess = async (account) =>
  await runnerFeatureAccess({
    // SAFETY: PGlite and Bun SQL expose the same Drizzle select API.
    db: asTestRaw<
      NonNullable<NonNullable<Parameters<typeof runnerFeatureAccess>[0]>["db"]>
    >(db),
    grants: () => runnerGrants.current,
  })(account);
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

/** Reads the gateway makes outside a transaction, as a socket's delivery does. */
const directReads = { count: 0 };

/** Resolves when the gateway writes outside a transaction, as a socket's release does. */
const directUpdates: { next: PromiseWithResolvers<undefined> | null } = {
  next: null,
};

let gatewayDb: DesktopRunnerDb;
const sharedDoorbell = createLocalDoorbell();

type Instance = {
  gateway: DesktopRunnerGateway;
  server: HttpServer;
  url: string;
};
const instances: Instance[] = [];

type InstanceOverrides = {
  limits?: Partial<DesktopRunnerLimits>;
  timing?: Partial<DesktopRunnerTiming>;
  timers?: RunnerTimers;
};

const startInstance = async (
  instanceId: string,
  doorbell: DesktopRunnerDoorbell,
  overrides: InstanceOverrides = {},
): Promise<Instance> => {
  const gateway = createDesktopRunnerGateway({
    db: gatewayDb,
    doorbell,
    instanceId,
    authorize: authorizeRunnerWith(credentials.authorizeDesktopAccount),
    mintRunToken,
    now,
    random: () => 0.5,
    timing: { ...TIMING, ...overrides.timing },
    limits: overrides.limits ?? {},
    ...(overrides.timers === undefined ? {} : { timers: overrides.timers }),
    // SAFETY: PGlite and Bun SQL expose the same Drizzle select API.
    isKeyLive: desktopKeyLiveness(
      asTestRaw<Parameters<typeof desktopKeyLiveness>[0]>(db),
    ),
    isRunnerEnabled,
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
  // Feature access decides only for verified members.
  await db
    .update(user)
    .set({ emailVerified: true })
    .where(eq(user.id, ids.userA1));
  // SAFETY: PGlite and Bun SQL expose the same Drizzle query and transaction
  // APIs the gateway uses; the transaction is wrapped to hold a commit open.
  const updateRows = db.update.bind(db);
  const selectRows = db.select.bind(db);
  gatewayDb = asTestRaw<DesktopRunnerDb>({
    select: (...fields: Parameters<typeof db.select>) => {
      directReads.count += 1;
      return selectRows(...fields);
    },
    insert: db.insert.bind(db),
    update: (table: Parameters<typeof db.update>[0]) => {
      const observed = directUpdates.next;
      directUpdates.next = null;
      observed?.resolve(undefined);
      // The caller adds its own `where`; this only observes the write.
      return updateRows(table);
    },
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

const helloFrame = (activeRuns: { runId: string; lastSeq: number }[] = []) => ({
  type: "hello",
  protocol: DESKTOP_RUNNER_PROTOCOL.current,
  appVersion: "1.4.0",
  sidecarVersion: "1.4.0",
  harnesses: [],
  activeRuns,
});

/** A runner row as a socket would have left it, for state a test sets up directly. */
const insertRunner = async (
  values: Pick<
    typeof desktopRunners.$inferInsert,
    "userId" | "organizationId" | "desktopId" | "deviceJkt" | "connection"
  >,
) => {
  await db.insert(desktopRunners).values({
    ...values,
    sessionId: Bun.randomUUIDv7(),
    instanceId: "api-elsewhere",
    protocol: DESKTOP_RUNNER_PROTOCOL.current,
    appVersion: "1.4.0",
    sidecarVersion: "1.4.0",
    harnesses: [],
    connectedAt: now(),
    lastSeenAt: now(),
  });
};

const runnerRows = async (
  userId: (typeof desktopRunners.$inferSelect)["userId"],
  organizationId: (typeof desktopRunners.$inferSelect)["organizationId"],
) =>
  await db
    .select({
      desktopId: desktopRunners.desktopId,
      deviceJkt: desktopRunners.deviceJkt,
      connection: desktopRunners.connection,
    })
    .from(desktopRunners)
    .where(
      and(
        eq(desktopRunners.userId, userId),
        eq(desktopRunners.organizationId, organizationId),
      ),
    );

const startInput = (desktopId: string) => ({
  owner,
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

/** Start a run on `desktopId` and return the id the API minted for it. */
const assignRun = async (desktopId: string) => {
  const outcome = (await control.startRun(startInput(desktopId))).unwrap();
  return outcome.type === "assigned"
    ? outcome.runId
    : panic(`the run was not assigned: ${outcome.type}`);
};

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
    case "run.start":
    case "run.input":
    case "run.approval":
    case "run.interrupt":
    case "run.cancel":
    case "run.token":
    case "ack":
      return message.runId === runId;
    default:
      message satisfies never;
      return panic("Unknown desktop runner server message");
  }
};

/** A desktop holding a run it accepted. */
const acceptedRun = async (instance: Instance) => {
  const desktopId = Bun.randomUUIDv7();
  const desktop = await openDesktop(instance, desktopId);
  await desktop.hello();
  const runId = await assignRun(desktopId);
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
    const unaccepted = await assignRun(desktopId);
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

    // Queued through the first task's view; the socket lives on the second.
    const runId = await assignRun(desktopId);
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

describe("upgrade scaling", () => {
  test("opening a socket reads the same however many runs the account's desktops hold", async () => {
    // Credentials on a counted connection, so the upgrade's reads are measured.
    const counted = await createRlsDesktopCredentials(
      withQueryLogger(db, queryCountLogger),
      ids,
    );
    const gateway = createDesktopRunnerGateway({
      db: gatewayDb,
      doorbell: createLocalDoorbell(),
      instanceId: "api-scaling",
      authorize: authorizeRunnerWith(counted.authorizeDesktopAccount),
      mintRunToken,
      now,
      random: () => 0.5,
      timing: TIMING,
      isRunnerEnabled,
    });
    const fixture = {
      gateway,
      signRequest: async () =>
        await upgradeRequest(first, Bun.randomUUIDv7(), counted.a),
    };
    const small = await desktopRunnerUpgradeScalingScenario.measure(fixture);

    const desktopId = Bun.randomUUIDv7();
    const desktop = await openDesktop(first, desktopId);
    await desktop.hello();
    for (let index = 0; index < 20; index += 1) {
      await assignRun(desktopId);
    }
    await desktop.close();
    const large = await desktopRunnerUpgradeScalingScenario.measure(fixture);

    expect(small.statements).toBeGreaterThan(0);
    expect(readScalingViolations({ small, large })).toEqual([]);
  });
});

describe("runner identity", () => {
  test("another device key naming the same installation gets its own runner and replaces nothing", async () => {
    const other = await createRlsDesktopCredentials(db, ids);
    const { desktopId, runId, desktop: original } = await acceptedRun(first);
    const intruder = await openDesktop(
      second,
      desktopId,
      await upgradeRequest(second, desktopId, other.a),
    );
    await intruder.hello();
    // Still the current socket of its own key: its run's commands reach it.
    expect((await control.interruptRun({ owner, runId })).unwrap()).toEqual({
      type: "queued",
    });
    await original.receive("run.interrupt", ofRun(runId));
    const rows = (await runnerRows(owner.userId, owner.organizationId)).filter(
      (row) => row.desktopId === desktopId,
    );
    expect(rows.map(({ deviceJkt }) => deviceJkt).toSorted()).toEqual(
      [credentials.a.deviceJkt, other.a.deviceJkt].toSorted(),
    );
    await original.close();
    await intruder.close();
  });

  test("an account at its installation cap is refused until a disconnected one without open runs makes room", async () => {
    const capped = await startInstance("api-capped", sharedDoorbell, {
      limits: { maxRunnersPerAccount: 2 },
    });
    const [busyId, idleId, newId] = [
      Bun.randomUUIDv7(),
      Bun.randomUUIDv7(),
      Bun.randomUUIDv7(),
    ];
    const account = { userId: owner.userId, organizationId: ids.orgB };
    for (const desktopId of [busyId, idleId]) {
      await insertRunner({
        ...account,
        desktopId,
        deviceJkt: credentials.b.deviceJkt,
        connection: "connected",
      });
    }
    const open = async () =>
      await openDesktop(
        capped,
        newId,
        await upgradeRequest(capped, newId, credentials.b),
      );
    const refused = await open();
    refused.send(helloFrame());
    expect(await refused.closed).toEqual({
      code: DESKTOP_RUNNER_CLOSE.tooManyRunners.code,
      reason: DESKTOP_RUNNER_CLOSE.tooManyRunners.reason,
    });
    // A connected installation is never evicted; a disconnected idle one is.
    await db
      .update(desktopRunners)
      .set({ connection: "disconnected" })
      .where(eq(desktopRunners.desktopId, idleId));
    const admitted = await open();
    await admitted.hello();
    const rows = await runnerRows(account.userId, account.organizationId);
    expect(rows.map(({ desktopId }) => desktopId).toSorted()).toEqual(
      [busyId, newId].toSorted(),
    );
    await admitted.close();
  });
});

describe("credential revocation", () => {
  test("revoking the device key closes its socket at the next heartbeat and routes nothing more to it", async () => {
    const fresh = await createRlsDesktopCredentials(db, ids);
    // Heartbeats on a short interval; the socket's close is the signal awaited.
    const beating = await startInstance("api-heartbeat", sharedDoorbell, {
      timing: { pingIntervalMs: 50 },
    });
    const desktopId = Bun.randomUUIDv7();
    const desktop = await openDesktop(
      beating,
      desktopId,
      await upgradeRequest(beating, desktopId, fresh.a),
    );
    await desktop.hello();
    await revokeDesktopRegistryCredential({
      keyId: fresh.a.keyId,
      organizationId: ids.orgA,
      userId: ids.userA1,
      recordAuditEvent: async () => await Promise.resolve(),
      // SAFETY: PGlite and Bun SQL expose the same Drizzle transaction API.
      db: asTestRaw<
        NonNullable<Parameters<typeof revokeDesktopRegistryCredential>[0]["db"]>
      >(db),
    });
    // Routing skips the revoked key's runner from the revocation on.
    expect((await control.startRun(startInput(desktopId))).unwrap()).toEqual({
      type: "no_computer",
    });
    expect(await desktop.closed).toEqual({
      code: DESKTOP_RUNNER_CLOSE.credentialRevoked.code,
      reason: DESKTOP_RUNNER_CLOSE.credentialRevoked.reason,
    });
    // Nothing reached the socket after its welcome: no run, no token.
    expect(desktop.received.map(({ type }) => type)).toEqual(["welcome"]);
  });
});

describe("runner feature", () => {
  test("an account without the runner feature is refused before the upgrade and keeps no runner", async () => {
    const desktopId = Bun.randomUUIDv7();
    const openBefore = first.gateway.openSessions();
    runnerGrants.current = {};
    try {
      const refused = await first.gateway.upgrade(
        await upgradeRequest(first, desktopId),
        first.server,
      );
      expect(refused?.status).toBe(403);
      expect(await refused?.json()).toMatchObject({
        code: DESKTOP_RUNNER_CLOSE.featureDisabled.reason,
      });
    } finally {
      runnerGrants.current = RUNNER_GRANTS;
    }
    expect(first.gateway.openSessions()).toBe(openBefore);
    expect(
      (await runnerRows(owner.userId, owner.organizationId)).filter(
        (row) => row.desktopId === desktopId,
      ),
    ).toEqual([]);
    // With the feature on, the same installation is welcomed.
    const desktop = await openDesktop(first, desktopId);
    await desktop.hello();
    expect(desktop.received.map(({ type }) => type)).toEqual(["welcome"]);
    await desktop.close();
  });

  test("turning the runner feature off closes an open socket at the next heartbeat", async () => {
    // Heartbeats on a short interval; the socket's close is the signal awaited.
    const beating = await startInstance(
      "api-feature-heartbeat",
      sharedDoorbell,
      {
        timing: { pingIntervalMs: 50 },
      },
    );
    const desktop = await openDesktop(beating, Bun.randomUUIDv7());
    await desktop.hello();
    runnerGrants.current = {};
    try {
      expect(await desktop.closed).toEqual({
        code: DESKTOP_RUNNER_CLOSE.featureDisabled.code,
        reason: DESKTOP_RUNNER_CLOSE.featureDisabled.reason,
      });
    } finally {
      runnerGrants.current = RUNNER_GRANTS;
    }
  });
});

/** System timers that remember which ones are still scheduled. */
const recordingTimers = () => {
  const pending = new Set<Timer>();
  const timers: RunnerTimers = {
    setTimeout: (run, ms) => {
      const timer = setTimeout(() => {
        pending.delete(timer);
        run();
      }, ms);
      pending.add(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      pending.delete(timer);
      clearTimeout(timer);
    },
    setInterval: (run, ms) => {
      const timer = setInterval(run, ms);
      pending.add(timer);
      return timer;
    },
    clearInterval: (timer) => {
      pending.delete(timer);
      clearInterval(timer);
    },
  };
  return { timers, pending };
};

describe("socket lifecycle", () => {
  test("a socket that closes while its hello is stored schedules nothing and mints nothing", async () => {
    const { timers, pending } = recordingTimers();
    const recorded = await startInstance("api-timers", sharedDoorbell, {
      timers,
    });
    const desktopId = Bun.randomUUIDv7();
    const desktop = await openDesktop(recorded, desktopId);
    const held: HeldCommit = {
      reached: Promise.withResolvers<undefined>(),
      release: Promise.withResolvers<undefined>(),
    };
    commitGate.next = held;
    desktop.send(helloFrame());
    await held.reached.promise;
    await desktop.close();
    const released = Promise.withResolvers<undefined>();
    directUpdates.next = released;
    held.release.resolve(undefined);
    // The release runs after the hello step, so the step has finished here.
    await released.promise;
    expect(pending.size).toBe(0);
    expect(desktop.received).toEqual([]);
    expect(recorded.gateway.openSessions()).toBe(0);
  });
});

describe("runs the API ends", () => {
  test("a run whose computer never returns ends as lost, and listing it again does not revive it", async () => {
    const { desktopId, runId, desktop } = await acceptedRun(first);
    desktop.send(textEvent(runId, 1, "Working"));
    await desktop.receive("ack");
    await desktop.close();
    clock.now += TIMING.leaseMs + 1;
    await first.gateway.sweep();
    expect((await runState(runId))?.state).toBe("waiting_for_computer");
    clock.now += DESKTOP_RUNNER_LIMITS.abandonedRunMs + 1;
    await first.gateway.sweep();
    expect((await runState(runId))?.state).toBe("lost");

    const back = await openDesktop(first, desktopId);
    back.send(helloFrame([{ runId, lastSeq: 1 }]));
    expect((await back.receive("welcome")).resume).toEqual([]);
    expect((await runState(runId))?.state).toBe("lost");
    expect(back.received.map(({ type }) => type)).toEqual(["welcome"]);
    await back.close();
  });

  test("a run nobody accepts ends as lost after the abandon window", async () => {
    const desktopId = Bun.randomUUIDv7();
    const desktop = await openDesktop(first, desktopId);
    await desktop.hello();
    const runId = await assignRun(desktopId);
    await desktop.receive("run.start", ofRun(runId));
    clock.now += DESKTOP_RUNNER_LIMITS.abandonedRunMs + 1;
    await first.gateway.sweep();
    expect((await runState(runId))?.state).toBe("lost");
    await desktop.close();
  });

  test("a heartbeat refreshes tokens only for runs that are still running", async () => {
    const beating = await startInstance("api-tokens", sharedDoorbell, {
      timing: { pingIntervalMs: 50 },
    });
    const desktopId = Bun.randomUUIDv7();
    const desktop = await openDesktop(beating, desktopId);
    await desktop.hello();
    // The ended run is started first, so a refresh for it would arrive first.
    const ended = await assignRun(desktopId);
    const running = await assignRun(desktopId);
    for (const runId of [ended, running]) {
      await desktop.receive("run.start", ofRun(runId));
      desktop.send({ type: "run.accepted", runId });
      // Frames are handled in order: this ack follows the stored acceptance.
      desktop.send(textEvent(runId, 1, "Working"));
      await desktop.receive("ack", ofRun(runId));
    }
    // Ended by the API while the socket stays open.
    await db
      .update(desktopRunnerRuns)
      .set({ state: "lost" })
      .where(eq(desktopRunnerRuns.runId, ended));
    clock.now += 15 * 60_000;
    await desktop.receive("run.token", ofRun(running));
    expect(
      desktop.received.filter(
        (message) => message.type === "run.token" && message.runId === ended,
      ),
    ).toEqual([]);
    await desktop.close();
  });
});

describe("what one run may store", () => {
  test("a message past the run's message cap ends the run as lost and is not stored", async () => {
    const capped = await startInstance("api-message-cap", sharedDoorbell, {
      limits: { maxMessagesPerRun: 2 },
    });
    const { runId, desktop } = await acceptedRun(capped);
    for (const seq of [1, 2]) {
      desktop.send(textEvent(runId, seq, `Part ${String(seq)}`));
      expect(await desktop.receive("ack")).toEqual({ type: "ack", runId, seq });
    }
    desktop.send(textEvent(runId, 3, "One too many"));
    expect(await desktop.closed).toEqual({ code: 1008, reason: "run_limit" });
    expect((await storedSeqs(runId)).map(({ seq }) => seq)).toEqual([1, 2]);
    expect((await runState(runId))?.state).toBe("lost");
  });

  test("a message past the run's byte cap ends the run as lost and is not stored", async () => {
    const capped = await startInstance("api-byte-cap", sharedDoorbell, {
      limits: { maxMessageBytesPerRun: 2048 },
    });
    const { runId, desktop } = await acceptedRun(capped);
    desktop.send(textEvent(runId, 1, "Short"));
    await desktop.receive("ack");
    desktop.send(textEvent(runId, 2, "x".repeat(4096)));
    expect(await desktop.closed).toEqual({ code: 1008, reason: "run_limit" });
    expect((await storedSeqs(runId)).map(({ seq }) => seq)).toEqual([1]);
    expect((await runState(runId))?.state).toBe("lost");
  });

  test("a run holds at most its command cap, its start included", async () => {
    const cappedControl = createDesktopRunnerControl({
      db: gatewayDb,
      doorbell: sharedDoorbell,
      now,
      timing: TIMING,
      limits: { maxCommandsPerRun: 2 },
    });
    const { runId, desktop } = await acceptedRun(first);
    const input = () => ({
      owner,
      runId,
      inputId: Bun.randomUUIDv7(),
      message: { role: "user" as const, content: "More." },
    });
    expect((await cappedControl.sendInput(input())).unwrap()).toEqual({
      type: "queued",
    });
    expect((await cappedControl.sendInput(input())).unwrap()).toEqual({
      type: "command_limit",
    });
    await desktop.close();
  });

  test("an ended run is deleted with its messages once its retention window passes", async () => {
    const { runId, desktop } = await acceptedRun(first);
    desktop.send({
      type: "run.finished",
      runId,
      seq: 1,
      outcome: "completed",
      harnessSessionId: null,
    });
    await desktop.receive("ack");
    await desktop.close();
    await first.gateway.sweep();
    expect((await runState(runId))?.state).toBe("finished");
    clock.now += DESKTOP_RUNNER_LIMITS.endedRunRetentionMs + 1;
    await first.gateway.sweep();
    expect(await runState(runId)).toBeNull();
    expect(await storedSeqs(runId)).toEqual([]);
  });
});

describe("sweep delivery", () => {
  test("a sweep reads the queues of only the sockets that have commands queued", async () => {
    const sweeping = await startInstance("api-sweep", sharedDoorbell);
    const idle: FakeDesktop[] = [];
    for (let index = 0; index < 3; index += 1) {
      const desktop = await openDesktop(sweeping, Bun.randomUUIDv7());
      await desktop.hello();
      idle.push(desktop);
    }
    const { runId, desktop: busy } = await acceptedRun(sweeping);
    // Queued without a ring, so only the sweep can deliver it.
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
    directReads.count = 0;
    await sweeping.gateway.sweep();
    // One read finds the socket; its delivery reads its runner and one page.
    expect(directReads.count).toBe(3);
    expect(
      (
        await busy.receive(
          "run.input",
          (message) =>
            message.type === "run.input" && message.inputId === inputId,
        )
      ).inputId,
    ).toBe(inputId);
    for (const desktop of [...idle, busy]) {
      await desktop.close();
    }
  });
});

describe("socket memory", () => {
  test("frames waiting past the socket's byte cap close it as overloaded", async () => {
    const capped = await startInstance("api-queued-bytes", sharedDoorbell, {
      limits: { maxQueuedBytesPerSocket: 1500 },
    });
    const { runId, desktop } = await acceptedRun(capped);
    const held: HeldCommit = {
      reached: Promise.withResolvers<undefined>(),
      release: Promise.withResolvers<undefined>(),
    };
    commitGate.next = held;
    desktop.send(textEvent(runId, 1, "Stored slowly"));
    // While the first message is being stored, the next ones wait in memory.
    await held.reached.promise;
    desktop.send(textEvent(runId, 2, "x".repeat(800)));
    desktop.send(textEvent(runId, 3, "y".repeat(800)));
    expect((await desktop.closed).code).toBe(
      DESKTOP_RUNNER_CLOSE.overloaded.code,
    );
    held.release.resolve(undefined);
  });

  test("an account holds at most its socket cap on one API task", async () => {
    const capped = await startInstance("api-socket-cap", sharedDoorbell, {
      limits: { maxSocketsPerAccount: 2 },
    });
    const open: FakeDesktop[] = [];
    for (let index = 0; index < 2; index += 1) {
      const desktop = await openDesktop(capped, Bun.randomUUIDv7());
      await desktop.hello();
      open.push(desktop);
    }
    const refused = await capped.gateway.upgrade(
      await upgradeRequest(capped, Bun.randomUUIDv7()),
      capped.server,
    );
    expect(refused?.status).toBe(429);
    const [closing, ...rest] = open;
    if (closing === undefined) {
      return panic("two sockets were opened");
    }
    await closing.close();
    // A closed socket frees its place.
    const admitted = await openDesktop(capped, Bun.randomUUIDv7());
    await admitted.hello();
    for (const desktop of [...rest, admitted]) {
      await desktop.close();
    }
  });
});

describe("outbound frames", () => {
  test("a command that would not fit one frame is refused before it is queued", async () => {
    const { desktopId, runId, desktop } = await acceptedRun(first);
    const huge = "x".repeat(DESKTOP_RUNNER_MAX_FRAME_BYTES);
    expect(
      (
        await control.sendInput({
          owner,
          runId,
          inputId: Bun.randomUUIDv7(),
          message: { role: "user", content: huge },
        })
      ).unwrap(),
    ).toEqual({ type: "too_large" });
    expect(
      (
        await control.startRun({
          ...startInput(desktopId),
          messages: [{ role: "user", content: huge }],
        })
      ).unwrap(),
    ).toEqual({ type: "too_large" });
    await desktop.close();
  });

  test("delivery waits while the socket reports backpressure and resumes when it drains", async () => {
    const gateway = createDesktopRunnerGateway({
      db: gatewayDb,
      doorbell: sharedDoorbell,
      instanceId: "api-backpressure",
      authorize: authorizeRunnerWith(credentials.authorizeDesktopAccount),
      mintRunToken,
      now,
      random: () => 0.5,
      timing: TIMING,
      isRunnerEnabled,
    });
    await gateway.start();
    const accepted: { session: ApiSocketSession | null } = { session: null };
    const server = asTestRaw<HttpServer>({
      upgrade: (_request: Request, upgrade: { data: ApiSocketData }) => {
        accepted.session = upgrade.data.session;
        return true;
      },
    });
    const desktopId = Bun.randomUUIDv7();
    expect(
      await gateway.upgrade(await upgradeRequest(first, desktopId), server),
    ).toBeNull();
    const session =
      accepted.session ?? panic("the gateway took the upgrade over");

    const sent: DesktopRunnerServerMessage[] = [];
    const waiters = new Set<{
      matches: (message: DesktopRunnerServerMessage) => boolean;
      arrived: PromiseWithResolvers<undefined>;
    }>();
    const arrival = (
      matches: (message: DesktopRunnerServerMessage) => boolean,
    ) => {
      const waiter = { matches, arrived: Promise.withResolvers<undefined>() };
      if (sent.some(matches)) {
        waiter.arrived.resolve(undefined);
      } else {
        waiters.add(waiter);
      }
      return waiter.arrived.promise;
    };
    /** Send statuses to answer with, in order; then every send succeeds. */
    const statuses: number[] = [];
    const socket = asTestRaw<ApiServerWebSocket>({
      send: (text: string) => {
        const message = v.parse(
          desktopRunnerServerMessageSchema,
          JSON.parse(text),
        );
        sent.push(message);
        for (const waiter of waiters) {
          if (waiter.matches(message)) {
            waiters.delete(waiter);
            waiter.arrived.resolve(undefined);
          }
        }
        return message.type === "run.start" ? (statuses.shift() ?? 1) : 1;
      },
      close: () => undefined,
      ping: () => undefined,
    });
    session.open(socket);
    clock.now += 1000;
    session.message(
      socket,
      JSON.stringify({
        ...helloFrame(),
        harnesses: [
          {
            id: "codex",
            state: "ready",
            version: HARNESS_VERSION,
            capabilities: ["approvals", "interrupt"],
            models: [{ id: MODEL, label: "GPT-5 Codex" }],
          },
        ],
      }),
    );
    await arrival(({ type }) => type === "welcome");

    // Bun buffers the first start: the socket takes nothing more until it drains.
    statuses.push(-1);
    const buffered = await assignRun(desktopId);
    await arrival(ofRun(buffered));
    const waiting = await assignRun(desktopId);
    // A delivery attempt has run once the sweep's own delivery resolves.
    await gateway.sweep();
    const starts = () =>
      sent.flatMap((message) =>
        message.type === "run.start" ? [message.runId] : [],
      );
    expect(starts()).toEqual([buffered]);
    session.drain(socket);
    await arrival(ofRun(waiting));
    expect(starts()).toEqual([buffered, waiting]);
    session.close(socket, 1000, "done");
    await gateway.drain();
  });
});

describe("gateway edges", () => {
  test("a draining task tells a socket that had not opened yet to reconnect as it opens", async () => {
    const gateway = createDesktopRunnerGateway({
      db: gatewayDb,
      doorbell: sharedDoorbell,
      instanceId: "api-drain-early",
      authorize: authorizeRunnerWith(credentials.authorizeDesktopAccount),
      mintRunToken,
      now,
      random: () => 0.5,
      timing: TIMING,
      isRunnerEnabled,
    });
    await gateway.start();
    const accepted: { session: ApiSocketSession | null } = { session: null };
    const server = asTestRaw<HttpServer>({
      upgrade: (_request: Request, upgrade: { data: ApiSocketData }) => {
        accepted.session = upgrade.data.session;
        return true;
      },
    });
    expect(
      await gateway.upgrade(
        await upgradeRequest(first, Bun.randomUUIDv7()),
        server,
      ),
    ).toBeNull();
    const session =
      accepted.session ?? panic("the gateway took the upgrade over");
    await gateway.drain();
    const sent: unknown[] = [];
    const closes: number[] = [];
    const socket = asTestRaw<ApiServerWebSocket>({
      send: (text: string) => {
        sent.push(JSON.parse(text));
        return 1;
      },
      close: (code: number) => {
        closes.push(code);
      },
      ping: () => undefined,
    });
    session.open(socket);
    expect(sent).toEqual([{ type: "reconnect", afterMs: 500 }]);
    expect(closes).toEqual([DESKTOP_RUNNER_CLOSE.goingAway.code]);
    session.close(socket, DESKTOP_RUNNER_CLOSE.goingAway.code, "going_away");
  });

  test("the API mints each run's id, so a caller never names one", async () => {
    const desktopId = Bun.randomUUIDv7();
    const desktop = await openDesktop(first, desktopId);
    await desktop.hello();
    const [one, two] = [await assignRun(desktopId), await assignRun(desktopId)];
    expect(one).not.toBe(two);
    for (const runId of [one, two]) {
      expect((await desktop.receive("run.start", ofRun(runId))).runId).toBe(
        runId,
      );
      expect((await runState(runId))?.desktopId).toBe(desktopId);
    }
    await desktop.close();
  });
});
