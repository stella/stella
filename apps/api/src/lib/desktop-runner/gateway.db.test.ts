import {
  EventType,
  type ModelMessage,
  RUN_CANCEL_REASON,
  type RunAgentResumeItem,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai";
import { ChatClient } from "@tanstack/ai-client";
import { panic, Result } from "better-result";
import { afterAll, describe, expect, test } from "bun:test";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import * as v from "valibot";

import {
  createChunkCoalescer,
  HARNESS_QUESTION_TOOL,
  type HarnessEvent,
  harnessEventsToChunks,
  harnessSessionId,
} from "@stll/agent-engine";
import { AI_FAILURE_CODES } from "@stll/api-contract";
import {
  CHAT_TOOL_EXECUTOR,
  CHAT_TOOL_EXECUTOR_METADATA_KEY,
  chatToolExecutor,
} from "@stll/api-contract/chat";
import {
  CHAT_LOCAL_RUN_STEP_OUTPUT_GRANT_SECONDS,
  chatLocalRunStepOutputGrantMessage,
} from "@stll/api-contract/chat-local-run-step-output";
import {
  CHAT_LOCAL_RUN_PARENT_CALL_METADATA_KEY,
  chatLocalRunParentCallId,
} from "@stll/api-contract/chat-local-run-tool";
import {
  CHAT_LOCAL_RUN_COMPUTER_EVENT,
  CHAT_LOCAL_RUN_CONTEXT_METADATA_KEY,
  CHAT_LOCAL_RUN_FILES_METADATA_KEY,
  CHAT_LOCAL_RUN_FILES_NOT_SHARED_METADATA_KEY,
  CHAT_LOCAL_RUN_LIMIT_METADATA_KEY,
  chatLocalRunComputerEventSchema,
} from "@stll/api-contract/chat-run-target";
import {
  DESKTOP_RUNNER_APPROVAL_MODES,
  DESKTOP_RUNNER_CHECKPOINT_EVENT,
  DESKTOP_RUNNER_CLOSE,
  DESKTOP_RUNNER_DESKTOP_ID_HEADER,
  DESKTOP_RUNNER_FEATURE_ID,
  DESKTOP_RUNNER_FOLDER_RESTORE_PROTOCOL,
  DESKTOP_RUNNER_LIMITS,
  DESKTOP_RUNNER_MAX_FRAME_BYTES,
  DESKTOP_RUNNER_OUTPUT_EVENT,
  DESKTOP_RUNNER_PATH,
  DESKTOP_RUNNER_PROTOCOL,
  type DesktopRunnerApprovalMode,
  type DesktopRunnerLimits,
  type DesktopRunnerServerMessage,
  desktopRunnerServerMessageSchema,
  type DesktopRunnerTiming,
} from "@stll/api-contract/desktop-runner";
import { USER_FILE_URL_PREFIX } from "@stll/api-contract/user-file-url";
import { compareCodeUnit } from "@stll/collation";
import { waitForExternalState } from "@stll/property-testing/external-state";
import { createTestState } from "@stll/test-state";

import { user } from "@/api/db/auth-schema";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  chatMessageRevisions,
  chatMessages,
  chatThreads,
  chatTurns,
  desktopRunnerCommands,
  desktopRunnerEvents,
  desktopRunnerFolderRestores,
  desktopRunnerRuns,
  desktopRunners,
  featureEnrolments,
  userFiles,
  workspaceMembers,
} from "@/api/db/schema";
import { createMembershipSafeDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import {
  chatMessageContentFromMessage,
  chatMessageFromPersisted,
  toPersistableChatMessage,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import {
  type ChatToolCallOwnership,
  validateMessage,
  validateToolCallParts,
} from "@/api/handlers/chat/chat-schema";
import { resolveTruncationTarget } from "@/api/handlers/chat/history-window";
import {
  createLocalChatRun,
  type LocalRunContext,
  type LocalRunPlan,
} from "@/api/handlers/chat/local-run-chunks";
import {
  classifyRunErrorChunk,
  processServerChatStream,
  resumeDismissesAwaited,
  type StreamChatFinishEvent,
  toChatMessage,
} from "@/api/handlers/chat/stream-chat";
import { createChatMessageIdMapper } from "@/api/handlers/chat/stream-message-identity";
import {
  createReadLocalFilesUndo,
  createUndoLocalFiles,
} from "@/api/handlers/chat/turns/local-files-undo";
import type { ChatMessage } from "@/api/handlers/chat/types";
import { createResponseSet, type HttpServer } from "@/api/http/context";
import { status as httpStatus } from "@/api/http/status";
import {
  type ApiServerWebSocket,
  type ApiSocketData,
  type ApiSocketSession,
  apiWebSocketHandler,
} from "@/api/http/websocket";
import { createSafeId, type SafeId, toSafeId } from "@/api/lib/branded-types";
import {
  type DesktopKeyLiveness,
  desktopKeyLiveness,
} from "@/api/lib/business-registries/desktop/liveness";
import { revokeDesktopRegistryCredential } from "@/api/lib/business-registries/desktop/revocation";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import type { PublicStreamChunk } from "@/api/lib/chat/tanstack-chat-runtime";
import { queryCountLogger } from "@/api/lib/db-query-counter";
import {
  questionInterruptOf,
  questionPauseOf,
} from "@/api/lib/desktop-runner/chunk";
import {
  createDesktopRunnerControl,
  type DesktopRunnerControl,
  FOLDER_RESTORED_NOTE,
} from "@/api/lib/desktop-runner/control";
import {
  createLocalDoorbell,
  createLocalRunBell,
  type DesktopRunnerDoorbell,
  type DesktopRunnerRunBell,
} from "@/api/lib/desktop-runner/doorbell";
import {
  type RunnerFeatureAccess,
  runnerFeatureAccess,
} from "@/api/lib/desktop-runner/feature-access";
import { requestFolderRestore } from "@/api/lib/desktop-runner/folder-restores";
import {
  authorizeRunnerWith,
  createDesktopRunnerGateway,
  type DesktopRunnerGateway,
} from "@/api/lib/desktop-runner/gateway";
import type {
  MintRunToken,
  RunnerTimers,
} from "@/api/lib/desktop-runner/session";
import { ownerStepOutputGrant } from "@/api/lib/desktop-runner/step-output-grants";
import {
  type DesktopRunnerDb,
  readNewestQueuedCommands,
  recordBackgroundTasks,
  type RunnerBinding,
} from "@/api/lib/desktop-runner/store";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { createUserFileKey } from "@/api/lib/file-key";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { abortControllerFromSignal } from "@/api/lib/tanstack-ai-generate";
import { isRecord } from "@/api/lib/type-guards";
import { createDesktopDeviceSigner } from "@/api/tests/helpers/desktop-device-proof";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { chatBackgroundTasksScalingScenario } from "@/api/tests/read-scaling/chat-background-tasks";
import { chatLocalFilesUndoScalingScenario } from "@/api/tests/read-scaling/chat-local-files-undo";
import { chatLocalRunStepOutputGrantScalingScenario } from "@/api/tests/read-scaling/chat-local-run-step-output-grant";
import { chatLocalRunnersScalingScenario } from "@/api/tests/read-scaling/chat-local-runners";
import { desktopRunnerUpgradeScalingScenario } from "@/api/tests/read-scaling/desktop-runner-upgrade";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
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

const testState = createTestState({ file: import.meta.path, config: env });
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

/** The real credential check over the test database. */
const isKeyLive: DesktopKeyLiveness = async (key) =>
  // SAFETY: PGlite and Bun SQL expose the same Drizzle select API.
  await desktopKeyLiveness(
    asTestRaw<Parameters<typeof desktopKeyLiveness>[0]>(db),
  )(key);
/** The real feature decision over the test database. */
const isRunnerEnabled: RunnerFeatureAccess = async (account) =>
  await runnerFeatureAccess({
    // SAFETY: PGlite and Bun SQL expose the same Drizzle select API.
    db: asTestRaw<
      NonNullable<NonNullable<Parameters<typeof runnerFeatureAccess>[0]>["db"]>
    >(db),
  })(account);
const now = () => new Date(clock.now);

let db: TestDatabase;
let credentials: Awaited<ReturnType<typeof createRlsDesktopCredentials>>;
let mintedTokens = 0;
/** A mint a test holds, to act while a socket composes a page. */
const mintGate: {
  held: {
    reached: PromiseWithResolvers<undefined>;
    release: Promise<void>;
  } | null;
} = { held: null };
const mintRunToken: MintRunToken = async () => {
  mintedTokens += 1;
  const held = mintGate.held;
  if (held !== null) {
    mintGate.held = null;
    held.reached.resolve(undefined);
    await held.release;
  }
  return await Promise.resolve({
    token: `run-token-${String(mintedTokens)}`,
    expiresAt: new Date(clock.now + 15 * 60_000),
  });
};

/** Every account the fixtures connect turns the runner feature on. */
const enrolRunnerFeature = async () => {
  await db
    .insert(featureEnrolments)
    .values(
      [
        { userId: ids.userA1, organizationId: ids.orgA },
        { userId: ids.userA1, organizationId: ids.orgB },
      ].map((account) => ({
        ...account,
        featureId: DESKTOP_RUNNER_FEATURE_ID,
      })),
    )
    .onConflictDoNothing();
};
const leaveRunnerFeature = async () => {
  await db
    .delete(featureEnrolments)
    .where(eq(featureEnrolments.featureId, DESKTOP_RUNNER_FEATURE_ID));
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
  runBell?: DesktopRunnerRunBell;
  announceBackgroundTasks?: (owner: RunnerBinding) => void;
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
    signAttachmentLink: async ({ s3Key }) =>
      await Promise.resolve(`https://files.example.test/${s3Key}?signed`),
    now,
    random: () => 0.5,
    timing: { ...TIMING, ...overrides.timing },
    limits: overrides.limits ?? {},
    ...(overrides.timers === undefined ? {} : { timers: overrides.timers }),
    ...(overrides.runBell === undefined ? {} : { runBell: overrides.runBell }),
    ...(overrides.announceBackgroundTasks === undefined
      ? {}
      : { announceBackgroundTasks: overrides.announceBackgroundTasks }),
    isKeyLive,
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
    url: `http://127.0.0.1:${String(server.port)}${DESKTOP_RUNNER_PATH}`,
  };
  instances.push(instance);
  return instance;
};

let first: Instance;
let second: Instance;
let control: DesktopRunnerControl;

// timeout: PGlite builds the full schema before the first test
testState.beforeAll(async () => {
  db = await getTestDb();
  await setupRlsTestData(db, ids);
  credentials = await createRlsDesktopCredentials(db, ids);
  // Feature access decides only for verified members.
  await db
    .update(user)
    .set({ emailVerified: true })
    .where(eq(user.id, ids.userA1));
  await enrolRunnerFeature();
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
            // This computer cannot sandbox the harness.
            approvalModes: ["ask"],
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
    | "userId"
    | "organizationId"
    | "desktopId"
    | "deviceJkt"
    | "keyId"
    | "connection"
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

/**
 * A runner the API counts as connected, with Codex ready, whose socket is on
 * no task: a run assigned to it is never written to a socket.
 */
const insertReadyRunner = async (desktopId: string) => {
  await db.insert(desktopRunners).values({
    userId: owner.userId,
    organizationId: owner.organizationId,
    desktopId,
    deviceJkt: credentials.a.deviceJkt,
    keyId: credentials.a.keyId,
    connection: "connected",
    sessionId: Bun.randomUUIDv7(),
    instanceId: "api-gone",
    protocol: DESKTOP_RUNNER_PROTOCOL.current,
    appVersion: "1.4.0",
    sidecarVersion: "1.4.0",
    harnesses: [
      {
        id: "codex",
        state: "ready",
        version: HARNESS_VERSION,
        capabilities: ["approvals", "interrupt"],
        approvalModes: ["ask"],
        models: [{ id: MODEL, label: "GPT-5 Codex" }],
      },
    ],
    connectedAt: now(),
    lastSeenAt: now(),
  });
};

/** Lets a row from `insertReadyRunner` make room for later installations. */
const retireRunner = async (desktopId: string) => {
  await db
    .update(desktopRunners)
    .set({ connection: "disconnected" })
    .where(eq(desktopRunners.desktopId, desktopId));
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

const startInput = (
  desktopId: string,
  approvals: DesktopRunnerApprovalMode = "ask",
  harness: "codex" | "claude-code" = "codex",
) => ({
  owner,
  desktopId,
  harness,
  harnessVersion: HARNESS_VERSION,
  model: MODEL,
  reasoningEffort: null,
  approvals,
  harnessSessionId: null,
  instructions: "Summarize the matter.",
  messages: [{ role: "user" as const, content: "Summarize the matter." }],
  attachments: [],
  mcp: { serverName: "stella", url: "https://api.example.test/mcp" },
  workspaceIds: [],
  linkedFolderId: null,
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
    case "run.answer":
    case "run.interrupt":
    case "run.cancel":
    case "run.token":
    case "ack":
    case "folder.restore":
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

  test("a run's background count is stored and announced, and forgotten when its computer says hello again", async () => {
    const announced: string[] = [];
    const waiters: (() => void)[] = [];
    /** The next announcement, whenever it comes. */
    const nextAnnouncement = async () => {
      const { promise, resolve } = Promise.withResolvers<undefined>();
      waiters.push(() => {
        resolve(undefined);
      });
      await promise;
    };
    const instance = await startInstance("api-background", sharedDoorbell, {
      announceBackgroundTasks: ({ desktopId }) => {
        announced.push(desktopId);
        waiters.shift()?.();
      },
    });
    const { runId, desktop, desktopId } = await acceptedRun(instance);
    // The turn ends; what it started keeps running in the background.
    desktop.send({
      type: "run.finished",
      runId,
      seq: 1,
      outcome: "completed",
      harnessSessionId: null,
    });
    await desktop.receive("ack", ofRun(runId));
    const backgroundOf = async () =>
      (
        await db
          .select({ counts: desktopRunners.backgroundTasks })
          .from(desktopRunners)
          .where(eq(desktopRunners.desktopId, desktopId))
      ).at(0)?.counts;

    const stored = nextAnnouncement();
    desktop.send({ type: "run.background", runId, count: 2 });
    await stored;
    expect(await backgroundOf()).toEqual({ [runId]: 2 });
    expect(announced).toEqual([desktopId]);

    // A run this computer does not hold changes nothing and keeps the
    // socket; messages are handled in order, so once the next count is
    // announced the unknown one was handled.
    desktop.send({
      type: "run.background",
      runId: Bun.randomUUIDv7(),
      count: 5,
    });
    const updated = nextAnnouncement();
    desktop.send({ type: "run.background", runId, count: 3 });
    await updated;
    expect(await backgroundOf()).toEqual({ [runId]: 3 });
    expect(announced).toEqual([desktopId, desktopId]);

    // A socket a newer one replaced writes nothing.
    const [row] = await db
      .select({ deviceJkt: desktopRunners.deviceJkt })
      .from(desktopRunners)
      .where(eq(desktopRunners.desktopId, desktopId));
    const replaced = {
      binding: {
        ...owner,
        desktopId,
        deviceJkt: row?.deviceJkt ?? "",
        keyId: "replaced-key",
      },
      sessionId: Bun.randomUUIDv7(),
    };
    expect(
      await recordBackgroundTasks(gatewayDb, { ...replaced, runId, count: 5 }),
    ).toBe("not_current");
    expect(await backgroundOf()).toEqual({ [runId]: 3 });

    // Closing announces; the next hello forgets the count until reported again.
    const closedAnnouncement = nextAnnouncement();
    await desktop.close();
    await closedAnnouncement;
    const cleared = nextAnnouncement();
    const again = await openDesktop(instance, desktopId);
    await again.hello();
    await cleared;
    expect(await backgroundOf()).toEqual({});
    await again.close();
  });

  test("an attached file's link is signed on send and never stored", async () => {
    const instance = await startInstance("api-attachments", sharedDoorbell);
    const desktopId = Bun.randomUUIDv7();
    const desktop = await openDesktop(instance, desktopId);
    await desktop.hello();
    const fileId = "019a0000-0000-7000-8000-000000000001";
    const path = `attachments/${fileId}/a.pdf`;
    const outcome = (
      await control.startRun({
        ...startInput(desktopId),
        attachments: [
          { path, fileId, fileName: "a.pdf", s3Key: "org/file.pdf" },
        ],
      })
    ).unwrap();
    if (outcome.type !== "assigned") {
      panic(`the run was not assigned: ${outcome.type}`);
    }
    const start = await desktop.receive("run.start", ofRun(outcome.runId));
    expect(start).toMatchObject({
      attachments: [
        { path, url: "https://files.example.test/org/file.pdf?signed" },
      ],
    });
    const stored = JSON.stringify(
      await db
        .select({ payload: desktopRunnerCommands.payload })
        .from(desktopRunnerCommands)
        .where(eq(desktopRunnerCommands.runId, outcome.runId)),
    );
    expect(stored).toContain("org/file.pdf");
    expect(stored).not.toContain("?signed");
    await desktop.close();
    // The account's other tests count its installations and open runs.
    await db
      .delete(desktopRunnerRuns)
      .where(eq(desktopRunnerRuns.runId, outcome.runId));
    await db
      .delete(desktopRunners)
      .where(eq(desktopRunners.desktopId, desktopId));
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

  test("a question pause an answer could not name is refused unstored", async () => {
    const pause = (
      id: string,
      questions: unknown,
      call: { toolCallId?: string },
    ) => ({
      type: "RUN_FINISHED",
      runId: "desktop-run",
      threadId: "desktop-thread",
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id,
            reason: "user_input",
            ...call,
            metadata: { kind: "question", questions },
          },
        ],
      },
    });
    const question = {
      id: "tone",
      header: "Tone",
      prompt: "Formal or friendly?",
      options: [],
      allowsFreeText: true,
      multiSelect: false,
      secret: false,
    };
    const named = { toolCallId: "item_q" };
    const desktopId = Bun.randomUUIDv7();
    for (const chunk of [
      // The harness's own id, not relabelled to a UUID.
      pause("codex-request-number-7", [question], named),
      pause(Bun.randomUUIDv7(), [{ id: "tone" }], named),
      pause(Bun.randomUUIDv7(), [], named),
      // No tool call for the chat continuation to answer.
      pause(Bun.randomUUIDv7(), [question], {}),
    ]) {
      // One installation throughout: the account holds few runners.
      const desktop = await openDesktop(first, desktopId);
      await desktop.hello();
      const runId = await assignRun(desktopId);
      await desktop.receive("run.start", ofRun(runId));
      desktop.send({ type: "run.accepted", runId });
      desktop.send({ type: "run.event", runId, seq: 1, chunk });
      expect(await desktop.closed).toEqual({
        code: 1008,
        reason: "unfoldable_chunk",
      });
      expect(await storedSeqs(runId)).toEqual([]);
    }
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
    ).toEqual({ type: "not_requested" });
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

describe("approval modes and reasoning efforts", () => {
  test("a start queued before reasoning efforts existed is sent with the harness's effort, not cancelled", async () => {
    const { desktopId, desktop } = await acceptedRun(first);
    const runId = await assignRun(desktopId);
    await desktop.receive("run.start", ofRun(runId));
    await desktop.close();
    await db
      .update(desktopRunnerCommands)
      .set({
        payload: sql`${desktopRunnerCommands.payload} - 'reasoningEffort'`,
      })
      .where(
        and(
          eq(desktopRunnerCommands.runId, runId),
          eq(desktopRunnerCommands.kind, "run.start"),
        ),
      );

    const back = await openDesktop(first, desktopId);
    await back.hello();
    const resent = await back.receive("run.start", ofRun(runId));
    expect(resent).toMatchObject({ runId, reasoningEffort: null });
    expect((await runState(runId))?.state).toBe("assigned");
    await back.close();
  });

  test("a run starts in the thread's approval mode and effort, and ones the computer does not report are refused", async () => {
    // A runner row as its socket's hello leaves it; no socket is needed to
    // queue a start.
    const desktopId = Bun.randomUUIDv7();
    await db.insert(desktopRunners).values({
      ...owner,
      desktopId,
      deviceJkt: credentials.a.deviceJkt,
      keyId: credentials.a.keyId,
      connection: "connected",
      sessionId: Bun.randomUUIDv7(),
      instanceId: "api-elsewhere",
      protocol: DESKTOP_RUNNER_PROTOCOL.current,
      appVersion: "1.4.0",
      sidecarVersion: "1.4.0",
      harnesses: [
        {
          id: "codex",
          state: "ready",
          version: HARNESS_VERSION,
          capabilities: ["approvals"],
          // A harness that offers only Ask.
          approvalModes: ["ask"],
          models: [{ id: MODEL, label: "GPT-5 Codex" }],
        },
        {
          id: "claude-code",
          state: "ready",
          version: HARNESS_VERSION,
          capabilities: ["approvals"],
          approvalModes: [...DESKTOP_RUNNER_APPROVAL_MODES],
          models: [{ id: MODEL, label: "Model", reasoningEfforts: ["high"] }],
        },
      ],
      connectedAt: now(),
      lastSeenAt: now(),
    });
    const runIds: string[] = [];
    for (const approvals of DESKTOP_RUNNER_APPROVAL_MODES) {
      const outcome = (
        await control.startRun(startInput(desktopId, approvals, "claude-code"))
      ).unwrap();
      const runId =
        outcome.type === "assigned"
          ? outcome.runId
          : panic(`the run was not assigned: ${outcome.type}`);
      runIds.push(runId);
      const [queued] = await db
        .select({ payload: desktopRunnerCommands.payload })
        .from(desktopRunnerCommands)
        .where(eq(desktopRunnerCommands.runId, runId));
      expect(queued?.payload).toMatchObject({
        type: "run.start",
        policy: { network: "open", fs: "workspace", approvals },
      });
    }
    for (const approvals of ["auto", "full_auto"] as const) {
      expect(
        (await control.startRun(startInput(desktopId, approvals))).unwrap(),
      ).toEqual({ type: "approvals_unavailable" });
    }
    const effortful = (
      await control.startRun({
        ...startInput(desktopId, "ask", "claude-code"),
        reasoningEffort: "high",
      })
    ).unwrap();
    const effortfulId =
      effortful.type === "assigned"
        ? effortful.runId
        : panic(`the run was not assigned: ${effortful.type}`);
    runIds.push(effortfulId);
    const [queuedEffort] = await db
      .select({ payload: desktopRunnerCommands.payload })
      .from(desktopRunnerCommands)
      .where(eq(desktopRunnerCommands.runId, effortfulId));
    expect(queuedEffort?.payload).toMatchObject({
      type: "run.start",
      reasoningEffort: "high",
    });
    // Codex lists no efforts for the model here.
    expect(
      (
        await control.startRun({
          ...startInput(desktopId),
          reasoningEffort: "high",
        })
      ).unwrap(),
    ).toEqual({ type: "reasoning_effort_unavailable" });
    // The account's other tests count its installations and open runs.
    await db
      .delete(desktopRunnerRuns)
      .where(inArray(desktopRunnerRuns.runId, runIds));
    await db
      .delete(desktopRunners)
      .where(eq(desktopRunners.desktopId, desktopId));
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
      isKeyLive,
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
  test("a relink retires the earlier key and ends the runs written to it as relinked, accepted or not", async () => {
    const relinked = await createRlsDesktopCredentials(db, ids);
    const desktopId = Bun.randomUUIDv7();
    const before = await openDesktop(second, desktopId);
    await before.hello();
    // One run the computer took, one written to it that it never took.
    const taken = await assignRun(desktopId);
    await before.receive("run.start", ofRun(taken));
    before.send({ type: "run.accepted", runId: taken });
    before.send(textEvent(taken, 1, "Working"));
    await before.receive("ack", ofRun(taken));
    const untaken = await assignRun(desktopId);
    await before.receive("run.start", ofRun(untaken));
    // The same installation in another organization is another account's
    // runner, which a relink here never touches.
    const elsewhere = await openDesktop(
      second,
      desktopId,
      await upgradeRequest(second, desktopId, credentials.b),
    );
    await elsewhere.hello();

    const after = await openDesktop(
      first,
      desktopId,
      await upgradeRequest(first, desktopId, relinked.a),
    );
    await after.hello();
    expect(await runState(taken)).toMatchObject({
      state: "lost",
      lostReason: "computer_relinked",
    });
    // Written to the old socket, it may have started: send it again.
    expect(await runState(untaken)).toMatchObject({
      state: "lost",
      lostReason: "computer_relinked",
    });
    const rows = (await runnerRows(owner.userId, owner.organizationId)).filter(
      (row) => row.desktopId === desktopId,
    );
    expect(
      Object.fromEntries(
        rows.map(({ deviceJkt, connection }) => [deviceJkt, connection]),
      ),
    ).toEqual({
      [credentials.a.deviceJkt]: "retired",
      [relinked.a.deviceJkt]: "connected",
    });
    expect(
      (await runnerRows(owner.userId, ids.orgB)).filter(
        (row) => row.desktopId === desktopId,
      ),
    ).toEqual([
      {
        desktopId,
        deviceJkt: credentials.b.deviceJkt,
        connection: "connected",
      },
    ]);
    await after.close();
    await elsewhere.close();
    await before.close();
  });

  test("a key claiming an installation never receives another key's runs, and a retired key cannot claim it back", async () => {
    const claiming = await createRlsDesktopCredentials(db, ids);
    const desktopId = Bun.randomUUIDv7();
    const owning = await openDesktop(second, desktopId);
    await owning.hello();
    const runId = await assignRun(desktopId);
    await owning.receive("run.start", ofRun(runId));
    await owning.close();

    // Another credential of the account names the same installation id.
    const claimant = await openDesktop(
      first,
      desktopId,
      await upgradeRequest(first, desktopId, claiming.a),
    );
    await claimant.hello([{ runId, lastSeq: 0 }]);
    expect(
      claimant.received.find(
        (message): message is Extract<typeof message, { type: "welcome" }> =>
          message.type === "welcome",
      )?.resume,
    ).toEqual([]);
    expect(claimant.received.some(ofRun(runId))).toBe(false);
    expect((await runState(runId))?.state).toBe("lost");
    expect((await control.interruptRun({ owner, runId })).unwrap()).toEqual({
      type: "run_ended",
      state: "lost",
    });

    const back = await openDesktop(second, desktopId);
    back.send(helloFrame());
    expect(await back.closed).toEqual({
      code: DESKTOP_RUNNER_CLOSE.superseded.code,
      reason: DESKTOP_RUNNER_CLOSE.superseded.reason,
    });
    await claimant.close();
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
        keyId: credentials.b.keyId,
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
  test("a relink while the earlier key's socket composes a page sends nothing of it", async () => {
    const relinked = await createRlsDesktopCredentials(db, ids);
    const desktopId = Bun.randomUUIDv7();
    const before = await openDesktop(second, desktopId);
    await before.hello();
    const reached = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    mintGate.held = {
      reached,
      release: release.promise.then(() => undefined),
    };
    const runId = await assignRun(desktopId);
    // The socket read the run's start and is minting its token.
    await reached.promise;
    const after = await openDesktop(
      first,
      desktopId,
      await upgradeRequest(first, desktopId, relinked.a),
    );
    await after.hello();
    release.resolve(undefined);
    expect(await before.closed).toEqual({
      code: DESKTOP_RUNNER_CLOSE.superseded.code,
      reason: DESKTOP_RUNNER_CLOSE.superseded.reason,
    });
    expect(before.received.some(ofRun(runId))).toBe(false);
    expect(await runState(runId)).toMatchObject({
      state: "lost",
      lostReason: "not_reached",
      deliveredAt: null,
    });
    await after.close();
  });

  test("a run the earlier key accepted after the relink stays ended", async () => {
    const relinked = await createRlsDesktopCredentials(db, ids);
    const desktopId = Bun.randomUUIDv7();
    const before = await openDesktop(second, desktopId);
    await before.hello();
    const runId = await assignRun(desktopId);
    await before.receive("run.start", ofRun(runId));
    const after = await openDesktop(
      first,
      desktopId,
      await upgradeRequest(first, desktopId, relinked.a),
    );
    await after.hello();
    // Written to the old socket, so the member is told to send it again.
    expect(await runState(runId)).toMatchObject({
      state: "lost",
      lostReason: "computer_relinked",
    });
    // The old socket's acceptance arrives late: refused, the run stays ended.
    before.send({ type: "run.accepted", runId });
    await before.closed;
    expect((await runState(runId))?.state).toBe("lost");
    await after.close();
  });

  test("a relink at the installation cap is admitted: the key it replaces holds no place", async () => {
    const relinked = await createRlsDesktopCredentials(db, ids);
    const account = { userId: owner.userId, organizationId: ids.orgB };
    // Nothing the cap could evict: every installation of the account counts.
    await db
      .update(desktopRunners)
      .set({ connection: "connected" })
      .where(
        and(
          eq(desktopRunners.userId, account.userId),
          eq(desktopRunners.organizationId, account.organizationId),
          eq(desktopRunners.connection, "disconnected"),
        ),
      );
    const desktopId = Bun.randomUUIDv7();
    const placed = (
      await runnerRows(account.userId, account.organizationId)
    ).filter(({ connection }) => connection !== "retired").length;
    const capped = await startInstance("api-relink-cap", sharedDoorbell, {
      limits: { maxRunnersPerAccount: placed + 1 },
    });
    const before = await openDesktop(
      capped,
      desktopId,
      await upgradeRequest(capped, desktopId, credentials.b),
    );
    await before.hello();

    const after = await openDesktop(
      capped,
      desktopId,
      await upgradeRequest(capped, desktopId, relinked.b),
    );
    await after.hello();
    expect(
      (await runnerRows(account.userId, account.organizationId)).filter(
        (row) => row.desktopId === desktopId,
      ),
    ).toEqual(
      expect.arrayContaining([
        {
          desktopId,
          deviceJkt: relinked.b.deviceJkt,
          connection: "connected",
        },
      ]),
    );
    await after.close();
    await before.close();
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

  test("revoking one credential leaves the runner another credential opened on the same device key connected", async () => {
    const fresh = await createRlsDesktopCredentials(db, ids);
    const sibling = await fresh.mint(ids.orgA, fresh.a.device);
    expect(sibling.deviceJkt).toBe(fresh.a.deviceJkt);
    const beating = await startInstance(
      "api-heartbeat-sibling",
      sharedDoorbell,
      {
        timing: { pingIntervalMs: 50 },
      },
    );
    const [revokedId, keptId] = [Bun.randomUUIDv7(), Bun.randomUUIDv7()];
    const revokedDesktop = await openDesktop(
      beating,
      revokedId,
      await upgradeRequest(beating, revokedId, fresh.a),
    );
    await revokedDesktop.hello();
    const keptDesktop = await openDesktop(
      beating,
      keptId,
      await upgradeRequest(beating, keptId, sibling),
    );
    await keptDesktop.hello();
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
    expect(await revokedDesktop.closed).toEqual({
      code: DESKTOP_RUNNER_CLOSE.credentialRevoked.code,
      reason: DESKTOP_RUNNER_CLOSE.credentialRevoked.reason,
    });
    // Only the revoked credential's runner was released; the other
    // credential's runner is still connected and still routed to.
    const connections = new Map(
      (await runnerRows(owner.userId, owner.organizationId)).map(
        ({ desktopId, connection }) => [desktopId, connection],
      ),
    );
    expect([connections.get(revokedId), connections.get(keptId)]).toEqual([
      "disconnected",
      "connected",
    ]);
    const runId = await assignRun(keptId);
    await keptDesktop.receive("run.start", ofRun(runId));
    expect((await control.startRun(startInput(revokedId))).unwrap()).toEqual({
      type: "no_computer",
    });
    await keptDesktop.close();
  });
});

describe("runner feature", () => {
  test("an account without the runner feature is refused before the upgrade and keeps no runner", async () => {
    const desktopId = Bun.randomUUIDv7();
    const openBefore = first.gateway.openSessions();
    await leaveRunnerFeature();
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
      await enrolRunnerFeature();
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
    await leaveRunnerFeature();
    try {
      expect(await desktop.closed).toEqual({
        code: DESKTOP_RUNNER_CLOSE.featureDisabled.code,
        reason: DESKTOP_RUNNER_CLOSE.featureDisabled.reason,
      });
    } finally {
      await enrolRunnerFeature();
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

  test("a run never written to a socket ends as lost once the unaccepted window passes", async () => {
    // A runner the API still counts as connected whose socket is on no task:
    // nothing ever writes the run to it.
    const desktopId = Bun.randomUUIDv7();
    await insertReadyRunner(desktopId);
    const runId = await assignRun(desktopId);
    clock.now += DESKTOP_RUNNER_LIMITS.unacceptedRunMs - 1;
    await first.gateway.sweep();
    // Its lease lapsed without a heartbeat, but it is still open.
    expect((await runState(runId))?.state).toBe("waiting_for_computer");
    clock.now += 1;
    await first.gateway.sweep();
    expect(await runState(runId)).toMatchObject({
      state: "lost",
      deliveredAt: null,
      acceptedAt: null,
    });
    await retireRunner(desktopId);
  });

  test("a run written to its socket survives a drop before its acceptance and completes once the computer is back", async () => {
    const desktopId = Bun.randomUUIDv7();
    const desktop = await openDesktop(first, desktopId);
    await desktop.hello();
    const runId = await assignRun(desktopId);
    // The desktop starts the run, and the connection drops before its
    // acceptance reaches the API.
    await desktop.receive("run.start", ofRun(runId));
    await desktop.close();
    clock.now += DESKTOP_RUNNER_LIMITS.unacceptedRunMs + TIMING.leaseMs + 1;
    await first.gateway.sweep();
    expect(await runState(runId)).toMatchObject({
      state: "waiting_for_computer",
      acceptedAt: null,
    });

    const back = await openDesktop(first, desktopId);
    await back.hello([{ runId, lastSeq: 0 }]);
    expect((await runState(runId))?.state).toBe("running");
    back.send({
      type: "run.finished",
      runId,
      seq: 1,
      outcome: "completed",
      harnessSessionId: null,
    });
    await back.receive("ack", ofRun(runId));
    expect(await runState(runId)).toMatchObject({
      state: "finished",
      outcome: "completed",
    });
    await back.close();
  });

  test("an accepted run whose computer is away waits the abandon window, not the unaccepted one", async () => {
    const { runId, desktop } = await acceptedRun(first);
    desktop.send(textEvent(runId, 1, "Working"));
    await desktop.receive("ack");
    await desktop.close();
    clock.now += DESKTOP_RUNNER_LIMITS.unacceptedRunMs + TIMING.leaseMs + 1;
    await first.gateway.sweep();
    expect((await runState(runId))?.state).toBe("waiting_for_computer");
    clock.now += DESKTOP_RUNNER_LIMITS.abandonedRunMs + 1;
    await first.gateway.sweep();
    expect((await runState(runId))?.state).toBe("lost");
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

  test("a heartbeat between a run's start and its acceptance keeps its token refreshed", async () => {
    const { timers: system } = recordingTimers();
    const beats: (() => void)[] = [];
    const instance = await startInstance("api-token-accept", sharedDoorbell, {
      timers: {
        ...system,
        // Heartbeats run only when the test fires them.
        setInterval: (run, ms) => {
          beats.push(run);
          return system.setInterval(() => undefined, ms);
        },
      },
    });
    const desktopId = Bun.randomUUIDv7();
    const desktop = await openDesktop(instance, desktopId);
    await desktop.hello();
    const beat = beats.at(-1) ?? panic("the socket scheduled no heartbeat");
    const runId = await assignRun(desktopId);
    await desktop.receive("run.start", ofRun(runId));
    // Renewed while the run is started but not accepted yet.
    beat();
    desktop.send({ type: "run.accepted", runId });
    // Frames are handled after that renewal, in order.
    desktop.send(textEvent(runId, 1, "Working"));
    await desktop.receive("ack", ofRun(runId));
    clock.now += 15 * 60_000;
    beat();
    desktop.send(textEvent(runId, 2, "Still working"));
    await desktop.receive("ack", ofRun(runId));
    expect(
      desktop.received.filter(
        (message) => message.type === "run.token" && message.runId === runId,
      ),
    ).toHaveLength(1);
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
    const inputs = Array.from({ length: 4 }, () => ({
      owner,
      runId,
      inputId: Bun.randomUUIDv7(),
      message: { role: "user" as const, content: "More." },
    }));
    // Concurrent commands never pass the cap together: one fits beside the
    // start, the rest are refused.
    const outcomes = await Promise.all(
      inputs.map(async (input) =>
        (await cappedControl.sendInput(input)).unwrap(),
      ),
    );
    expect(outcomes.map(({ type }) => type).toSorted(compareCodeUnit)).toEqual([
      "command_limit",
      "command_limit",
      "command_limit",
      "queued",
    ]);
    // A retry of the queued command stays a duplicate once the run is full.
    const queued =
      inputs.find((_, index) => outcomes[index]?.type === "queued") ??
      panic("one command is queued");
    expect((await cappedControl.sendInput(queued)).unwrap()).toEqual({
      type: "duplicate",
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
    // One read finds runs whose chat turn ended, one finds the socket, one
    // finds sockets with a folder restore queued; its delivery reads one
    // page, which matches the socket's runner in the same statement.
    expect(directReads.count).toBe(4);
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

  test("a sweep delivers a command whose ring was lost however long ago it was queued", async () => {
    const sweeping = await startInstance("api-sweep-old", sharedDoorbell);
    const { runId, desktop } = await acceptedRun(sweeping);
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
          message: { role: "user", content: "Still there?" },
        })
      ).unwrap(),
    ).toEqual({ type: "queued" });
    // Queued long before any sweep window, as after sweeps that failed.
    await db
      .update(desktopRunnerCommands)
      .set({ createdAt: new Date(Date.now() - 24 * 60 * 60_000) })
      .where(eq(desktopRunnerCommands.runId, runId));
    await sweeping.gateway.sweep();
    expect(
      (
        await desktop.receive(
          "run.input",
          (message) =>
            message.type === "run.input" && message.inputId === inputId,
        )
      ).inputId,
    ).toBe(inputId);
    // Once sent, the next sweep finds nothing left to read for the socket:
    // it reads only which runs ended with their chat turn, which sockets have
    // commands queued, and which have a folder restore queued.
    directReads.count = 0;
    await sweeping.gateway.sweep();
    expect(directReads.count).toBe(3);
    await desktop.close();
  });

  test("sockets beyond one page are read on the following pages", async () => {
    const paging = await startInstance("api-sweep-pages", sharedDoorbell);
    const earlier = await acceptedRun(paging);
    const later = await acceptedRun(paging);
    const page = async (afterSessionId: string | null) =>
      await readNewestQueuedCommands(gatewayDb, {
        instanceId: "api-sweep-pages",
        afterSessionId,
        limit: 1,
      });
    const [one] = await page(null);
    const [two] = await page(one?.sessionId ?? panic("no first page"));
    expect(await page(two?.sessionId ?? panic("no second page"))).toEqual([]);
    expect(one?.sessionId).not.toBe(two?.sessionId);
    await earlier.desktop.close();
    await later.desktop.close();
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
    const closing = open[0] ?? panic("two sockets were opened");
    const rest = open.slice(1);
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
      isKeyLive,
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
    const arrival = async (
      matches: (message: DesktopRunnerServerMessage) => boolean,
    ) => {
      const waiter = { matches, arrived: Promise.withResolvers<undefined>() };
      if (sent.some(matches)) {
        waiter.arrived.resolve(undefined);
      } else {
        waiters.add(waiter);
      }
      await waiter.arrived.promise;
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
            // This computer cannot sandbox the harness.
            approvalModes: ["ask"],
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
  test("a run.start the socket could not write keeps the pickup window", async () => {
    // Two runs assigned while no socket wrote them: the next socket's first
    // page holds both starts.
    const desktopId = Bun.randomUUIDv7();
    await insertReadyRunner(desktopId);
    const written = await assignRun(desktopId);
    const unwritten = await assignRun(desktopId);
    const gateway = createDesktopRunnerGateway({
      db: gatewayDb,
      doorbell: sharedDoorbell,
      instanceId: "api-partial-page",
      authorize: authorizeRunnerWith(credentials.authorizeDesktopAccount),
      mintRunToken,
      now,
      random: () => 0.5,
      timing: TIMING,
      isKeyLive,
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
      await gateway.upgrade(await upgradeRequest(first, desktopId), server),
    ).toBeNull();
    const session =
      accepted.session ?? panic("the gateway took the upgrade over");
    const starts: string[] = [];
    const welcomed = Promise.withResolvers<undefined>();
    const socket = asTestRaw<ApiServerWebSocket>({
      send: (text: string) => {
        const message = v.parse(
          desktopRunnerServerMessageSchema,
          JSON.parse(text),
        );
        if (message.type === "welcome") {
          welcomed.resolve(undefined);
        }
        if (message.type !== "run.start") {
          return 1;
        }
        starts.push(message.runId);
        // Bun buffers the first start; the socket takes nothing more.
        return -1;
      },
      close: () => undefined,
      ping: () => undefined,
    });
    session.open(socket);
    clock.now += 1000;
    session.message(socket, JSON.stringify(helloFrame()));
    await welcomed.promise;
    await waitForExternalState({
      description: "the first page was written",
      read: async () => {
        const run = await runState(written);
        return (run?.deliveredAt ?? null) === null ? null : run;
      },
    });
    expect(starts).toEqual([written]);
    expect((await runState(unwritten))?.deliveredAt).toBeNull();

    clock.now += DESKTOP_RUNNER_LIMITS.unacceptedRunMs + 1;
    await gateway.sweep();
    expect(await runState(unwritten)).toMatchObject({
      state: "lost",
      deliveredAt: null,
    });
    expect((await runState(written))?.state).not.toBe("lost");
    session.close(socket, 1000, "done");
    await gateway.drain();
    // Ends the written run, so its installation makes room for later ones.
    await db
      .update(desktopRunnerRuns)
      .set({ state: "lost" })
      .where(eq(desktopRunnerRuns.runId, written));
    await retireRunner(desktopId);
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
      isKeyLive,
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

describe("chat turns on a computer", () => {
  const runBell = createLocalRunBell();
  const CHAT_MODEL = MODEL;
  let chatInstance: Instance;
  /** One computer serves the tests that keep it connected. */
  const computer: { desktopId: string; desktop: FakeDesktop | null } = {
    desktopId: Bun.randomUUIDv7(),
    desktop: null,
  };
  const shared = () => ({
    desktopId: computer.desktopId,
    desktop: computer.desktop ?? panic("the shared computer is not connected"),
  });

  testState.beforeAll(async () => {
    // The account already holds the runners the earlier tests paired.
    chatInstance = await startInstance("api-chat", sharedDoorbell, {
      runBell,
      limits: { maxRunnersPerAccount: 1000 },
    });
    computer.desktop = await openDesktop(chatInstance, computer.desktopId);
    await computer.desktop.hello();
  });

  afterAll(async () => {
    await computer.desktop?.close();
  });

  /** The thread's live turn: the one its run is started for. */
  const liveTurns = new Map<SafeId<"chatThread">, SafeId<"chatTurn">>();
  const turnOf = (chatThreadId: SafeId<"chatThread">) =>
    liveTurns.get(chatThreadId) ?? panic("the thread has no live turn");

  /** Start a running turn answering stored user message `userMessageId`. */
  const openTurn = async (
    chatThreadId: SafeId<"chatThread">,
    userMessageId: SafeId<"chatMessage">,
  ) => {
    const turnId = createSafeId<"chatTurn">();
    await db.insert(chatTurns).values({
      id: turnId,
      organizationId: ids.orgA,
      userId: ids.userA1,
      threadId: chatThreadId,
      userMessageId,
      status: "running",
      executionId: Bun.randomUUIDv7(),
      leaseExpiresAt: new Date(clock.now + DAY_MS),
    });
    liveTurns.set(chatThreadId, turnId);
    return turnId;
  };

  /** Start a running turn on the thread, as a send that claimed it does. */
  const startTurn = async (chatThreadId: SafeId<"chatThread">) => {
    const userMessageId = createSafeId<"chatMessage">();
    await db.insert(chatMessages).values({
      id: userMessageId,
      threadId: chatThreadId,
      userId: ids.userA1,
      role: "user",
      content: toPersistedChatMessageContentV3({
        data: [{ type: "text", content: "Work on the matter" }],
      }),
    });
    return await openTurn(chatThreadId, userMessageId);
  };

  /** End the thread's live turn as `reason` cancels it, with no message. */
  const cancelTurn = async (
    turnId: SafeId<"chatTurn">,
    reason: "superseded" | "user-stop",
  ) => {
    await db
      .update(chatTurns)
      .set({
        status: "cancelled",
        cancellationReason: reason,
        executionId: null,
        leaseExpiresAt: null,
        settledAt: new Date(clock.now),
      })
      .where(eq(chatTurns.id, turnId));
  };

  /** End the thread's live turn as failed, as a send whose store failed does. */
  const failTurn = async (
    chatThreadId: SafeId<"chatThread">,
    turnId: SafeId<"chatTurn">,
  ) => {
    const assistantMessageId = createSafeId<"chatMessage">();
    await db.insert(chatMessages).values({
      id: assistantMessageId,
      threadId: chatThreadId,
      userId: ids.userA1,
      role: "assistant",
      content: toPersistedChatMessageContentV3({ data: [] }),
    });
    await db
      .update(chatTurns)
      .set({
        status: "failed",
        assistantMessageId,
        failureCode: "persistence",
        failureRetryable: true,
        executionId: null,
        leaseExpiresAt: null,
        settledAt: new Date(clock.now),
      })
      .where(eq(chatTurns.id, turnId));
  };

  /** End turn `turnId` as completed with a stored answer, as a send does. */
  const answerTurn = async (
    chatThreadId: SafeId<"chatThread">,
    turnId: SafeId<"chatTurn">,
    text = "The matter holds one brief.",
  ) => {
    const assistantMessageId = createSafeId<"chatMessage">();
    await db.insert(chatMessages).values({
      id: assistantMessageId,
      threadId: chatThreadId,
      userId: ids.userA1,
      role: "assistant",
      content: toPersistedChatMessageContentV3({
        data: [{ type: "text", content: text }],
      }),
    });
    await db
      .update(chatTurns)
      .set({
        status: "completed",
        assistantMessageId,
        executionId: null,
        leaseExpiresAt: null,
        settledAt: new Date(clock.now),
      })
      .where(eq(chatTurns.id, turnId));
  };

  /** The thread's next turn, once its live one ended. */
  const nextTurn = async (chatThreadId: SafeId<"chatThread">) => {
    await cancelTurn(turnOf(chatThreadId), "superseded");
    return await startTurn(chatThreadId);
  };

  const newThread = async () => {
    const id = toSafeId<"chatThread">(Bun.randomUUIDv7());
    await db.insert(chatThreads).values({
      id,
      organizationId: ids.orgA,
      userId: ids.userA1,
      title: "A turn on this computer",
    });
    await startTurn(id);
    return id;
  };

  const contextFor = (chatThreadId: SafeId<"chatThread">): LocalRunContext => ({
    control,
    runBell,
    owner,
    chatThreadId,
    workspaceIds: [],
    mcp: { serverName: "stella", url: "https://api.example.test/mcp" },
    // Rings wake the reader; the poll only bounds a lost one.
    pollMs: 5000,
  });

  const startPlan = (desktopId: string): LocalRunPlan => ({
    type: "start",
    destination: {
      desktopId,
      harness: "codex",
      harnessVersion: HARNESS_VERSION,
      model: CHAT_MODEL,
      reasoningEffort: null,
      approvals: "ask",
      linkedFolderId: null,
    },
  });

  /** The chunks the desktop's own mapper makes of a harness turn. */
  const harnessStreamChunks = async (runId: string, events: HarnessEvent[]) => {
    const source = (async function* () {
      yield* events;
    })();
    const chunks: StreamChunk[] = [];
    let generated = 0;
    for await (const chunk of harnessEventsToChunks(source, {
      harness: "codex",
      model: CHAT_MODEL,
      runId,
      threadId: "desktop-thread",
      workspaceDir: "/workspace",
      generateId: () => {
        generated += 1;
        return `generated-${String(generated)}`;
      },
      now: () => clock.now,
    })) {
      chunks.push(chunk);
    }
    return chunks;
  };
  const harnessChunks = async (
    runId: string,
    events: HarnessEvent[],
  ): Promise<unknown[]> => await harnessStreamChunks(runId, events);

  /** The fake desktop's side of one run: every message takes the next position. */
  const desktopRun = (desktop: FakeDesktop, runId: string, from = 0) => {
    const position = { seq: from };
    const sendAcked = async (message: Record<string, unknown>) => {
      position.seq += 1;
      const seq = position.seq;
      desktop.send({ ...message, runId, seq });
      await desktop.receive(
        "ack",
        (ack) => ack.type === "ack" && ack.runId === runId && ack.seq === seq,
      );
    };
    return {
      position,
      events: async (chunks: readonly unknown[]) => {
        for (const chunk of chunks) {
          await sendAcked({ type: "run.event", chunk });
        }
      },
      approvalRequest: async (requestId: string) => {
        await sendAcked({
          type: "run.approval_request",
          requestId,
          kind: "command",
          summary: "Run the test suite",
        });
      },
      finish: async (
        outcome: "completed" | "interrupted" | "limit_reached" | "needs_login",
        sessionId: string | null,
      ) => {
        await sendAcked({
          type: "run.finished",
          outcome,
          harnessSessionId: sessionId,
        });
      },
    };
  };

  /** Read a stream to its end in the background. */
  const collect = (stream: AsyncIterable<PublicStreamChunk>) => {
    const chunks: PublicStreamChunk[] = [];
    const done = (async () => {
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      return chunks;
    })();
    return { chunks, done };
  };

  /**
   * What a chunk says once its run, thread and call names are set aside, and
   * the call ownership the API stamps on every call of a local turn.
   */
  const meaning = (chunk: unknown) => {
    if (!isRecord(chunk)) {
      return chunk;
    }
    const {
      runId: _runId,
      threadId: _threadId,
      toolCallId: _toolCallId,
      outcome,
      ...stamped
    } = chunk;
    const metadata = stamped["metadata"];
    const rest =
      isRecord(metadata) &&
      metadata[CHAT_TOOL_EXECUTOR_METADATA_KEY] === CHAT_TOOL_EXECUTOR.harness
        ? {
            ...stamped,
            metadata: Object.fromEntries(
              Object.entries(metadata).filter(
                ([key]) => key !== CHAT_TOOL_EXECUTOR_METADATA_KEY,
              ),
            ),
          }
        : stamped;
    return isRecord(outcome) && Array.isArray(outcome["interrupts"])
      ? {
          ...rest,
          outcome: {
            ...outcome,
            interrupts: outcome["interrupts"].map((interrupt: unknown) => {
              if (!isRecord(interrupt)) {
                return interrupt;
              }
              const { toolCallId: _callId, ...kept } = interrupt;
              return kept;
            }),
          },
        }
      : { ...rest, ...(outcome === undefined ? {} : { outcome }) };
  };

  const isComputerEvent = (chunk: unknown) =>
    isRecord(chunk) &&
    chunk["type"] === EventType.CUSTOM &&
    chunk["name"] === CHAT_LOCAL_RUN_COMPUTER_EVENT;

  const computerStatus = (chunk: unknown) =>
    v.parse(
      chatLocalRunComputerEventSchema,
      isRecord(chunk) ? chunk["value"] : undefined,
    ).status;

  const withoutRunStarts = (chunks: readonly unknown[]) =>
    chunks.filter(
      (chunk) => !isRecord(chunk) || chunk["type"] !== EventType.RUN_STARTED,
    );

  const toolCallIdsOf = (chunks: readonly unknown[]) =>
    chunks.flatMap((chunk) =>
      isRecord(chunk) && typeof chunk["toolCallId"] === "string"
        ? [chunk["toolCallId"]]
        : [],
    );

  const completedTurn: HarnessEvent[] = [
    {
      type: "session.started",
      sessionId: harnessSessionId("codex-session-1"),
      continuation: { type: "fresh" },
    },
    {
      type: "tool.started",
      toolCall: {
        id: "item_1",
        name: "command_execution",
        input: { command: "ls" },
      },
    },
    {
      type: "tool.completed",
      toolCall: {
        id: "item_1",
        name: "command_execution",
        input: { command: "ls" },
      },
      result: { content: "brief.docx", status: "succeeded" },
    },
    { type: "text.delta", messageId: "msg_1", delta: "The matter holds " },
    {
      type: "text.completed",
      messageId: "msg_1",
      text: "The matter holds one brief.",
    },
    {
      type: "turn.completed",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 0,
        context: { usedTokens: 15, windowTokens: 200_000 },
      },
    },
  ];

  test("a turn streams what the harness produced and starts the run for the thread", async () => {
    const chatThreadId = await newThread();
    const { desktopId, desktop } = shared();
    const turn = collect(
      createLocalChatRun(contextFor(chatThreadId), startPlan(desktopId)).stream(
        {
          chatRunId: "chat-run-1",
          chatTurnId: turnOf(chatThreadId),
          messages: [{ role: "user", content: "What does the matter hold?" }],
          instructions: "You are stella.",
          resume: undefined,
          abortSignal: new AbortController().signal,
        },
      ),
    );
    const start = await desktop.receive("run.start");
    expect(start).toMatchObject({
      harness: "codex",
      model: CHAT_MODEL,
      harnessSessionId: null,
      instructions: "You are stella.",
      messages: [{ role: "user", content: "What does the matter hold?" }],
    });
    const [linked] = await db
      .select({ chatThreadId: desktopRunnerRuns.chatThreadId })
      .from(desktopRunnerRuns)
      .where(eq(desktopRunnerRuns.runId, start.runId));
    expect(linked?.chatThreadId).toBe(chatThreadId);

    desktop.send({ type: "run.accepted", runId: start.runId });
    const run = desktopRun(desktop, start.runId);
    const sent = await harnessChunks(start.runId, completedTurn);
    await run.events(sent);
    await run.finish("completed", "codex-session-1");
    const chunks = await turn.done;

    expect(chunks.at(0)).toMatchObject({
      type: EventType.RUN_STARTED,
      runId: "chat-run-1",
      threadId: chatThreadId,
    });
    expect(
      chunks.filter(({ type }) => type === EventType.RUN_STARTED),
    ).toHaveLength(1);
    // The chat is told the run waits for the computer until it has it.
    expect(chunks.filter(isComputerEvent).map(computerStatus)).toEqual([
      "delivering",
      "connected",
    ]);
    expect(
      withoutRunStarts(chunks)
        .filter((chunk) => !isComputerEvent(chunk))
        .map(meaning),
    ).toEqual(withoutRunStarts(sent).map(meaning));
    expect(chunks.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      runId: "chat-run-1",
      threadId: chatThreadId,
    });
    // Call ids are the run's own, so they cannot collide with the thread's.
    const callIds = new Set(toolCallIdsOf(chunks));
    expect(callIds.size).toBe(1);
    expect(callIds.has("item_1")).toBe(false);
  });

  describe("what a computer may say about a turn's files and message", () => {
    const answer = async (
      chatThreadId: SafeId<"chatThread">,
      send: (
        runId: string,
        run: ReturnType<typeof desktopRun>,
      ) => Promise<void>,
    ) => {
      const { desktopId, desktop } = shared();
      const turn = collect(
        createLocalChatRun(
          contextFor(chatThreadId),
          startPlan(desktopId),
        ).stream({
          chatRunId: "chat-run-files",
          chatTurnId: turnOf(chatThreadId),
          messages: [{ role: "user", content: "Write the report." }],
          instructions: "You are stella.",
          resume: undefined,
          abortSignal: new AbortController().signal,
        }),
      );
      const start = await desktop.receive("run.start");
      desktop.send({ type: "run.accepted", runId: start.runId });
      const run = desktopRun(desktop, start.runId);
      await send(start.runId, run);
      await run.finish("completed", "codex-session-files");
      return await turn.done;
    };

    const storedFile = async (
      threadId: SafeId<"chatThread">,
      userId: string,
      organizationId: SafeId<"organization"> = ids.orgA,
    ) => {
      const id = createSafeId<"userFile">();
      await db.insert(userFiles).values({
        id,
        userId,
        fileName: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        sha256Hex: "a".repeat(64),
        s3Key: createUserFileKey({
          fileId: id,
          mimeType: "application/pdf",
          organizationId,
        }),
        threadId,
      });
      return id;
    };

    const report = (value: unknown) => ({
      type: EventType.CUSTOM,
      name: DESKTOP_RUNNER_OUTPUT_EVENT,
      value,
    });

    /** What the server told the answer about files, each time it said so. */
    const answerMetadata = (chunks: readonly unknown[]) =>
      chunks.flatMap((chunk) =>
        isRecord(chunk) &&
        chunk["type"] === EventType.TEXT_MESSAGE_START &&
        isRecord(chunk["metadata"]) &&
        (CHAT_LOCAL_RUN_FILES_METADATA_KEY in chunk["metadata"] ||
          CHAT_LOCAL_RUN_FILES_NOT_SHARED_METADATA_KEY in chunk["metadata"])
          ? [chunk["metadata"]]
          : [],
      );

    test("a reported file of this thread reaches the chat as the server read it", async () => {
      const chatThreadId = await newThread();
      const fileId = await storedFile(chatThreadId, ids.userA1);
      const chunks = await answer(chatThreadId, async (_runId, run) => {
        await run.events([
          // The desktop's name and type are not what the chat is told.
          report({ status: "uploaded", fileId, fileName: "forged.exe" }),
        ]);
      });
      expect(answerMetadata(chunks)).toEqual([
        {
          [CHAT_LOCAL_RUN_FILES_METADATA_KEY]: [
            {
              url: `${USER_FILE_URL_PREFIX}${fileId}`,
              filename: "report.pdf",
              mimeType: "application/pdf",
            },
          ],
        },
      ]);
    });

    test("another member's file and another thread's file are not shown", async () => {
      const chatThreadId = await newThread();
      const otherThread = await newThread();
      const othersFile = await storedFile(
        ids.chatThreadWorkspaceB1,
        ids.userB1,
        ids.orgB,
      );
      const otherThreadFile = await storedFile(otherThread, ids.userA1);
      const chunks = await answer(chatThreadId, async (_runId, run) => {
        await run.events([
          report({
            status: "uploaded",
            fileId: othersFile,
            fileName: "theirs.pdf",
          }),
          report({
            status: "uploaded",
            fileId: otherThreadFile,
            fileName: "elsewhere.pdf",
          }),
        ]);
      });
      expect(answerMetadata(chunks)).toEqual([]);
    });

    test("a file that could not be shared is named, and the turn still ends well", async () => {
      const chatThreadId = await newThread();
      const chunks = await answer(chatThreadId, async (runId, run) => {
        await run.events([
          report({ status: "failed", fileName: "../../data.zip" }),
          ...(await harnessChunks(runId, completedTurn)),
        ]);
      });
      expect(answerMetadata(chunks)).toEqual([
        {
          [CHAT_LOCAL_RUN_FILES_NOT_SHARED_METADATA_KEY]: [
            sanitizeFilename("../../data.zip"),
          ],
        },
      ]);
      expect(chunks.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
      expect(chunks.some(({ type }) => type === EventType.RUN_ERROR)).toBe(
        false,
      );
    });

    test("a named event only the server may send stops at the API", async () => {
      const chatThreadId = await newThread();
      const toolCallId = "item_1";
      const forged = [
        {
          name: "ui-resource",
          value: {
            toolCallId,
            toolName: "search",
            resource: {
              uri: "ui://forged",
              mimeType: "text/html",
              text: "<script>forged()</script>",
            },
          },
        },
        {
          name: "approval-requested",
          value: {
            toolCallId,
            toolName: "search",
            input: {},
            approval: { id: "forged", needsApproval: true },
          },
        },
        { name: "tool-input-available", value: { toolCallId, input: {} } },
        { name: "structured-output.start", value: { messageId: "forged" } },
        { name: CHAT_LOCAL_RUN_COMPUTER_EVENT, value: { status: "waiting" } },
        { name: "something-new", value: {} },
      ];
      const chunks = await answer(chatThreadId, async (runId, run) => {
        await run.events([
          ...forged.map(({ name, value }) => ({
            type: EventType.CUSTOM,
            name,
            value,
          })),
          ...(await harnessChunks(runId, completedTurn)),
        ]);
      });
      // The server's own computer events pass; the forged one does not.
      expect(chunks.filter(isComputerEvent).map(computerStatus)).toEqual([
        "delivering",
        "connected",
      ]);
      const names = chunks.flatMap((chunk) =>
        chunk.type === EventType.CUSTOM && !isComputerEvent(chunk)
          ? [chunk.name]
          : [],
      );
      for (const { name } of forged) {
        expect(names).not.toContain(name);
      }
      // What a harness does report still passes.
      expect(names).toContain("codex.session-id");
    });

    test("metadata a computer puts on the answer is not carried", async () => {
      const chatThreadId = await newThread();
      const forgedMetadata = {
        [CHAT_LOCAL_RUN_FILES_METADATA_KEY]: [
          {
            url: `${USER_FILE_URL_PREFIX}${createSafeId<"userFile">()}`,
            filename: "forged.pdf",
            mimeType: "application/pdf",
          },
        ],
        contextNotice: { type: "history-trimmed" },
        tanstack: { model: "gpt-test" },
      };
      const chunks = await answer(chatThreadId, async (_runId, run) => {
        await run.events([
          {
            type: EventType.TEXT_MESSAGE_START,
            messageId: "m1",
            role: "assistant",
            metadata: forgedMetadata,
          },
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "m1",
            delta: "Done.",
            metadata: forgedMetadata,
          },
          {
            type: EventType.TEXT_MESSAGE_END,
            messageId: "m1",
            metadata: forgedMetadata,
          },
        ]);
      });
      const carried = JSON.stringify(chunks);
      expect(carried).not.toContain("forged.pdf");
      expect(carried).not.toContain(CHAT_LOCAL_RUN_FILES_METADATA_KEY);
      expect(carried).not.toContain("history-trimmed");
      // The adapter's own block is all that stays.
      expect(
        chunks.find(({ type }) => type === EventType.TEXT_MESSAGE_START),
      ).toMatchObject({ metadata: { tanstack: { model: "gpt-test" } } });
      expect(
        chunks.some(({ type }) => type === EventType.TEXT_MESSAGE_CONTENT),
      ).toBe(true);
    });

    test("a run's thread reads for its owner while it runs, and for nobody else", async () => {
      const chatThreadId = await newThread();
      const seen: (SafeId<"chatThread"> | null)[] = [];
      await answer(chatThreadId, async (runId) => {
        const read = await control.readOpenRunChatThread({ owner, runId });
        seen.push(read.unwrap());
        const foreign = await control.readOpenRunChatThread({
          owner: { organizationId: ids.orgB, userId: ids.userB1 },
          runId,
        });
        seen.push(foreign.unwrap());
      });
      expect(seen).toEqual([chatThreadId, null]);
    });
  });

  test("a finished run's context report reaches the turn, and one the desktop made up does not", async () => {
    const finishedTurn = async (
      rewrite: (chunk: unknown) => unknown,
    ): Promise<unknown> => {
      const chatThreadId = await newThread();
      const { desktopId, desktop } = shared();
      const turn = collect(
        createLocalChatRun(
          contextFor(chatThreadId),
          startPlan(desktopId),
        ).stream({
          chatRunId: Bun.randomUUIDv7(),
          chatTurnId: turnOf(chatThreadId),
          messages: [{ role: "user", content: "What does the matter hold?" }],
          instructions: "You are stella.",
          resume: undefined,
          abortSignal: new AbortController().signal,
        }),
      );
      const start = await desktop.receive("run.start");
      desktop.send({ type: "run.accepted", runId: start.runId });
      const run = desktopRun(desktop, start.runId);
      await run.events(
        (await harnessChunks(start.runId, completedTurn)).map(rewrite),
      );
      await run.finish("completed", "codex-session-1");
      const finish = (await turn.done).findLast(
        ({ type }) => type === EventType.RUN_FINISHED,
      );
      return finish?.metadata?.[CHAT_LOCAL_RUN_CONTEXT_METADATA_KEY];
    };
    const withReport = (report: unknown) => (chunk: unknown) =>
      isRecord(chunk) && chunk["type"] === EventType.RUN_FINISHED
        ? {
            ...chunk,
            metadata: {
              ...(isRecord(chunk["metadata"]) ? chunk["metadata"] : {}),
              [CHAT_LOCAL_RUN_CONTEXT_METADATA_KEY]: report,
            },
          }
        : chunk;

    expect(await finishedTurn((chunk) => chunk)).toEqual({
      usedTokens: 15,
      windowTokens: 200_000,
    });
    for (const forged of [
      { usedTokens: 15, windowTokens: 200_000, label: "<b>full</b>" },
      { usedTokens: 1.5, windowTokens: 200_000 },
      { usedTokens: 15 },
    ]) {
      expect(await finishedTurn(withReport(forged))).toBeUndefined();
    }
  });

  test("the thread's next turn on the same computer resumes the harness session", async () => {
    const chatThreadId = await newThread();
    const { desktopId, desktop } = shared();
    const local = createLocalChatRun(
      contextFor(chatThreadId),
      startPlan(desktopId),
    );
    const firstTurn = collect(
      local.stream({
        chatRunId: "chat-run-first",
        chatTurnId: turnOf(chatThreadId),
        messages: [{ role: "user", content: "First" }],
        instructions: "You are stella.",
        resume: undefined,
        abortSignal: new AbortController().signal,
      }),
    );
    const firstStart = await desktop.receive("run.start");
    desktop.send({ type: "run.accepted", runId: firstStart.runId });
    const firstRun = desktopRun(desktop, firstStart.runId);
    await firstRun.events(await harnessChunks(firstStart.runId, completedTurn));
    await firstRun.finish("completed", "codex-session-1");
    await firstTurn.done;
    await answerTurn(chatThreadId, turnOf(chatThreadId));

    const secondTurnId = await startTurn(chatThreadId);
    const secondTurn = collect(
      local.stream({
        chatRunId: "chat-run-second",
        chatTurnId: secondTurnId,
        messages: [
          { role: "user", content: "First" },
          { role: "assistant", content: "The matter holds one brief." },
          { role: "user", content: "Second" },
        ],
        instructions: "You are stella.",
        resume: undefined,
        abortSignal: new AbortController().signal,
      }),
    );
    const secondStart = await desktop.receive(
      "run.start",
      (message) =>
        message.type === "run.start" && message.runId !== firstStart.runId,
    );
    expect(secondStart.harnessSessionId).toBe("codex-session-1");
    expect(firstStart.folderId).toBe(chatThreadId);
    expect(secondStart.folderId).toBe(chatThreadId);
    desktop.send({ type: "run.accepted", runId: secondStart.runId });
    const secondRun = desktopRun(desktop, secondStart.runId);
    await secondRun.events(
      await harnessChunks(secondStart.runId, completedTurn.slice(3)),
    );
    await secondRun.finish("completed", "codex-session-1");
    expect((await secondTurn.done).at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  describe("which harness session a turn resumes", () => {
    const answerText = "The matter holds one brief.";

    /** The stored user message turn `turnId` answers. */
    const askedBy = async (turnId: SafeId<"chatTurn">) =>
      (
        await db
          .select({ userMessageId: chatTurns.userMessageId })
          .from(chatTurns)
          .where(eq(chatTurns.id, turnId))
      ).at(0)?.userMessageId ?? panic("the turn is not stored");

    /**
     * Run turn `turnId` on the shared computer to its end, with the harness
     * leaving session `sessionId`, and store its answer as the send does.
     * Returns the session the run was started to resume.
     */
    const runTurn = async (
      chatThreadId: SafeId<"chatThread">,
      turnId: SafeId<"chatTurn">,
      sessionId: string,
    ) => {
      const { desktopId, desktop } = shared();
      const turn = collect(
        createLocalChatRun(
          contextFor(chatThreadId),
          startPlan(desktopId),
        ).stream({
          chatRunId: `chat-run-${turnId}`,
          chatTurnId: turnId,
          messages: [{ role: "user", content: "Work on the matter" }],
          instructions: "You are stella.",
          resume: undefined,
          abortSignal: new AbortController().signal,
        }),
      );
      // Each start for the thread is read by the turn that caused it.
      const start = await desktop.receive(
        "run.start",
        (message) =>
          message.type === "run.start" && message.folderId === chatThreadId,
      );
      const { runId } = start;
      desktop.send({ type: "run.accepted", runId });
      const run = desktopRun(desktop, runId);
      await run.events(await harnessChunks(runId, completedTurn.slice(3)));
      await run.finish("completed", sessionId);
      expect((await turn.done).at(-1)?.type).toBe(EventType.RUN_FINISHED);
      await answerTurn(chatThreadId, turnId, answerText);
      return start.harnessSessionId;
    };

    /**
     * Replay the thread from user message `messageId`, as an edit or a
     * regeneration does when it is sent: the send's own resolution names
     * every later message, which goes, the message is written again, and a
     * new turn answers it.
     */
    const replayFrom = async (
      chatThreadId: SafeId<"chatThread">,
      messageId: SafeId<"chatMessage">,
      text: string,
    ) => {
      const target =
        (
          await resolveTruncationTarget({
            safeDb: toSafeDbMock(
              asTestRaw<ScopedDb>(
                async (callback: (tx: typeof db) => Promise<unknown>) =>
                  await db.transaction(
                    async (tx) => await callback(asTestRaw(tx)),
                  ),
              ),
            ),
            threadId: chatThreadId,
            targetMessageId: messageId,
          })
        ).unwrap() ?? panic("the message is not in the thread");
      await db
        .delete(chatMessages)
        .where(
          and(
            eq(chatMessages.threadId, chatThreadId),
            inArray(chatMessages.id, target.deleteMessageIdsBeforeLatest),
          ),
        );
      await db
        .update(chatMessages)
        .set({
          content: toPersistedChatMessageContentV3({
            data: [{ type: "text", content: text }],
          }),
        })
        .where(eq(chatMessages.id, messageId));
      return await openTurn(chatThreadId, messageId);
    };

    /** A thread whose first turn ran on the shared computer and left `sessionId`. */
    const answeredThread = async (sessionId: string) => {
      const chatThreadId = await newThread();
      const firstTurnId = turnOf(chatThreadId);
      expect(await runTurn(chatThreadId, firstTurnId, sessionId)).toBeNull();
      return { chatThreadId, firstTurnId };
    };

    test("a plain follow-up resumes the session the previous answer left", async () => {
      const { chatThreadId } = await answeredThread("codex-session-plain");
      const secondTurnId = await startTurn(chatThreadId);
      expect(
        await runTurn(chatThreadId, secondTurnId, "codex-session-plain"),
      ).toBe("codex-session-plain");
      const thirdTurnId = await startTurn(chatThreadId);
      expect(
        await runTurn(chatThreadId, thirdTurnId, "codex-session-plain"),
      ).toBe("codex-session-plain");
    });

    test("an edited earlier message starts a fresh session", async () => {
      const { chatThreadId, firstTurnId } = await answeredThread(
        "codex-session-edited",
      );
      const secondTurnId = await startTurn(chatThreadId);
      expect(
        await runTurn(chatThreadId, secondTurnId, "codex-session-edited"),
      ).toBe("codex-session-edited");

      const edited = await replayFrom(
        chatThreadId,
        await askedBy(firstTurnId),
        "Work on the other matter",
      );
      expect(
        await runTurn(chatThreadId, edited, "codex-session-new"),
      ).toBeNull();
      // The fresh session is the one the edited history continues.
      const followUp = await startTurn(chatThreadId);
      expect(await runTurn(chatThreadId, followUp, "codex-session-new")).toBe(
        "codex-session-new",
      );
    });

    test("an edit of an answered message in the middle starts fresh", async () => {
      const { chatThreadId } = await answeredThread("codex-session-middle");
      const secondTurnId = await startTurn(chatThreadId);
      await runTurn(chatThreadId, secondTurnId, "codex-session-middle");
      const thirdTurnId = await startTurn(chatThreadId);
      await runTurn(chatThreadId, thirdTurnId, "codex-session-middle");

      // The answer right before the edited message is still the first run's.
      const edited = await replayFrom(
        chatThreadId,
        await askedBy(secondTurnId),
        "Work on the other matter",
      );
      expect(
        await runTurn(chatThreadId, edited, "codex-session-middle-new"),
      ).toBeNull();
    });

    test("a regenerated answer starts a fresh session", async () => {
      const { chatThreadId } = await answeredThread("codex-session-regen");
      const secondTurnId = await startTurn(chatThreadId);
      await runTurn(chatThreadId, secondTurnId, "codex-session-regen");

      const regenerated = await replayFrom(
        chatThreadId,
        await askedBy(secondTurnId),
        "Work on the matter",
      );
      expect(
        await runTurn(chatThreadId, regenerated, "codex-session-regen-new"),
      ).toBeNull();
    });

    /**
     * Run turn `turnId` on the shared computer to a run that ends without an
     * answer after sending `chunks`, and settle the turn as failed, as the
     * send does. Returns the session the run was started to resume.
     */
    const failedRunTurn = async (
      chatThreadId: SafeId<"chatThread">,
      turnId: SafeId<"chatTurn">,
      chunks: (runId: string) => Promise<unknown[]>,
      outcome: "interrupted" | "needs_login",
    ) => {
      const { desktopId, desktop } = shared();
      const turn = collect(
        createLocalChatRun(
          contextFor(chatThreadId),
          startPlan(desktopId),
        ).stream({
          chatRunId: `chat-run-${turnId}`,
          chatTurnId: turnId,
          messages: [{ role: "user", content: "Work on the matter" }],
          instructions: "You are stella.",
          resume: undefined,
          abortSignal: new AbortController().signal,
        }),
      );
      const start = await desktop.receive(
        "run.start",
        (message) =>
          message.type === "run.start" && message.folderId === chatThreadId,
      );
      desktop.send({ type: "run.accepted", runId: start.runId });
      const run = desktopRun(desktop, start.runId);
      await run.events(await chunks(start.runId));
      await run.finish(outcome, null);
      await turn.done;
      await failTurn(chatThreadId, turnId);
      return start.harnessSessionId;
    };

    test("a run that never reached its prompt does not hide the session before it", async () => {
      const { chatThreadId } = await answeredThread("codex-session-kept");
      const secondTurnId = await startTurn(chatThreadId);
      // The second turn's run ends before the harness took its prompt.
      expect(
        await failedRunTurn(
          chatThreadId,
          secondTurnId,
          async () => [],
          "needs_login",
        ),
      ).toBe("codex-session-kept");

      // Sending that turn again continues the first answer, so it resumes
      // the session the first run left.
      const again = await replayFrom(
        chatThreadId,
        await askedBy(secondTurnId),
        "Work on the matter",
      );
      expect(await runTurn(chatThreadId, again, "codex-session-kept")).toBe(
        "codex-session-kept",
      );
    });

    test("a run lost before its session was named starts the retry fresh", async () => {
      const { chatThreadId } = await answeredThread("codex-session-lost");
      const secondTurnId = await startTurn(chatThreadId);
      await failedRunTurn(
        chatThreadId,
        secondTurnId,
        async () => [],
        "needs_login",
      );
      // As if the computer went quiet after the harness took the prompt and
      // before the session's id arrived: the run is lost with no session.
      await db
        .update(desktopRunnerRuns)
        .set({ state: "lost", outcome: null, harnessSessionId: null })
        .where(eq(desktopRunnerRuns.chatTurnId, secondTurnId));

      const again = await replayFrom(
        chatThreadId,
        await askedBy(secondTurnId),
        "Work on the matter",
      );
      expect(
        await runTurn(chatThreadId, again, "codex-session-lost-new"),
      ).toBeNull();
    });

    test("a run whose session took its prompt and ended unnamed starts the retry fresh", async () => {
      const { chatThreadId } = await answeredThread("codex-session-taken");
      const secondTurnId = await startTurn(chatThreadId);
      // The session took the prompt; the run then ended without naming it,
      // so the session may hold work the chat never stored.
      expect(
        await failedRunTurn(
          chatThreadId,
          secondTurnId,
          async (runId) =>
            // What the desktop sent before it went quiet: no end of the turn.
            (
              await harnessChunks(runId, [
                {
                  type: "session.started",
                  sessionId: harnessSessionId("codex-session-taken"),
                  continuation: { type: "resumed" },
                },
              ])
            ).filter(
              (chunk) =>
                isRecord(chunk) && chunk["type"] !== EventType.RUN_ERROR,
            ),
          "interrupted",
        ),
      ).toBe("codex-session-taken");

      const again = await replayFrom(
        chatThreadId,
        await askedBy(secondTurnId),
        "Work on the matter",
      );
      expect(
        await runTurn(chatThreadId, again, "codex-session-taken-new"),
      ).toBeNull();
    });

    test("an answer from elsewhere in between starts a fresh session", async () => {
      const { chatThreadId } = await answeredThread("codex-session-cloud");
      // A turn answered in the cloud: the computer's session never saw it.
      const cloudTurnId = await startTurn(chatThreadId);
      await answerTurn(chatThreadId, cloudTurnId, "Answered in the cloud.");
      const nextTurnId = await startTurn(chatThreadId);
      expect(
        await runTurn(chatThreadId, nextTurnId, "codex-session-cloud-new"),
      ).toBeNull();
    });

    test("a revised answer starts a fresh session", async () => {
      const { chatThreadId, firstTurnId } = await answeredThread(
        "codex-session-revised",
      );
      const [answered] = await db
        .select({
          id: chatMessages.id,
          content: chatMessages.content,
        })
        .from(chatMessages)
        .innerJoin(chatTurns, eq(chatTurns.assistantMessageId, chatMessages.id))
        .where(eq(chatTurns.id, firstTurnId));
      const answer = answered ?? panic("the first turn stored no answer");
      // The revision keeps the replaced text; the message takes the new one.
      await db.insert(chatMessageRevisions).values({
        messageId: answer.id,
        threadId: chatThreadId,
        revision: 0,
        content: answer.content,
        edit: {
          type: "ai_span",
          start: 17,
          end: 27,
          instruction: "Say it holds none",
          model: CHAT_MODEL,
          keySource: "instance",
        },
        createdBy: ids.userA1,
      });
      await db
        .update(chatMessages)
        .set({
          content: toPersistedChatMessageContentV3({
            data: [{ type: "text", content: "The matter holds no brief." }],
          }),
          revision: 1,
        })
        .where(eq(chatMessages.id, answer.id));
      const nextTurnId = await startTurn(chatThreadId);
      expect(
        await runTurn(chatThreadId, nextTurnId, "codex-session-revised-new"),
      ).toBeNull();
    });

    test("a fork does not resume the session of the thread it was forked from", async () => {
      const { chatThreadId } = await answeredThread("codex-session-parent");
      // The fork copies the history under new ids and keeps its timestamps.
      const forkId = toSafeId<"chatThread">(Bun.randomUUIDv7());
      await db.insert(chatThreads).values({
        id: forkId,
        organizationId: ids.orgA,
        userId: ids.userA1,
        title: "A fork",
        parentThreadId: chatThreadId,
      });
      const history = await db
        .select({
          role: chatMessages.role,
          content: chatMessages.content,
          createdAt: chatMessages.createdAt,
        })
        .from(chatMessages)
        .where(eq(chatMessages.threadId, chatThreadId))
        .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
      await db.insert(chatMessages).values(
        history.map((row) => ({
          ...row,
          id: createSafeId<"chatMessage">(),
          threadId: forkId,
          userId: ids.userA1,
        })),
      );
      const forkTurnId = await startTurn(forkId);
      expect(
        await runTurn(forkId, forkTurnId, "codex-session-fork"),
      ).toBeNull();
      const forkFollowUp = await startTurn(forkId);
      expect(await runTurn(forkId, forkFollowUp, "codex-session-fork")).toBe(
        "codex-session-fork",
      );
      // The parent goes on with its own session.
      const parentFollowUp = await startTurn(chatThreadId);
      expect(
        await runTurn(chatThreadId, parentFollowUp, "codex-session-parent"),
      ).toBe("codex-session-parent");
    });
  });

  test("an approval pauses the turn, and its answer continues the same run", async () => {
    const chatThreadId = await newThread();
    const { desktopId, desktop } = shared();
    const requestId = Bun.randomUUIDv7();
    const pausedTurn = collect(
      createLocalChatRun(contextFor(chatThreadId), startPlan(desktopId)).stream(
        {
          chatRunId: "chat-run-paused",
          chatTurnId: turnOf(chatThreadId),
          messages: [{ role: "user", content: "Run the tests" }],
          instructions: "You are stella.",
          resume: undefined,
          abortSignal: new AbortController().signal,
        },
      ),
    );
    const start = await desktop.receive("run.start");
    desktop.send({ type: "run.accepted", runId: start.runId });
    const toolCall = {
      id: "item_7",
      name: "command_execution",
      input: { command: "bun test" },
    };
    const sent = await harnessChunks(start.runId, [
      {
        type: "session.started",
        sessionId: harnessSessionId("codex-session-7"),
        continuation: { type: "fresh" },
      },
      {
        type: "approval.requested",
        request: {
          requestId,
          kind: "command",
          toolCall,
          reason: "Run the test suite",
          options: [
            { id: "accept", decision: "approve" },
            { id: "decline", decision: "deny" },
          ],
        },
      },
      { type: "interaction.resolved", requestId },
      {
        type: "tool.completed",
        toolCall,
        result: { content: "12 pass", status: "succeeded" },
      },
      { type: "text.completed", messageId: "msg_9", text: "All tests pass." },
      { type: "turn.completed", usage: null },
    ]);
    const pauseAt =
      sent.findIndex(
        (chunk) =>
          isRecord(chunk) &&
          chunk["type"] === EventType.RUN_FINISHED &&
          isRecord(chunk["outcome"]) &&
          chunk["outcome"]["type"] === "interrupt",
      ) + 1;
    expect(pauseAt).toBeGreaterThan(0);
    const run = desktopRun(desktop, start.runId);
    await run.approvalRequest(requestId);
    await run.events(sent.slice(0, pauseAt));
    const paused = await pausedTurn.done;
    expect(paused.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      runId: "chat-run-paused",
      outcome: { type: "interrupt", interrupts: [{ id: requestId }] },
    });
    // The pause is where the resumed turn continues.
    const [stored] = await db
      .select({ chatReadSeq: desktopRunnerRuns.chatReadSeq })
      .from(desktopRunnerRuns)
      .where(eq(desktopRunnerRuns.runId, start.runId));
    expect(stored?.chatReadSeq).toBe(run.position.seq);

    const resumedTurn = collect(
      createLocalChatRun(contextFor(chatThreadId), {
        type: "resume",
        harness: "codex",
      }).stream({
        chatRunId: "chat-run-resumed",
        chatTurnId: turnOf(chatThreadId),
        messages: [],
        instructions: "You are stella.",
        resume: [
          {
            interruptId: requestId,
            status: "resolved",
            payload: { approved: true },
          },
        ],
        abortSignal: new AbortController().signal,
      }),
    );
    const answer = await desktop.receive("run.approval", ofRun(start.runId));
    expect(answer).toMatchObject({ requestId, decision: "approve" });
    await run.events(sent.slice(pauseAt));
    await run.finish("completed", "codex-session-7");
    const resumed = await resumedTurn.done;

    expect(withoutRunStarts(resumed).map(meaning)).toEqual(
      withoutRunStarts(sent.slice(pauseAt)).map(meaning),
    );
    expect(resumed.at(0)).toMatchObject({
      type: EventType.RUN_STARTED,
      runId: "chat-run-resumed",
    });
    // The approved call keeps the id the paused turn stored.
    expect(toolCallIdsOf(resumed)).toEqual([...new Set(toolCallIdsOf(paused))]);
  });

  test("a native call opened before a pause and ended after it carries its arguments and its end once in the resumed turn", async () => {
    const chatThreadId = await newThread();
    const { desktopId, desktop } = shared();
    const requestId = Bun.randomUUIDv7();
    const turn = (chatRunId: string, resume?: RunAgentResumeItem[]) =>
      collect(
        createLocalChatRun(
          contextFor(chatThreadId),
          resume === undefined
            ? startPlan(desktopId)
            : { type: "resume", harness: "codex" },
        ).stream({
          chatRunId,
          chatTurnId: turnOf(chatThreadId),
          messages:
            resume === undefined
              ? [{ role: "user", content: "Run the tests" }]
              : [],
          instructions: "You are stella.",
          resume,
          abortSignal: new AbortController().signal,
        }),
      );
    const pausedTurn = turn("chat-run-split-paused");
    const start = await desktop.receive("run.start");
    desktop.send({ type: "run.accepted", runId: start.runId });
    const toolCall = {
      id: "item_split",
      name: COMMAND_EXECUTION,
      input: { command: "bun test" },
    };
    const sent = await harnessChunks(start.runId, [
      {
        type: "session.started",
        sessionId: harnessSessionId("codex-session-split"),
        continuation: { type: "fresh" },
      },
      {
        type: "approval.requested",
        request: {
          requestId,
          kind: "command",
          toolCall,
          reason: null,
          options: [{ id: "accept", decision: "approve" }],
        },
      },
      { type: "interaction.resolved", requestId },
      {
        type: "tool.completed",
        toolCall,
        result: { content: "{}", status: "succeeded" },
      },
      { type: "turn.completed", usage: null },
    ]);
    const isCallChunk = (chunk: unknown, type: EventType) =>
      isRecord(chunk) &&
      chunk["type"] === type &&
      chunk["toolCallId"] === toolCall.id;
    const pauseAt =
      sent.findIndex(
        (chunk) =>
          isRecord(chunk) &&
          chunk["type"] === EventType.RUN_FINISHED &&
          isRecord(chunk["outcome"]) &&
          chunk["outcome"]["type"] === "interrupt",
      ) + 1;
    const args = sent.find((chunk) =>
      isCallChunk(chunk, EventType.TOOL_CALL_ARGS),
    );
    const end = sent.find((chunk) =>
      isCallChunk(chunk, EventType.TOOL_CALL_END),
    );
    expect(pauseAt).toBeGreaterThan(0);
    // The call opens before the pause; its arguments and end, an end
    // repeated, come after it.
    const beforePause = sent
      .slice(0, pauseAt)
      .filter(
        (chunk) =>
          !isCallChunk(chunk, EventType.TOOL_CALL_ARGS) &&
          !isCallChunk(chunk, EventType.TOOL_CALL_END),
      );
    const run = desktopRun(desktop, start.runId);
    await run.approvalRequest(requestId);
    await run.events(beforePause);
    await pausedTurn.done;

    const resumedTurn = turn("chat-run-split-resumed", [
      {
        interruptId: requestId,
        status: "resolved",
        payload: { approved: true },
      },
    ]);
    await desktop.receive("run.approval", ofRun(start.runId));
    await run.events([args, end, end, ...sent.slice(pauseAt)]);
    await run.finish("completed", "codex-session-split");
    const resumed = await resumedTurn.done;

    const ofCall = (type: EventType) =>
      resumed.filter(
        (chunk) =>
          chunk.type === type &&
          "toolCallId" in chunk &&
          chunk.toolCallId.endsWith(`_${toolCall.id}`),
      );
    expect(ofCall(EventType.TOOL_CALL_ARGS).map(meaning)).toEqual(
      [args].map(meaning),
    );
    expect(ofCall(EventType.TOOL_CALL_END).map(meaning)).toEqual(
      [end].map(meaning),
    );
    expect(ofCall(EventType.TOOL_CALL_END)).toMatchObject([
      { metadata: { tanstack: { input: toolCall.input } } },
    ]);
    expect(ofCall(EventType.TOOL_CALL_RESULT)).toHaveLength(1);
  });

  test("an answer from another thread does not reach the run", async () => {
    const chatThreadId = await newThread();
    const otherThreadId = await newThread();
    const { desktopId, desktop } = shared();
    const requestId = Bun.randomUUIDv7();
    const pausedTurn = collect(
      createLocalChatRun(contextFor(chatThreadId), startPlan(desktopId)).stream(
        {
          chatRunId: "chat-run-owned",
          chatTurnId: turnOf(chatThreadId),
          messages: [{ role: "user", content: "Run the tests" }],
          instructions: "You are stella.",
          resume: undefined,
          abortSignal: new AbortController().signal,
        },
      ),
    );
    const start = await desktop.receive("run.start");
    desktop.send({ type: "run.accepted", runId: start.runId });
    const run = desktopRun(desktop, start.runId);
    await run.approvalRequest(requestId);
    await run.events(
      await harnessChunks(start.runId, [
        {
          type: "approval.requested",
          request: {
            requestId,
            kind: "command",
            toolCall: { id: "item_2", name: "command_execution", input: {} },
            reason: null,
            options: [{ id: "accept", decision: "approve" }],
          },
        },
      ]).then((chunks) =>
        chunks.filter(
          (chunk) => !isRecord(chunk) || chunk["type"] !== EventType.RUN_ERROR,
        ),
      ),
    );
    await pausedTurn.done;

    const foreign = await collect(
      createLocalChatRun(contextFor(otherThreadId), {
        type: "resume",
        harness: "codex",
      }).stream({
        chatRunId: "chat-run-foreign",
        chatTurnId: turnOf(otherThreadId),
        messages: [],
        instructions: "",
        resume: [{ interruptId: requestId, status: "resolved", payload: true }],
        abortSignal: new AbortController().signal,
      }),
    ).done;
    expect(foreign.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: AI_FAILURE_CODES.local_runner_unavailable,
    });
    expect(
      desktop.received.filter(
        (message) =>
          message.type === "run.approval" && message.runId === start.runId,
      ),
    ).toEqual([]);
  });

  /** A run on `desktop` paused for a blocking question, with its chunks. */
  const pausedForQuestion = async ({
    desktop,
    desktopId,
    chatThreadId,
    chatRunId,
  }: {
    desktop: FakeDesktop;
    desktopId: string;
    chatThreadId: SafeId<"chatThread">;
    chatRunId: string;
  }) => {
    const turn = collect(
      createLocalChatRun(contextFor(chatThreadId), startPlan(desktopId)).stream(
        {
          chatRunId,
          chatTurnId: turnOf(chatThreadId),
          messages: [{ role: "user", content: "Draft the reply" }],
          instructions: "You are stella.",
          resume: undefined,
          abortSignal: new AbortController().signal,
        },
      ),
    );
    const start = await desktop.receive("run.start");
    desktop.send({ type: "run.accepted", runId: start.runId });
    // The sidecar relabels the harness's own request id to a UUID.
    const requestId = Bun.randomUUIDv7();
    const toolCall = { id: "item_q", name: "request_user_input", input: {} };
    const sent = await harnessChunks(start.runId, [
      {
        type: "session.started",
        sessionId: harnessSessionId("codex-session-q"),
        continuation: { type: "fresh" },
      },
      {
        type: "question.requested",
        request: {
          requestId,
          toolCall,
          questions: [
            {
              id: "tone",
              header: "Tone",
              prompt: "Formal or friendly?",
              options: [
                { label: "Formal", description: "For the court" },
                { label: "Friendly", description: "For the client" },
              ],
              allowsFreeText: false,
              multiSelect: false,
              secret: false,
            },
            {
              id: "passphrase",
              header: "Passphrase",
              prompt: "The archive passphrase?",
              options: [],
              allowsFreeText: true,
              multiSelect: false,
              secret: true,
            },
          ],
          answerWith: "response",
        },
      },
      { type: "interaction.resolved", requestId },
      {
        type: "tool.completed",
        toolCall,
        result: { content: "answered", status: "succeeded" },
      },
      { type: "text.completed", messageId: "msg_q", text: "Drafted." },
      { type: "turn.completed", usage: null },
    ]);
    const pauseAt =
      sent.findIndex(
        (chunk) =>
          isRecord(chunk) &&
          chunk["type"] === EventType.RUN_FINISHED &&
          isRecord(chunk["outcome"]) &&
          chunk["outcome"]["type"] === "interrupt",
      ) + 1;
    expect(pauseAt).toBeGreaterThan(0);
    const run = desktopRun(desktop, start.runId);
    await run.events(sent.slice(0, pauseAt));
    const paused = await turn.done;
    return { runId: start.runId, requestId, run, sent, pauseAt, paused };
  };

  const resumeWith = (
    chatThreadId: SafeId<"chatThread">,
    item: RunAgentResumeItem,
  ) =>
    collect(
      createLocalChatRun(contextFor(chatThreadId), {
        type: "resume",
        harness: "codex",
      }).stream({
        chatRunId: "chat-run-answered",
        chatTurnId: turnOf(chatThreadId),
        messages: [],
        instructions: "You are stella.",
        resume: [item],
        abortSignal: new AbortController().signal,
      }),
    );

  const ANSWERS = { tone: ["Formal"], passphrase: ["open sesame"] };

  test("a blocking question pauses the turn, and its answers continue the same run, also after a reconnect", async () => {
    const chatThreadId = await newThread();
    const desktopId = Bun.randomUUIDv7();
    const desktop = await openDesktop(chatInstance, desktopId);
    await desktop.hello();
    const { runId, requestId, run, sent, pauseAt, paused } =
      await pausedForQuestion({
        desktop,
        desktopId,
        chatThreadId,
        chatRunId: "chat-run-question",
      });
    // The turn awaits the member, naming the request the harness asked.
    expect(paused.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      runId: "chat-run-question",
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: requestId,
            reason: "user_input",
            metadata: { kind: "question", questions: [{ id: "tone" }, {}] },
          },
        ],
      },
    });
    expect(
      desktop.received.filter((message) => message.type === "run.interrupt"),
    ).toEqual([]);
    const [stored] = await db
      .select({ chatReadSeq: desktopRunnerRuns.chatReadSeq })
      .from(desktopRunnerRuns)
      .where(eq(desktopRunnerRuns.runId, runId));
    expect(stored?.chatReadSeq).toBe(run.position.seq);

    const resumed = resumeWith(chatThreadId, {
      interruptId: requestId,
      status: "resolved",
      payload: { answers: ANSWERS },
    });
    const answer = await desktop.receive("run.answer", ofRun(runId));
    expect(answer).toEqual({
      type: "run.answer",
      runId,
      requestId,
      answers: ANSWERS,
    });
    // The queue keeps the answers sealed, never as typed.
    const commands = await db
      .select({ payload: desktopRunnerCommands.payload })
      .from(desktopRunnerCommands)
      .where(
        and(
          eq(desktopRunnerCommands.runId, runId),
          eq(desktopRunnerCommands.kind, "run.answer"),
        ),
      );
    expect(commands).toHaveLength(1);
    expect(JSON.stringify(commands)).not.toContain("open sesame");
    expect(commands[0]?.payload).not.toHaveProperty("answers");

    // A computer that comes back gets the answer again, once.
    await desktop.close();
    const back = await openDesktop(chatInstance, desktopId);
    await back.hello([{ runId, lastSeq: run.position.seq }]);
    expect(await back.receive("run.answer", ofRun(runId))).toEqual(answer);
    expect(
      (
        await control.answerQuestion({
          owner,
          runId,
          requestId,
          answers: ANSWERS,
        })
      ).unwrap(),
    ).toEqual({ type: "duplicate" });
    const after = desktopRun(back, runId, run.position.seq);
    await after.events(sent.slice(pauseAt));
    await after.finish("completed", "codex-session-q");
    const chunks = await resumed.done;
    expect(withoutRunStarts(chunks).map(meaning)).toEqual(
      withoutRunStarts(sent.slice(pauseAt)).map(meaning),
    );
    // The question's call keeps the id the paused turn stored.
    expect(toolCallIdsOf(chunks)).toEqual([...new Set(toolCallIdsOf(paused))]);
    expect(
      back.received.filter((message) => message.type === "run.answer"),
    ).toHaveLength(1);
    await back.close();
  });

  test("a queued answer that no longer opens cancels its run instead of holding back the commands after it", async () => {
    const chatThreadId = await newThread();
    const desktopId = Bun.randomUUIDv7();
    const desktop = await openDesktop(chatInstance, desktopId);
    await desktop.hello();
    const { runId, requestId, run } = await pausedForQuestion({
      desktop,
      desktopId,
      chatThreadId,
      chatRunId: "chat-run-unreadable",
    });
    await desktop.close();
    expect(
      (
        await control.answerQuestion({
          owner,
          runId,
          requestId,
          answers: ANSWERS,
        })
      ).unwrap(),
    ).toMatchObject({ type: "queued" });
    // The stored answers open to something that is not answers.
    await db
      .update(desktopRunnerCommands)
      .set({
        payload: {
          type: "run.answer",
          runId,
          requestId,
          sealedAnswers: {
            ciphertext: Buffer.from("not answers").toString("base64"),
            iv: Buffer.alloc(12).toString("base64"),
          },
        },
      })
      .where(
        and(
          eq(desktopRunnerCommands.runId, runId),
          eq(desktopRunnerCommands.kind, "run.answer"),
        ),
      );
    expect((await control.interruptRun({ owner, runId })).unwrap()).toEqual({
      type: "queued",
    });
    const back = await openDesktop(chatInstance, desktopId);
    await back.hello([{ runId, lastSeq: run.position.seq }]);
    await back.receive("run.interrupt", ofRun(runId));
    expect(
      back.received
        .filter(ofRun(runId))
        .map(({ type }) => type)
        .filter((type) => type !== "run.token" && type !== "ack"),
    ).toEqual(["run.cancel", "run.interrupt"]);
    await back.close();
  });

  test("answers that do not answer the question are refused and the run stops waiting", async () => {
    const chatThreadId = await newThread();
    const { desktopId, desktop } = shared();
    const { runId, requestId } = await pausedForQuestion({
      desktop,
      desktopId,
      chatThreadId,
      chatRunId: "chat-run-refused",
    });
    const refusals: [string, unknown][] = [
      ["no answers field", { tone: ["Formal"] }],
      ["answers as text", { answers: { tone: "Formal" } }],
      [
        "an option the question lacks",
        { answers: { ...ANSWERS, tone: ["Casual"] } },
      ],
      ["a question left out", { answers: { tone: ["Formal"] } }],
      [
        "two answers to a single-choice question",
        { answers: { ...ANSWERS, tone: ["Formal", "Friendly"] } },
      ],
      ["a question never asked", { answers: { ...ANSWERS, venue: ["Brno"] } }],
    ];
    for (const [name, payload] of refusals) {
      const chunks = await resumeWith(chatThreadId, {
        interruptId: requestId,
        status: "resolved",
        payload,
      }).done;
      expect({ name, last: chunks.at(-1) }).toMatchObject({
        name,
        last: {
          type: EventType.RUN_ERROR,
          code: AI_FAILURE_CODES.local_runner_unavailable,
        },
      });
    }
    // Nothing reached the computer but the stop of the turn nobody answers.
    expect((await desktop.receive("run.interrupt", ofRun(runId))).runId).toBe(
      runId,
    );
    expect(
      desktop.received.filter(
        (message) => message.type === "run.answer" && message.runId === runId,
      ),
    ).toEqual([]);
    expect(
      await db
        .select({ kind: desktopRunnerCommands.kind })
        .from(desktopRunnerCommands)
        .where(
          and(
            eq(desktopRunnerCommands.runId, runId),
            eq(desktopRunnerCommands.kind, "run.answer"),
          ),
        ),
    ).toEqual([]);
  });

  test("a dismissed question stops the run's turn", async () => {
    const chatThreadId = await newThread();
    const { desktopId, desktop } = shared();
    const { runId, requestId, run } = await pausedForQuestion({
      desktop,
      desktopId,
      chatThreadId,
      chatRunId: "chat-run-dismissed",
    });
    const resumed = resumeWith(chatThreadId, {
      interruptId: requestId,
      status: "cancelled",
    });
    expect((await desktop.receive("run.interrupt", ofRun(runId))).runId).toBe(
      runId,
    );
    await run.finish("interrupted", "codex-session-q");
    const chunks = await resumed.done;
    expect(chunks.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "cancelled" },
    });
    expect(
      desktop.received.filter(
        (message) => message.type === "run.answer" && message.runId === runId,
      ),
    ).toEqual([]);
  });

  test("a run that already finished refuses the answer", async () => {
    const chatThreadId = await newThread();
    const { desktopId, desktop } = shared();
    const { runId, requestId, run } = await pausedForQuestion({
      desktop,
      desktopId,
      chatThreadId,
      chatRunId: "chat-run-finished",
    });
    await run.finish("interrupted", "codex-session-q");
    const chunks = await resumeWith(chatThreadId, {
      interruptId: requestId,
      status: "resolved",
      payload: { answers: ANSWERS },
    }).done;
    expect(chunks.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: AI_FAILURE_CODES.local_runner_unavailable,
    });
    expect(
      (
        await control.answerQuestion({
          owner,
          runId,
          requestId,
          answers: ANSWERS,
        })
      ).unwrap(),
    ).toMatchObject({ type: "run_ended" });
    expect(
      desktop.received.filter(
        (message) => message.type === "run.answer" && message.runId === runId,
      ),
    ).toEqual([]);
  });

  test("an answer is matched only to a question, and an approval only to an approval request", async () => {
    const chatThreadId = await newThread();
    const { desktopId, desktop } = shared();
    const { runId, requestId } = await pausedForQuestion({
      desktop,
      desktopId,
      chatThreadId,
      chatRunId: "chat-run-kinds",
    });
    expect(
      (
        await control.answerApproval({
          owner,
          runId,
          requestId,
          decision: "approve",
        })
      ).unwrap(),
    ).toEqual({ type: "not_requested" });
    expect(
      (
        await control.answerQuestion({
          owner,
          runId,
          requestId: Bun.randomUUIDv7(),
          answers: ANSWERS,
        })
      ).unwrap(),
    ).toEqual({ type: "not_requested" });
  });

  test("stopping the turn interrupts the run on the computer", async () => {
    const chatThreadId = await newThread();
    const { desktopId, desktop } = shared();
    const stop = new AbortController();
    const turn = collect(
      createLocalChatRun(contextFor(chatThreadId), startPlan(desktopId)).stream(
        {
          chatRunId: "chat-run-stopped",
          chatTurnId: turnOf(chatThreadId),
          messages: [{ role: "user", content: "Work for a while" }],
          instructions: "You are stella.",
          resume: undefined,
          abortSignal: stop.signal,
        },
      ),
    );
    const start = await desktop.receive("run.start");
    desktop.send({ type: "run.accepted", runId: start.runId });
    const run = desktopRun(desktop, start.runId);
    await run.events(
      (await harnessChunks(start.runId, completedTurn)).slice(0, 2),
    );
    stop.abort(RUN_CANCEL_REASON);
    await turn.done;
    expect(
      (await desktop.receive("run.interrupt", ofRun(start.runId))).runId,
    ).toBe(start.runId);
  });

  test("a run whose events cannot be read fails the turn and stops the computer", async () => {
    const chatThreadId = await newThread();
    const { desktopId, desktop } = shared();
    const unreadable: LocalRunContext = {
      ...contextFor(chatThreadId),
      control: {
        ...control,
        readEvents: async () =>
          Result.err(new DatabaseError({ message: "connection reset" })),
      },
    };
    const { done } = collect(
      createLocalChatRun(unreadable, startPlan(desktopId)).stream({
        chatRunId: "chat-run-unreadable",
        chatTurnId: turnOf(chatThreadId),
        messages: [{ role: "user", content: "Summarize" }],
        instructions: "You are stella.",
        resume: undefined,
        abortSignal: new AbortController().signal,
      }),
    );
    const start = await desktop.receive("run.start");
    const chunks = await done;
    expect(chunks.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: AI_FAILURE_CODES.local_runner_unavailable,
    });
    expect(
      (await desktop.receive("run.interrupt", ofRun(start.runId))).runId,
    ).toBe(start.runId);
  });

  test("a run that reached its usage limit fails the turn with that reason", async () => {
    const chatThreadId = await newThread();
    const { desktopId, desktop } = shared();
    const turn = collect(
      createLocalChatRun(contextFor(chatThreadId), startPlan(desktopId)).stream(
        {
          chatRunId: "chat-run-limited",
          chatTurnId: turnOf(chatThreadId),
          messages: [{ role: "user", content: "Summarize" }],
          instructions: "You are stella.",
          resume: undefined,
          abortSignal: new AbortController().signal,
        },
      ),
    );
    const start = await desktop.receive("run.start");
    desktop.send({ type: "run.accepted", runId: start.runId });
    const run = desktopRun(desktop, start.runId);
    await run.events(
      await harnessChunks(start.runId, [
        {
          type: "turn.failed",
          failure: {
            type: "usage_limit",
            message: "Usage limit reached",
            resetsAt: null,
          },
        },
      ]),
    );
    await run.finish("limit_reached", null);
    const chunks = await turn.done;
    const last = chunks.at(-1);
    expect(last).toMatchObject({
      type: EventType.RUN_ERROR,
      code: AI_FAILURE_CODES.local_runner_limit_reached,
    });
    expect(
      last?.type === EventType.RUN_ERROR ? classifyRunErrorChunk(last) : null,
    ).toBe("local_runner_limit_reached");
  });

  test("a run that reached its usage limit says when the limit resets, and a time the desktop made up is dropped", async () => {
    const limitedTurn = async (
      chunks: (runId: string) => Promise<unknown[]>,
    ) => {
      const chatThreadId = await newThread();
      const { desktopId, desktop } = shared();
      const turn = collect(
        createLocalChatRun(
          contextFor(chatThreadId),
          startPlan(desktopId),
        ).stream({
          chatRunId: Bun.randomUUIDv7(),
          chatTurnId: turnOf(chatThreadId),
          messages: [{ role: "user", content: "Summarize" }],
          instructions: "You are stella.",
          resume: undefined,
          abortSignal: new AbortController().signal,
        }),
      );
      const start = await desktop.receive("run.start");
      desktop.send({ type: "run.accepted", runId: start.runId });
      const run = desktopRun(desktop, start.runId);
      await run.events(await chunks(start.runId));
      await run.finish("limit_reached", null);
      const last = (await turn.done).at(-1);
      expect(last).toMatchObject({
        type: EventType.RUN_ERROR,
        code: AI_FAILURE_CODES.local_runner_limit_reached,
      });
      return last?.type === EventType.RUN_ERROR ? last : panic("no run error");
    };
    const limitFailure = (resetsAt: string | null) =>
      [
        {
          type: "turn.failed",
          failure: {
            type: "usage_limit",
            message: "Usage limit reached",
            resetsAt,
          },
        },
      ] satisfies HarnessEvent[];

    const reported = await limitedTurn(
      async (runId) =>
        await harnessChunks(runId, limitFailure("2026-11-08T09:30:00.000Z")),
    );
    expect(reported.metadata?.[CHAT_LOCAL_RUN_LIMIT_METADATA_KEY]).toEqual({
      resetsAt: "2026-11-08T09:30:00.000Z",
    });

    // A desktop is not trusted: a time that is not an instant, or extra
    // fields beside it, never reach the turn.
    for (const forged of [
      { resetsAt: "tomorrow" },
      { resetsAt: "2026-11-08T09:30:00.000Z", note: "<b>now</b>" },
    ]) {
      const dropped = await limitedTurn(async (runId) =>
        (await harnessChunks(runId, limitFailure(null))).map((chunk) =>
          isRecord(chunk) && chunk["type"] === EventType.RUN_ERROR
            ? {
                ...chunk,
                metadata: { [CHAT_LOCAL_RUN_LIMIT_METADATA_KEY]: forged },
              }
            : chunk,
        ),
      );
      expect(
        dropped.metadata?.[CHAT_LOCAL_RUN_LIMIT_METADATA_KEY],
      ).toBeUndefined();
    }
  });

  test("a computer that refuses the run fails the turn with the reason it gave", async () => {
    const { desktopId, desktop } = shared();
    for (const [reason, kind] of [
      ["harness_needs_login", "local_runner_needs_login"],
      ["harness_unavailable", "local_runner_unavailable"],
      ["run_too_large", "local_runner_turn_too_large"],
      // An undo of the chat's files still runs on the computer: send again.
      ["folder_busy", "local_runner_restoring"],
      // The chat's linked folder is on a volume that is not mounted.
      ["folder_offline", "local_runner_folder_unavailable"],
    ] as const) {
      const chatThreadId = await newThread();
      const turn = collect(
        createLocalChatRun(
          contextFor(chatThreadId),
          startPlan(desktopId),
        ).stream({
          chatRunId: `chat-run-refused-${reason}`,
          chatTurnId: turnOf(chatThreadId),
          messages: [{ role: "user", content: "Summarize" }],
          instructions: "You are stella.",
          resume: undefined,
          abortSignal: new AbortController().signal,
        }),
      );
      const start = await desktop.receive("run.start");
      desktop.send({ type: "run.rejected", runId: start.runId, reason });
      const last = (await turn.done).at(-1);
      expect({ reason, last }).toMatchObject({
        reason,
        last: { type: EventType.RUN_ERROR, code: AI_FAILURE_CODES[kind] },
      });
      expect({
        reason,
        kind:
          last?.type === EventType.RUN_ERROR
            ? classifyRunErrorChunk(last)
            : null,
      }).toEqual({ reason, kind });
    }
  });

  test("a turn too long for one frame fails as too long, and no run is queued", async () => {
    const chatThreadId = await newThread();
    const { desktopId } = shared();
    const chunks = await collect(
      createLocalChatRun(contextFor(chatThreadId), startPlan(desktopId)).stream(
        {
          chatRunId: "chat-run-too-long",
          chatTurnId: turnOf(chatThreadId),
          messages: [
            {
              role: "user",
              content: "x".repeat(DESKTOP_RUNNER_MAX_FRAME_BYTES),
            },
          ],
          instructions: "You are stella.",
          resume: undefined,
          abortSignal: new AbortController().signal,
        },
      ),
    ).done;
    const last = chunks.at(-1);
    expect(last).toMatchObject({
      type: EventType.RUN_ERROR,
      code: AI_FAILURE_CODES.local_runner_turn_too_large,
    });
    expect(
      last?.type === EventType.RUN_ERROR ? classifyRunErrorChunk(last) : null,
    ).toBe("local_runner_turn_too_large");
    expect(
      await db
        .select({ runId: desktopRunnerRuns.runId })
        .from(desktopRunnerRuns)
        .where(eq(desktopRunnerRuns.chatThreadId, chatThreadId)),
    ).toEqual([]);
  });

  test("a chat's background count reads the same however many runs the chat holds", async () => {
    const counted = createDesktopRunnerControl({
      // SAFETY: PGlite and Bun SQL expose the same Drizzle query APIs.
      db: asTestRaw<DesktopRunnerDb>(withQueryLogger(db, queryCountLogger)),
      doorbell: sharedDoorbell,
      now,
      timing: TIMING,
    });
    const { desktopId, desktop } = shared();
    const threadId = await newThread();
    const fixture = { control: counted, owner, threadId };
    const small = await chatBackgroundTasksScalingScenario.measure(fixture);
    for (let index = 0; index < 20; index += 1) {
      const runId = await assignRun(desktopId);
      await desktop.receive("run.start", ofRun(runId));
      desktop.send({ type: "run.accepted", runId });
      desktop.send({ type: "run.background", runId, count: 1 });
      desktop.send(textEvent(runId, 1, "Working"));
      await desktop.receive("ack", ofRun(runId));
      // The chat's own runs, as a chat turn would have started them.
      await db
        .update(desktopRunnerRuns)
        .set({ chatThreadId: threadId })
        .where(eq(desktopRunnerRuns.runId, runId));
    }
    const large = await chatBackgroundTasksScalingScenario.measure(fixture);
    expect(small.statements).toBeGreaterThan(0);
    expect(readScalingViolations({ small, large })).toEqual([]);
    expect(
      (await counted.readBackgroundTasks({ owner, threadId })).unwrap(),
    ).toBe(20);
  });

  test("the composer's computer list reads the same however much the computers ran", async () => {
    const counted = createDesktopRunnerControl({
      // SAFETY: PGlite and Bun SQL expose the same Drizzle query APIs.
      db: asTestRaw<DesktopRunnerDb>(withQueryLogger(db, queryCountLogger)),
      doorbell: sharedDoorbell,
      now,
      timing: TIMING,
    });
    const { desktopId, desktop } = shared();
    const fixture = { control: counted, owner };
    const small = await chatLocalRunnersScalingScenario.measure(fixture);
    for (let index = 0; index < 20; index += 1) {
      const runId = await assignRun(desktopId);
      await desktop.receive("run.start", ofRun(runId));
      desktop.send({ type: "run.accepted", runId });
      desktop.send(textEvent(runId, 1, "Working"));
      await desktop.receive("ack", ofRun(runId));
    }
    const large = await chatLocalRunnersScalingScenario.measure(fixture);
    expect(small.statements).toBeGreaterThan(0);
    expect(readScalingViolations({ small, large })).toEqual([]);
  });

  test("the computer gets each run's output key, and a step output grant reads only the owner's one run", async () => {
    const counted = createDesktopRunnerControl({
      // SAFETY: PGlite and Bun SQL expose the same Drizzle query APIs.
      db: asTestRaw<DesktopRunnerDb>(withQueryLogger(db, queryCountLogger)),
      doorbell: sharedDoorbell,
      now,
      timing: TIMING,
    });
    const { desktopId, desktop } = shared();
    const runId = await assignRun(desktopId);
    const start = await desktop.receive("run.start", ofRun(runId));
    // The key grants are signed with: the run's own, which no stored command
    // holds and the run keeps only encrypted.
    expect(start.outputKey).toMatch(/^[0-9a-f]{64}$/u);
    expect((await counted.readRunOutputKey({ owner, runId })).unwrap()).toBe(
      start.outputKey,
    );
    const [queued] = await db
      .select({ payload: desktopRunnerCommands.payload })
      .from(desktopRunnerCommands)
      .where(eq(desktopRunnerCommands.runId, runId));
    expect(JSON.stringify(queued?.payload)).not.toContain(start.outputKey);
    const [stored] = await db
      .select({ sealed: desktopRunnerRuns.outputKeyEncrypted })
      .from(desktopRunnerRuns)
      .where(eq(desktopRunnerRuns.runId, runId));
    expect(stored?.sealed?.toString("utf-8")).not.toContain(start.outputKey);
    desktop.send({ type: "run.accepted", runId });
    const fixture = { control: counted, owner, runId };
    const small =
      await chatLocalRunStepOutputGrantScalingScenario.measure(fixture);
    for (let index = 0; index < 20; index += 1) {
      const other = await assignRun(desktopId);
      await desktop.receive("run.start", ofRun(other));
      desktop.send({ type: "run.accepted", runId: other });
      desktop.send(textEvent(other, 1, "Working"));
      await desktop.receive("ack", ofRun(other));
    }
    const large =
      await chatLocalRunStepOutputGrantScalingScenario.measure(fixture);
    expect(small.rows).toBe(1);
    expect(readScalingViolations({ small, large })).toEqual([]);
    // Each run has its own key, and another member's grant finds no run by
    // that id.
    const other = await assignRun(desktopId);
    const otherStart = await desktop.receive("run.start", ofRun(other));
    desktop.send({ type: "run.accepted", runId: other });
    expect(otherStart.outputKey).not.toBe(start.outputKey);
    expect(
      (
        await ownerStepOutputGrant({
          control: counted,
          owner: { organizationId: ids.orgB, userId: ids.userB1 },
          runId,
          now: 0,
        })
      ).unwrap(),
    ).toBeNull();
  });

  test("a grant made after the deployment's auth secret rotates still opens the output of a run started before", async () => {
    const { desktopId, desktop } = shared();
    const runId = await assignRun(desktopId);
    const start = await desktop.receive("run.start", ofRun(runId));
    desktop.send({ type: "run.accepted", runId });
    testState.setConfig("BETTER_AUTH_SECRET", "rotated-".repeat(8));
    const grantedAt = 1_900_000_000;
    const grant = (
      await ownerStepOutputGrant({ control, owner, runId, now: grantedAt })
    ).unwrap();
    // What the computer checks a request against: the message signed with
    // the key it got in `run.start`.
    const expiresAt = grantedAt + CHAT_LOCAL_RUN_STEP_OUTPUT_GRANT_SECONDS;
    expect(grant).toEqual({
      key: new Bun.CryptoHasher("sha256", start.outputKey)
        .update(
          chatLocalRunStepOutputGrantMessage({
            runId,
            userId: owner.userId,
            organizationId: owner.organizationId,
            expiresAt,
          }),
        )
        .digest("hex"),
      expiresAt,
    });
  });

  test("a computer that goes away mid-turn keeps the turn waiting until it returns, and the chat is told both", async () => {
    const chatThreadId = await newThread();
    const desktopId = Bun.randomUUIDv7();
    const desktop = await openDesktop(chatInstance, desktopId);
    await desktop.hello();
    // Nothing rings when a lease lapses, so the reader finds the wait on its
    // next poll; a short one keeps the test quick.
    const context = { ...contextFor(chatThreadId), pollMs: 10 };
    const toldWaiting = Promise.withResolvers<undefined>();
    const turn = (async () => {
      const chunks: PublicStreamChunk[] = [];
      for await (const chunk of createLocalChatRun(
        context,
        startPlan(desktopId),
      ).stream({
        chatRunId: "chat-run-away",
        chatTurnId: turnOf(chatThreadId),
        messages: [{ role: "user", content: "Summarize" }],
        instructions: "You are stella.",
        resume: undefined,
        abortSignal: new AbortController().signal,
      })) {
        chunks.push(chunk);
        if (isComputerEvent(chunk)) {
          toldWaiting.resolve(undefined);
        }
      }
      return chunks;
    })();
    const start = await desktop.receive("run.start");
    desktop.send({ type: "run.accepted", runId: start.runId });
    const sent = await harnessChunks(start.runId, completedTurn);
    const before = desktopRun(desktop, start.runId);
    await before.events(sent.slice(0, 3));
    await desktop.close();
    clock.now += TIMING.leaseMs + 1;
    await chatInstance.gateway.sweep();
    expect((await runState(start.runId))?.state).toBe("waiting_for_computer");
    // The computer comes back only once the chat was told it is away; the
    // reader keeps polling meanwhile, and every poll still finds it away.
    await toldWaiting.promise;

    const back = await openDesktop(chatInstance, desktopId);
    await back.hello([{ runId: start.runId, lastSeq: before.position.seq }]);
    const after = desktopRun(back, start.runId, before.position.seq);
    await after.events(sent.slice(3));
    await after.finish("completed", "codex-session-1");
    const chunks = await turn;
    // Each change is told once, however many polls the wait lasted. Waiting
    // follows what the computer sent before it went away; connected
    // comes before anything it sent once back.
    const told = chunks.flatMap((chunk, index) =>
      isComputerEvent(chunk) ? [{ index, status: computerStatus(chunk) }] : [],
    );
    const output = withoutRunStarts(chunks).filter(
      (chunk) => !isComputerEvent(chunk),
    );
    expect(told.map(({ status }) => status)).toEqual([
      "delivering",
      "connected",
      "waiting",
      "connected",
    ]);
    const away = told.at(2);
    const returned = told.at(3);
    expect(
      withoutRunStarts(chunks.slice(0, away?.index)).filter(
        (chunk) => !isComputerEvent(chunk),
      ),
    ).toHaveLength(withoutRunStarts(sent.slice(0, 3)).length);
    expect(
      withoutRunStarts(chunks.slice(away?.index, returned?.index)).filter(
        (chunk) => !isComputerEvent(chunk),
      ),
    ).toEqual([]);
    expect(output.map(meaning)).toEqual(withoutRunStarts(sent).map(meaning));
    await back.close();
  });

  test("a turn whose run no computer picks up says it waits for the computer, then fails as not reached", async () => {
    const chatThreadId = await newThread();
    // A sweep with a short window of its own, so the clock moves less than
    // the shared desktop's freshness and later turns still find it.
    const UNACCEPTED_MS = 30_000;
    const pickup = await startInstance("api-pickup-window", sharedDoorbell, {
      limits: { unacceptedRunMs: UNACCEPTED_MS },
    });
    // A computer the API counts as connected, whose socket is on no task.
    const desktopId = Bun.randomUUIDv7();
    await insertReadyRunner(desktopId);
    const context = { ...contextFor(chatThreadId), pollMs: 10 };
    const toldDelivering = Promise.withResolvers<undefined>();
    const turn = (async () => {
      const chunks: PublicStreamChunk[] = [];
      for await (const chunk of createLocalChatRun(
        context,
        startPlan(desktopId),
      ).stream({
        chatRunId: "chat-run-unreached",
        chatTurnId: turnOf(chatThreadId),
        messages: [{ role: "user", content: "Summarize" }],
        instructions: "You are stella.",
        resume: undefined,
        abortSignal: new AbortController().signal,
      })) {
        chunks.push(chunk);
        if (isComputerEvent(chunk)) {
          toldDelivering.resolve(undefined);
        }
      }
      return chunks;
    })();
    await toldDelivering.promise;
    clock.now += UNACCEPTED_MS + 1;
    await pickup.gateway.sweep();
    const chunks = await turn;

    const told: unknown[] = chunks.filter(isComputerEvent);
    expect(told.map(computerStatus)).toEqual(["delivering"]);
    const toldFirst = told.at(0);
    const delivering = v.parse(
      chatLocalRunComputerEventSchema,
      isRecord(toldFirst) ? toldFirst["value"] : undefined,
    );
    expect(
      delivering.status === "delivering" && Date.parse(delivering.since),
    ).toBeGreaterThan(0);
    expect(chunks.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: AI_FAILURE_CODES.local_runner_not_reached,
    });
    const [run] = await db
      .select({ runId: desktopRunnerRuns.runId })
      .from(desktopRunnerRuns)
      .where(eq(desktopRunnerRuns.desktopId, desktopId));
    expect(
      await runState(run?.runId ?? panic("the turn started no run")),
    ).toMatchObject({ state: "lost", deliveredAt: null, acceptedAt: null });
    await retireRunner(desktopId);
  });

  /** The run's commands of `kind`, as the gateway stored them. */
  const commandsOf = async (
    runId: string,
    kind: "run.interrupt" | "run.cancel" | "run.approval" | "run.answer",
  ) =>
    await db
      .select({ id: desktopRunnerCommands.id })
      .from(desktopRunnerCommands)
      .where(
        and(
          eq(desktopRunnerCommands.runId, runId),
          eq(desktopRunnerCommands.kind, kind),
        ),
      );

  /**
   * A turn's chunks served as `streamChat` serves them: what the page
   * receives, and the finish the send stores.
   */
  const serveTurn = async (
    source: AsyncIterable<PublicStreamChunk>,
    responseMessageId: SafeId<"chatMessage">,
    initialMessages: ChatMessage[] = [],
    resume?: readonly RunAgentResumeItem[],
  ) => {
    // The capture `streamChat` builds: a resumed turn continues the message
    // the paused one stored.
    const { processor, message } = createStreamMessageCapture({
      initialMessages,
      capture: (streamed) => toChatMessage(streamed),
    });
    const finished: { event: StreamChatFinishEvent | null } = { event: null };
    const deadline = new AbortController();
    const emitted: PublicStreamChunk[] = [];
    for await (const chunk of processServerChatStream({
      abortSignal: abortControllerFromSignal(deadline.signal).signal,
      deadlineSignal: deadline.signal,
      dismissesAwaited: resumeDismissesAwaited(resume),
      getResponseMessage: message,
      initialMessages,
      mapMessageId: createChatMessageIdMapper(() => responseMessageId),
      onFinish: (event) => {
        finished.event = event;
      },
      processor,
      source,
    })) {
      emitted.push(chunk);
    }
    return {
      emitted,
      finish: finished.event ?? panic("the served turn did not finish"),
    };
  };

  /**
   * What persisting a turn stores and a reload reads back, by the send's own
   * validation and encoding, for a turn of `ownership`.
   */
  const persistTurn = (
    finish: StreamChatFinishEvent,
    ownership: ChatToolCallOwnership,
  ) =>
    validateToolCallParts({
      allowDeferredServerInput: finish.outcome.type === "awaiting-user",
      message: finish.responseMessage,
      ownership,
      tools: {},
    }).map((parts) => {
      const message = toPersistableChatMessage({
        ...finish.responseMessage,
        parts,
      });
      const content = chatMessageContentFromMessage(message);
      return {
        content,
        reloaded: chatMessageFromPersisted({
          id: message.id,
          role: "assistant",
          content,
        }),
      };
    });

  /** What the page shows of a message's parts, live or reloaded. */
  const shownParts = (parts: readonly unknown[]): unknown[] =>
    parts.flatMap((part): unknown[] => {
      if (!isRecord(part)) {
        return [];
      }
      switch (part["type"]) {
        case "tool-call": {
          const approval = part["approval"];
          const metadata = part["metadata"];
          return [
            {
              type: "tool-call",
              id: part["id"],
              name: part["name"],
              state: part["state"],
              input: part["input"],
              output: part["output"],
              approved: isRecord(approval) ? approval["approved"] : null,
              executor: isRecord(metadata)
                ? metadata[CHAT_TOOL_EXECUTOR_METADATA_KEY]
                : null,
            },
          ];
        }
        case "tool-result":
          return [
            {
              type: "tool-result",
              toolCallId: part["toolCallId"],
              state: part["state"],
            },
          ];
        case "text":
          return [{ type: "text", content: part["content"] }];
        default:
          return [];
      }
    });

  /** The assistant message a page's continuation carries. */
  const assistantOf = (message: UIMessage | ModelMessage | undefined) =>
    message !== undefined && "parts" in message && message.role === "assistant"
      ? {
          id: toSafeId<"chatMessage">(message.id),
          role: message.role,
          parts: message.parts,
          metadata: message.metadata,
        }
      : panic("the continuation carries no assistant message");

  /** The harness's own name for running a command on the computer. */
  const COMMAND_EXECUTION = "command_execution";

  const noDbReads: SafeDb = async () =>
    panic("Validating a continuation must not read the database");

  test("a turn whose harness ran a command and asks to run another is stored as streamed, and its approval continues the same run", async () => {
    const chatThreadId = await newThread();
    const chatTurnId = turnOf(chatThreadId);
    const { desktopId, desktop } = shared();
    const requestId = Bun.randomUUIDv7();
    const responseMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
    const listing = {
      id: "item_ls",
      name: COMMAND_EXECUTION,
      input: { command: "ls" },
    };
    const gated = {
      id: "item_test",
      name: COMMAND_EXECUTION,
      input: { command: "bun test" },
    };
    const localTurn = (resume?: RunAgentResumeItem[]) =>
      createLocalChatRun(
        contextFor(chatThreadId),
        resume === undefined
          ? startPlan(desktopId)
          : { type: "resume", harness: "codex" },
      ).stream({
        chatRunId: Bun.randomUUIDv7(),
        chatTurnId,
        messages: [{ role: "user", content: "Run the tests" }],
        instructions: "You are stella.",
        resume,
        abortSignal: new AbortController().signal,
      });

    const pausedServed = serveTurn(localTurn(), responseMessageId);
    const start = await desktop.receive("run.start");
    desktop.send({ type: "run.accepted", runId: start.runId });
    const sent = await harnessChunks(start.runId, [
      {
        type: "session.started",
        sessionId: harnessSessionId("codex-session-d1"),
        continuation: { type: "fresh" },
      },
      { type: "tool.started", toolCall: listing },
      {
        type: "tool.completed",
        toolCall: listing,
        result: { content: "brief.docx", status: "succeeded" },
      },
      {
        type: "approval.requested",
        request: {
          requestId,
          kind: "command",
          toolCall: gated,
          reason: "Run the test suite",
          options: [
            { id: "accept", decision: "approve" },
            { id: "decline", decision: "deny" },
          ],
        },
      },
      { type: "interaction.resolved", requestId },
      {
        type: "tool.completed",
        toolCall: gated,
        result: { content: "12 pass", status: "succeeded" },
      },
      { type: "text.completed", messageId: "msg_d1", text: "All tests pass." },
      { type: "turn.completed", usage: null },
    ]);
    const pauseAt =
      sent.findIndex(
        (chunk) =>
          isRecord(chunk) &&
          chunk["type"] === EventType.RUN_FINISHED &&
          isRecord(chunk["outcome"]) &&
          chunk["outcome"]["type"] === "interrupt",
      ) + 1;
    expect(pauseAt).toBeGreaterThan(0);
    const run = desktopRun(desktop, start.runId);
    await run.approvalRequest(requestId);
    // A desktop that names a call's owner itself is not believed.
    await run.events(
      sent.slice(0, pauseAt).map((chunk) =>
        isRecord(chunk) && chunk["type"] === EventType.TOOL_CALL_START
          ? {
              ...chunk,
              metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server" },
            }
          : chunk,
      ),
    );
    const paused = await pausedServed;
    expect(paused.finish.outcome).toMatchObject({ type: "awaiting-user" });

    // A cloud turn's validation refuses what a computer ran; the turn's own
    // stores it, and a reload reads every call back as the harness's.
    expect(Result.isError(persistTurn(paused.finish, "cloud"))).toBe(true);
    const stored = persistTurn(paused.finish, "harness").unwrap();
    const storedCalls = stored.reloaded.parts.filter(
      (part) => part.type === "tool-call",
    );
    expect(storedCalls).toMatchObject([
      { name: COMMAND_EXECUTION, state: "complete" },
      { name: COMMAND_EXECUTION, state: "approval-requested" },
    ]);
    expect(
      storedCalls.every(
        (part) => chatToolExecutor(part) === CHAT_TOOL_EXECUTOR.harness,
      ),
    ).toBe(true);

    // The page that streamed the turn shows what a reload shows.
    const continued = Promise.withResolvers<{
      message: UIMessage | ModelMessage | undefined;
      resume: RunAgentResumeItem[];
    }>();
    const resumedChunks = Promise.withResolvers<PublicStreamChunk[]>();
    const client = new ChatClient({
      threadId: chatThreadId,
      connection: {
        async *connect(messages, _data, _signal, runContext) {
          if (runContext?.resume !== undefined) {
            continued.resolve({
              message: messages.at(-1),
              resume: runContext.resume,
            });
            yield* await resumedChunks.promise;
            return;
          }
          yield* paused.emitted;
        },
      },
    });
    await client.sendMessage("Run the tests");
    const liveMessage = client.getMessages().at(-1);
    expect(liveMessage?.id).toBe(responseMessageId);
    expect(shownParts(liveMessage?.parts ?? [])).toEqual(
      shownParts(stored.reloaded.parts),
    );

    // The member approves on the page; the send validates the continuation
    // as the harness's, and a cloud turn could not answer it.
    const approval = client.getInterrupts().at(0);
    expect(approval?.kind).toBe("generic");
    if (approval?.kind === "generic") {
      approval.resolveInterrupt({ approved: true });
    }
    const request = await continued.promise;
    const answered = assistantOf(request.message);
    const continuation = async (ownership: ChatToolCallOwnership) =>
      await validateMessage({
        message: answered,
        persistedMessage: { role: "assistant", content: stored.content },
        refRegistry: createChatRefRegistry(),
        resume: request.resume,
        safeDb: noDbReads,
        threadId: chatThreadId,
        toolCallOwnership: ownership,
        tools: {},
        userId: ids.userA1,
      });
    expect(Result.isError(await continuation("cloud"))).toBe(true);
    const accepted = (await continuation("harness")).unwrap();

    // The answer reaches the run that asked, and the turn reads on from the
    // pause.
    const resumedServed = serveTurn(
      localTurn(request.resume),
      responseMessageId,
      [accepted.message],
    );
    expect(
      await desktop.receive("run.approval", ofRun(start.runId)),
    ).toMatchObject({ requestId, decision: "approve" });
    await run.events(sent.slice(pauseAt));
    await run.finish("completed", "codex-session-d1");
    const resumed = await resumedServed;
    expect(resumed.finish.outcome).toMatchObject({ type: "completed" });
    const finished = persistTurn(resumed.finish, "harness").unwrap();
    resumedChunks.resolve(resumed.emitted);
    await waitForExternalState({
      description: "the page shows the finished turn",
      read: () =>
        client
          .getMessages()
          .at(-1)
          ?.parts.some(
            (part) =>
              part.type === "text" && part.content === "All tests pass.",
          ) ?? false,
    });
    expect(shownParts(client.getMessages().at(-1)?.parts ?? [])).toEqual(
      shownParts(finished.reloaded.parts),
    );
    expect(
      finished.reloaded.parts.flatMap((part) =>
        part.type === "tool-call" ? [part.state] : [],
      ),
    ).toEqual(["complete", "complete"]);
  });

  test("an answer the desktop streamed as merged deltas is stored, reloaded and shown as the harness wrote it", async () => {
    const chatThreadId = await newThread();
    const { desktopId, desktop } = shared();
    const responseMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
    const served = serveTurn(
      createLocalChatRun(contextFor(chatThreadId), startPlan(desktopId)).stream(
        {
          chatRunId: Bun.randomUUIDv7(),
          chatTurnId: turnOf(chatThreadId),
          messages: [{ role: "user", content: "Summarise the lease" }],
          instructions: "You are stella.",
          resume: undefined,
          abortSignal: new AbortController().signal,
        },
      ),
      responseMessageId,
    );
    const start = await desktop.receive("run.start");
    desktop.send({ type: "run.accepted", runId: start.runId });
    // Multi-byte text, so a merge that splits or drops bytes shows.
    const deltas = Array.from(
      { length: 120 },
      (_, index) => `nájemce ${String(index)} `,
    );
    const answer = deltas.join("");
    const sent = await harnessStreamChunks(start.runId, [
      {
        type: "session.started",
        sessionId: harnessSessionId("codex-session-c1"),
        continuation: { type: "fresh" },
      },
      ...deltas.map((delta): HarnessEvent => ({
        type: "text.delta",
        messageId: "msg_c1",
        delta,
      })),
      { type: "text.completed", messageId: "msg_c1", text: answer },
      { type: "turn.completed", usage: null },
    ]);
    // The sidecar's coalescing, on a clock this test moves: a delta every
    // 20 ms, as a harness streams them.
    const merged: unknown[] = [];
    const timers: (() => void)[] = [];
    const coalescer = createChunkCoalescer({
      emit: (chunk) => {
        merged.push({ ...chunk });
      },
      schedule: (flush, delayMs) => {
        const due = { left: delayMs, flush, live: true };
        timers.push(() => {
          due.left -= 20;
          if (due.live && due.left <= 0) {
            due.live = false;
            due.flush();
          }
        });
        return () => {
          due.live = false;
        };
      },
    });
    for (const chunk of sent) {
      coalescer.push(chunk);
      for (const tick of [...timers]) {
        tick();
      }
    }
    coalescer.flush();
    const contentChunks = (chunks: readonly unknown[]) =>
      chunks.filter(
        (chunk) =>
          isRecord(chunk) && chunk["type"] === EventType.TEXT_MESSAGE_CONTENT,
      ).length;
    // The fixture reaches the merge: the desktop sends far fewer messages.
    expect(contentChunks(sent)).toBe(deltas.length);
    expect(contentChunks(merged)).toBeGreaterThan(1);
    expect(contentChunks(merged)).toBeLessThan(deltas.length / 4);

    const run = desktopRun(desktop, start.runId);
    await run.events(merged);
    await run.finish("completed", "codex-session-c1");
    expect(await storedSeqs(start.runId)).toHaveLength(merged.length + 1);
    const turn = await served;
    expect(turn.finish.outcome).toMatchObject({ type: "completed" });

    const stored = persistTurn(turn.finish, "harness").unwrap();
    expect(shownParts(stored.reloaded.parts)).toEqual([
      { type: "text", content: answer },
    ]);
    // The page that streamed the merged chunks shows what a reload shows.
    const client = new ChatClient({
      threadId: chatThreadId,
      connection: {
        async *connect() {
          yield* turn.emitted;
        },
      },
    });
    await client.sendMessage("Summarise the lease");
    expect(shownParts(client.getMessages().at(-1)?.parts ?? [])).toEqual(
      shownParts(stored.reloaded.parts),
    );
  });

  test("a native step keeps only its command, file names or search and how it ended, whatever else a desktop sends, and reloads as streamed", async () => {
    const chatThreadId = await newThread();
    const { desktopId, desktop } = shared();
    const responseMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
    const served = serveTurn(
      createLocalChatRun(contextFor(chatThreadId), startPlan(desktopId)).stream(
        {
          chatRunId: Bun.randomUUIDv7(),
          chatTurnId: turnOf(chatThreadId),
          messages: [{ role: "user", content: "Draft the notice" }],
          instructions: "You are stella.",
          resume: undefined,
          abortSignal: new AbortController().signal,
        },
      ),
      responseMessageId,
    );
    const start = await desktop.receive("run.start");
    desktop.send({ type: "run.accepted", runId: start.runId });
    const secret = "Private settlement terms";
    const command = {
      id: "item_cmd",
      name: "command_execution",
      input: { command: "cat > notes.md <<'EOF'\nterms\nEOF" },
    };
    const read = {
      id: "item_read",
      name: "harness_native_tool",
      input: {
        tool: "Read",
        detail: { kind: "read", path: "/workspace/a.md" },
      },
    };
    const sent = await harnessStreamChunks(start.runId, [
      {
        type: "session.started",
        sessionId: harnessSessionId("codex-session-native"),
        continuation: { type: "fresh" },
      },
      ...[command, read].map((toolCall): HarnessEvent => ({
        type: "tool.completed",
        toolCall,
        result: {
          content: JSON.stringify({ status: "completed" }),
          status: "succeeded",
        },
      })),
      { type: "text.completed", messageId: "msg_n1", text: "Drafted." },
      { type: "turn.completed", usage: null },
    ]);
    // A desktop that adds what must stay on the computer: a command's output
    // and a file's contents beside the contract's fields, a second arguments
    // chunk, and metadata on the call's start.
    const tanstackOf = (metadata: unknown) => {
      const tanstack = isRecord(metadata) ? metadata["tanstack"] : undefined;
      return isRecord(tanstack) ? tanstack : {};
    };
    const tampered = sent.flatMap((chunk): unknown[] => {
      if (chunk.type === EventType.TOOL_CALL_START) {
        const tanstack = tanstackOf(chunk.metadata);
        return [
          {
            ...chunk,
            input: { content: secret },
            output: secret,
            metadata: { output: secret, tanstack: { ...tanstack, secret } },
          },
        ];
      }
      if (chunk.type === EventType.TOOL_CALL_ARGS) {
        const args = JSON.stringify({
          ...v.parse(
            v.record(v.string(), v.unknown()),
            JSON.parse(chunk.delta),
          ),
          output: secret,
          content: secret,
        });
        return [
          { ...chunk, delta: args },
          { ...chunk, delta: `{"content":"${secret}"}` },
        ];
      }
      if (chunk.type === EventType.TOOL_CALL_END) {
        const tanstack = tanstackOf(chunk.metadata);
        const input = isRecord(tanstack["input"]) ? tanstack["input"] : {};
        const detail = input["detail"];
        const forged = {
          ...input,
          output: secret,
          ...(isRecord(detail)
            ? { detail: { ...detail, content: secret } }
            : {}),
        };
        return [
          {
            ...chunk,
            input: forged,
            metadata: { tanstack: { ...tanstack, input: forged, secret } },
          },
        ];
      }
      if (chunk.type === EventType.TOOL_CALL_RESULT) {
        // A command's output, and a read's file as its whole result.
        return [
          {
            ...chunk,
            content:
              chunk.toolCallId === command.id
                ? JSON.stringify({
                    aggregated_output: secret,
                    exit_code: 0,
                    status: "completed",
                  })
                : `1→${secret}`,
            metadata: {
              tanstack: { ...tanstackOf(chunk.metadata), output: secret },
            },
          },
        ];
      }
      return [chunk];
    });
    const run = desktopRun(desktop, start.runId);
    await run.events(tampered);
    await run.finish("completed", "codex-session-native");
    const turn = await served;
    expect(turn.finish.outcome).toMatchObject({ type: "completed" });

    expect(JSON.stringify(turn.emitted)).not.toContain(secret);
    const stored = persistTurn(turn.finish, "harness").unwrap();
    expect(JSON.stringify(stored.content)).not.toContain(secret);
    const calls = stored.reloaded.parts.flatMap((part): unknown[] =>
      part.type === "tool-call"
        ? [
            {
              name: part.name,
              input: part.input,
              arguments: part.arguments,
              output: part.output,
            },
          ]
        : [],
    );
    const shownCommand = { command: "cat > notes.md <<'EOF'…" };
    const shownRead = {
      tool: "Read",
      detail: { kind: "read", path: "a.md" },
    };
    expect(calls).toEqual([
      {
        name: "command_execution",
        input: shownCommand,
        arguments: JSON.stringify(shownCommand),
        output: { exit_code: 0, status: "completed" },
      },
      {
        name: "harness_native_tool",
        input: shownRead,
        arguments: JSON.stringify(shownRead),
        output: { status: "completed" },
      },
    ]);
    // The page that streamed the turn shows what a reload shows.
    const client = new ChatClient({
      threadId: chatThreadId,
      connection: {
        async *connect() {
          yield* turn.emitted;
        },
      },
    });
    await client.sendMessage("Draft the notice");
    expect(shownParts(client.getMessages().at(-1)?.parts ?? [])).toEqual(
      shownParts(stored.reloaded.parts),
    );
  });

  /** A turn the desktop answers with `chunks`, served, stored and reloaded. */
  const servedNativeTurn = async (
    send: (runId: string) => Promise<unknown[]>,
    finishedSession?: string,
  ) => {
    const chatThreadId = await newThread();
    const { desktopId, desktop } = shared();
    const responseMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
    const served = serveTurn(
      createLocalChatRun(contextFor(chatThreadId), startPlan(desktopId)).stream(
        {
          chatRunId: Bun.randomUUIDv7(),
          chatTurnId: turnOf(chatThreadId),
          messages: [{ role: "user", content: "Draft the notice" }],
          instructions: "You are stella.",
          resume: undefined,
          abortSignal: new AbortController().signal,
        },
      ),
      responseMessageId,
    );
    const start = await desktop.receive("run.start");
    desktop.send({ type: "run.accepted", runId: start.runId });
    const run = desktopRun(desktop, start.runId);
    const chunks = await send(start.runId);
    await run.events(chunks);
    if (finishedSession !== undefined) {
      await run.finish("completed", finishedSession);
    }
    return { turn: await served };
  };

  test("an approval of a native step keeps only its shown command and what the protocol names, whatever the desktop sends, also after a reload", async () => {
    const secret = "Private settlement terms";
    const requestId = Bun.randomUUIDv7();
    const heredoc = {
      id: "item_write",
      name: COMMAND_EXECUTION,
      input: { command: `cat > notes.md <<'EOF'\n${secret}\nEOF` },
    };
    const { turn } = await servedNativeTurn(async (runId) => {
      const sent = await harnessChunks(runId, [
        {
          type: "session.started",
          sessionId: harnessSessionId("codex-session-approval"),
          continuation: { type: "fresh" },
        },
        {
          type: "approval.requested",
          request: {
            requestId,
            kind: "command",
            toolCall: heredoc,
            reason: null,
            options: [{ id: "accept", decision: "approve" }],
          },
        },
      ]);
      // A desktop that puts the heredoc's text back on the pause.
      return sent.map((chunk) => {
        if (
          !isRecord(chunk) ||
          chunk["type"] !== EventType.RUN_FINISHED ||
          !isRecord(chunk["outcome"]) ||
          !Array.isArray(chunk["outcome"]["interrupts"])
        ) {
          return chunk;
        }
        return {
          ...chunk,
          outcome: {
            ...chunk["outcome"],
            interrupts: chunk["outcome"]["interrupts"].map(
              (interrupt: unknown) =>
                isRecord(interrupt) && isRecord(interrupt["metadata"])
                  ? {
                      ...interrupt,
                      message: heredoc.input.command,
                      reason: secret,
                      expiresAt: secret,
                      metadata: {
                        ...interrupt["metadata"],
                        input: { ...heredoc.input, output: secret },
                        reason: `Writes notes\n${secret}`,
                        output: secret,
                        decisions: ["approve", secret],
                      },
                    }
                  : interrupt,
            ),
          },
        };
      });
    });
    expect(turn.finish.outcome).toMatchObject({ type: "awaiting-user" });
    const pause = turn.emitted.findLast(
      (chunk) =>
        chunk.type === EventType.RUN_FINISHED &&
        chunk.outcome?.type === "interrupt",
    );
    if (
      pause?.type !== EventType.RUN_FINISHED ||
      pause.outcome?.type !== "interrupt"
    ) {
      panic("the served turn did not pause");
    }
    // As `streamChat` stores an awaiting turn: with its interrupts.
    const stored = persistTurn(
      {
        ...turn.finish,
        responseMessage: {
          ...turn.finish.responseMessage,
          metadata: {
            ...turn.finish.responseMessage.metadata,
            resumeSnapshot: {
              resumeState: { threadId: "thread-approval", runId: pause.runId },
              pendingInterrupts: pause.outcome.interrupts,
            },
          },
        },
      },
      "harness",
    ).unwrap();
    expect(
      JSON.stringify({ emitted: turn.emitted, finish: turn.finish, stored }),
    ).not.toContain(secret);
    const shownCommand = "cat > notes.md <<'EOF'…";
    expect(
      stored.reloaded.metadata?.resumeSnapshot?.pendingInterrupts,
    ).toMatchObject([
      {
        id: requestId,
        message: shownCommand,
        metadata: {
          kind: "approval",
          reason: "Writes notes…",
          toolName: COMMAND_EXECUTION,
          input: { command: shownCommand },
          approvalKind: "command",
          decisions: ["approve"],
        },
      },
    ]);
  });

  test("a subagent's calls name the subagent under its chat call id in their metadata, a connector's call included, and a parent a desktop made up names nothing", async () => {
    const secret = "Private settlement terms";
    const requestId = Bun.randomUUIDv7();
    const NATIVE_TOOL = "harness_native_tool";
    const CONNECTOR_TOOL = "mcp__docs__search";
    const inSubagent = { parentCallId: "item_agent" };
    const subagent = {
      id: "item_agent",
      name: NATIVE_TOOL,
      input: {
        tool: "Agent",
        detail: {
          kind: "subagent",
          description: "Check the lease",
          agentType: "Explore",
        },
      },
    };
    const image = {
      id: "item_image",
      name: NATIVE_TOOL,
      input: {
        tool: "Read",
        detail: { kind: "image", path: "/workspace/scans/page-1.png" },
      },
      ...inSubagent,
    };
    const search = {
      id: "item_search",
      name: "harness_web_search",
      input: { query: "lease arrears" },
      ...inSubagent,
    };
    // A connector's call keeps the input its tool defines.
    const connector = {
      id: "item_docs",
      name: CONNECTOR_TOOL,
      input: { query: "arrears cap" },
      ...inSubagent,
    };
    const command = {
      id: "item_rm",
      name: COMMAND_EXECUTION,
      input: { command: "rm draft.md" },
      ...inSubagent,
    };
    const done = {
      content: JSON.stringify({ status: "completed" }),
      status: "succeeded",
    } as const;
    // An id longer than any chat call id: it names no step.
    const madeUp = "x".repeat(300);
    const { turn } = await servedNativeTurn(async (runId) => {
      const sent = await harnessChunks(runId, [
        {
          type: "session.started",
          sessionId: harnessSessionId("claude-session-subagent"),
          continuation: { type: "fresh" },
        },
        { type: "tool.started", toolCall: subagent },
        { type: "tool.completed", toolCall: image, result: done },
        { type: "tool.completed", toolCall: search, result: done },
        { type: "tool.completed", toolCall: connector, result: done },
        {
          type: "approval.requested",
          request: {
            requestId,
            kind: "command",
            toolCall: command,
            reason: null,
            options: [{ id: "allow", decision: "approve" }],
          },
        },
      ]);
      // A desktop that puts the subagent's prompt and report on its step
      // and beside every call's start, and a made-up parent on the search.
      const forged = (toolCallId: unknown, input: unknown) =>
        toolCallId === subagent.id &&
        isRecord(input) &&
        isRecord(input["detail"])
          ? {
              ...input,
              report: secret,
              detail: { ...input["detail"], prompt: secret },
            }
          : input;
      return sent.map((chunk) => {
        if (!isRecord(chunk)) {
          return chunk;
        }
        if (chunk["type"] === EventType.TOOL_CALL_START) {
          return {
            ...chunk,
            metadata: {
              ...(isRecord(chunk["metadata"]) ? chunk["metadata"] : {}),
              prompt: secret,
              ...(chunk["toolCallId"] === search.id
                ? { [CHAT_LOCAL_RUN_PARENT_CALL_METADATA_KEY]: madeUp }
                : {}),
            },
          };
        }
        if (
          chunk["type"] === EventType.TOOL_CALL_ARGS &&
          typeof chunk["delta"] === "string"
        ) {
          return {
            ...chunk,
            delta: JSON.stringify(
              forged(chunk["toolCallId"], JSON.parse(chunk["delta"])),
            ),
          };
        }
        if (
          chunk["type"] === EventType.TOOL_CALL_END &&
          isRecord(chunk["metadata"]) &&
          isRecord(chunk["metadata"]["tanstack"])
        ) {
          const tanstack = chunk["metadata"]["tanstack"];
          return {
            ...chunk,
            metadata: {
              tanstack: {
                ...tanstack,
                input: forged(chunk["toolCallId"], tanstack["input"]),
              },
            },
          };
        }
        return chunk;
      });
    });
    expect(turn.finish.outcome).toMatchObject({ type: "awaiting-user" });
    expect(JSON.stringify(turn.emitted)).not.toContain(secret);
    expect(JSON.stringify(turn.emitted)).not.toContain(madeUp);

    const stored = persistTurn(turn.finish, "harness").unwrap();
    expect(JSON.stringify(stored.reloaded)).not.toContain(secret);
    type StoredCall = {
      id: string;
      name: string;
      input: unknown;
      /** The subagent step the call's metadata names. */
      subagent: string | null;
    };
    const calls = stored.reloaded.parts.flatMap((part): StoredCall[] =>
      part.type === "tool-call"
        ? [
            {
              id: part.id,
              name: part.name,
              input: part.input,
              subagent: chatLocalRunParentCallId(part.metadata),
            },
          ]
        : [],
    );
    const subagentCallId =
      calls.find(({ input }) => isRecord(input) && input["tool"] === "Agent")
        ?.id ?? panic("the stored turn has no subagent step");
    // The fixture reaches the rewrite: chat keeps the step under another id
    // than the harness gave it.
    expect(subagentCallId).toEndWith(`_${subagent.id}`);
    expect(subagentCallId).not.toBe(subagent.id);
    expect(
      calls.map(({ name, input, subagent: madeBy }) => ({
        name,
        input,
        subagent: madeBy,
      })),
    ).toEqual([
      { name: NATIVE_TOOL, input: subagent.input, subagent: null },
      {
        name: NATIVE_TOOL,
        input: {
          tool: "Read",
          detail: { kind: "image", path: "scans/page-1.png" },
        },
        subagent: subagentCallId,
      },
      {
        name: "harness_web_search",
        input: { query: "lease arrears" },
        subagent: null,
      },
      {
        name: CONNECTOR_TOOL,
        input: connector.input,
        subagent: subagentCallId,
      },
      // The call the turn paused on names its subagent like any other, so
      // its approval card does too.
      {
        name: COMMAND_EXECUTION,
        input: { command: "rm draft.md" },
        subagent: subagentCallId,
      },
    ]);
    const pause = turn.emitted.findLast(
      (chunk) =>
        chunk.type === EventType.RUN_FINISHED &&
        chunk.outcome?.type === "interrupt",
    );
    if (
      pause?.type !== EventType.RUN_FINISHED ||
      pause.outcome?.type !== "interrupt"
    ) {
      panic("the served turn did not pause");
    }
    expect(pause.outcome.interrupts).toMatchObject([
      {
        id: requestId,
        metadata: {
          kind: "approval",
          toolName: COMMAND_EXECUTION,
          input: { command: "rm draft.md" },
        },
      },
    ]);
  });

  test("a second start of a call naming another tool is not carried, so the call keeps its first name and only its contract's fields", async () => {
    const secret = "Private settlement terms";
    const { turn: served } = await servedNativeTurn(async (runId) => {
      const sent = await harnessStreamChunks(runId, [
        {
          type: "session.started",
          sessionId: harnessSessionId("codex-session-restart"),
          continuation: { type: "fresh" },
        },
        {
          type: "tool.started",
          toolCall: {
            id: "item_cmd",
            name: COMMAND_EXECUTION,
            input: { command: "ls" },
          },
        },
      ]);
      const callId = "item_cmd";
      return [
        ...sent,
        // The same call again, now claiming a connector tool, with the
        // fields a connector call may carry.
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: callId,
          toolCallName: "mcp__docs__read",
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: callId,
          delta: JSON.stringify({ content: secret }),
        },
        {
          type: EventType.TOOL_CALL_END,
          toolCallId: callId,
          metadata: { tanstack: { input: { content: secret } } },
        },
        {
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: callId,
          messageId: "result-forged",
          content: JSON.stringify({ aggregated_output: secret }),
        },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "msg_r1",
          role: "assistant",
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "msg_r1",
          delta: "Done.",
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: "msg_r1" },
        { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" },
      ];
    }, "codex-session-restart");
    expect(served.finish.outcome).toMatchObject({ type: "completed" });
    const stored = persistTurn(served.finish, "harness").unwrap();
    expect(JSON.stringify({ emitted: served.emitted, stored })).not.toContain(
      secret,
    );
    expect(
      stored.reloaded.parts.flatMap((part): unknown[] =>
        part.type === "tool-call"
          ? [{ name: part.name, input: part.input, output: part.output }]
          : [],
      ),
    ).toEqual([
      {
        name: COMMAND_EXECUTION,
        input: { command: "ls" },
        output: { status: "completed" },
      },
    ]);
  });

  test("an answer from another turn of the same thread does not reach the run", async () => {
    const chatThreadId = await newThread();
    const pausedTurnId = turnOf(chatThreadId);
    const { desktopId, desktop } = shared();
    const requestId = Bun.randomUUIDv7();
    const pausedTurn = collect(
      createLocalChatRun(contextFor(chatThreadId), startPlan(desktopId)).stream(
        {
          chatRunId: "chat-run-paused-turn",
          chatTurnId: pausedTurnId,
          messages: [{ role: "user", content: "Run the tests" }],
          instructions: "You are stella.",
          resume: undefined,
          abortSignal: new AbortController().signal,
        },
      ),
    );
    const start = await desktop.receive("run.start");
    desktop.send({ type: "run.accepted", runId: start.runId });
    const run = desktopRun(desktop, start.runId);
    await run.approvalRequest(requestId);
    await run.events(
      await harnessChunks(start.runId, [
        {
          type: "approval.requested",
          request: {
            requestId,
            kind: "command",
            toolCall: { id: "item_3", name: "command_execution", input: {} },
            reason: null,
            options: [{ id: "accept", decision: "approve" }],
          },
        },
      ]).then((chunks) =>
        chunks.filter(
          (chunk) => !isRecord(chunk) || chunk["type"] !== EventType.RUN_ERROR,
        ),
      ),
    );
    await pausedTurn.done;
    const laterTurnId = await nextTurn(chatThreadId);

    const later = await collect(
      createLocalChatRun(contextFor(chatThreadId), {
        type: "resume",
        harness: "codex",
      }).stream({
        chatRunId: "chat-run-later-turn",
        chatTurnId: laterTurnId,
        messages: [],
        instructions: "",
        resume: [{ interruptId: requestId, status: "resolved", payload: true }],
        abortSignal: new AbortController().signal,
      }),
    ).done;
    expect(later.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: AI_FAILURE_CODES.local_runner_unavailable,
    });
    expect(await commandsOf(start.runId, "run.approval")).toEqual([]);
  });

  test("a read whose consumer stops pulling interrupts the run once", async () => {
    const chatThreadId = await newThread();
    const { desktopId, desktop } = shared();
    const stream = createLocalChatRun(
      contextFor(chatThreadId),
      startPlan(desktopId),
    ).stream({
      chatRunId: "chat-run-torn-down",
      chatTurnId: turnOf(chatThreadId),
      messages: [{ role: "user", content: "Work for a while" }],
      instructions: "You are stella.",
      resume: undefined,
      abortSignal: new AbortController().signal,
    });
    const reader = stream[Symbol.asyncIterator]();
    const firstChunk = reader.next();
    const start = await desktop.receive("run.start");
    desktop.send({ type: "run.accepted", runId: start.runId });
    const run = desktopRun(desktop, start.runId);
    await run.events(
      (await harnessChunks(start.runId, completedTurn)).slice(0, 4),
    );
    expect((await firstChunk).done).toBe(false);
    // The pipeline closes the read while it holds a chunk, as a turn whose
    // delivery or persistence ended early does.
    await reader.return?.(undefined);
    expect(
      (await desktop.receive("run.interrupt", ofRun(start.runId))).runId,
    ).toBe(start.runId);
    expect(await commandsOf(start.runId, "run.interrupt")).toHaveLength(1);
  });

  test("a stop that cuts the turn while nobody pulls its chunks interrupts the run once", async () => {
    const chatThreadId = await newThread();
    const { desktopId, desktop } = shared();
    const cut = new AbortController();
    const stream = createLocalChatRun(
      contextFor(chatThreadId),
      startPlan(desktopId),
    ).stream({
      chatRunId: "chat-run-cut",
      chatTurnId: turnOf(chatThreadId),
      messages: [{ role: "user", content: "Work for a while" }],
      instructions: "You are stella.",
      resume: undefined,
      abortSignal: cut.signal,
    });
    const reader = stream[Symbol.asyncIterator]();
    const firstChunk = reader.next();
    const start = await desktop.receive("run.start");
    desktop.send({ type: "run.accepted", runId: start.runId });
    const run = desktopRun(desktop, start.runId);
    await run.events(
      (await harnessChunks(start.runId, completedTurn)).slice(0, 4),
    );
    expect((await firstChunk).done).toBe(false);
    // The reader holds its next chunk; the stop arrives from the turn's
    // heartbeat, and nothing pulls again.
    cut.abort(RUN_CANCEL_REASON);
    expect(
      (await desktop.receive("run.interrupt", ofRun(start.runId))).runId,
    ).toBe(start.runId);
    // Closing the read afterwards adds nothing.
    await reader.return?.(undefined);
    expect(await commandsOf(start.runId, "run.interrupt")).toHaveLength(1);
  });

  /** Pause a new turn of a new thread on the shared computer for an approval. */
  const pausedForApproval = async () => {
    const chatThreadId = await newThread();
    const chatTurnId = turnOf(chatThreadId);
    const { desktopId, desktop } = shared();
    const requestId = Bun.randomUUIDv7();
    const turn = collect(
      createLocalChatRun(contextFor(chatThreadId), startPlan(desktopId)).stream(
        {
          chatRunId: Bun.randomUUIDv7(),
          chatTurnId,
          messages: [{ role: "user", content: "Run the tests" }],
          instructions: "You are stella.",
          resume: undefined,
          abortSignal: new AbortController().signal,
        },
      ),
    );
    const start = await desktop.receive("run.start");
    desktop.send({ type: "run.accepted", runId: start.runId });
    const run = desktopRun(desktop, start.runId);
    await run.approvalRequest(requestId);
    await run.events(
      await harnessChunks(start.runId, [
        {
          type: "approval.requested",
          request: {
            requestId,
            kind: "command",
            toolCall: { id: "item_4", name: "command_execution", input: {} },
            reason: null,
            options: [{ id: "accept", decision: "approve" }],
          },
        },
      ]).then((chunks) =>
        chunks.filter(
          (chunk) => !isRecord(chunk) || chunk["type"] !== EventType.RUN_ERROR,
        ),
      ),
    );
    expect((await turn.done).at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "interrupt" },
    });
    return { chatThreadId, chatTurnId, desktop, requestId, runId: start.runId };
  };

  test("a run paused for an answer lives while its turn awaits it, and is cancelled once the turn ends otherwise", async () => {
    const awaiting = await pausedForApproval();
    const failed = await pausedForApproval();
    const stopped = await pausedForApproval();
    // One turn could not store its pause, another was stopped while it
    // waited: whatever ended a turn, on whichever task, it no longer holds
    // its run. The first still awaits its answer.
    await failTurn(failed.chatThreadId, failed.chatTurnId);
    await cancelTurn(stopped.chatTurnId, "user-stop");
    await chatInstance.gateway.sweep();
    for (const ended of [failed, stopped]) {
      expect(
        (await ended.desktop.receive("run.cancel", ofRun(ended.runId))).runId,
      ).toBe(ended.runId);
    }
    expect(await commandsOf(awaiting.runId, "run.cancel")).toEqual([]);
    // Once is enough: a later sweep queues nothing more.
    await chatInstance.gateway.sweep();
    for (const ended of [failed, stopped]) {
      expect(await commandsOf(ended.runId, "run.cancel")).toHaveLength(1);
    }
    // No reader interrupted a paused run: the pause handed it to the turn.
    for (const paused of [awaiting, failed, stopped]) {
      expect(await commandsOf(paused.runId, "run.interrupt")).toEqual([]);
    }
  });

  test("a run whose paused turn is deleted keeps its row and is cancelled on its computer", async () => {
    const paused = await pausedForApproval();
    // A truncation deletes the later turns of a thread with their messages.
    await db.delete(chatTurns).where(eq(chatTurns.id, paused.chatTurnId));
    await chatInstance.gateway.sweep();
    expect(
      (await paused.desktop.receive("run.cancel", ofRun(paused.runId))).runId,
    ).toBe(paused.runId);
    expect(await commandsOf(paused.runId, "run.cancel")).toHaveLength(1);
  });

  test("a resume the run cannot take fails the turn, and the failed turn's run is cancelled", async () => {
    const paused = await pausedForApproval();
    // An answer the gateway refuses: the run holds as many commands as one
    // run may, so the approval is never queued.
    const refusing: LocalRunContext = {
      ...contextFor(paused.chatThreadId),
      control: {
        ...control,
        answerApproval: async () => Result.ok({ type: "command_limit" }),
      },
    };
    const resumed = await collect(
      createLocalChatRun(refusing, { type: "resume", harness: "codex" }).stream(
        {
          chatRunId: Bun.randomUUIDv7(),
          chatTurnId: paused.chatTurnId,
          messages: [],
          instructions: "",
          resume: [
            {
              interruptId: paused.requestId,
              status: "resolved",
              payload: { approved: true },
            },
          ],
          abortSignal: new AbortController().signal,
        },
      ),
    ).done;
    expect(resumed.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: AI_FAILURE_CODES.local_runner_unavailable,
    });
    // The send stores that failure on the turn.
    await failTurn(paused.chatThreadId, paused.chatTurnId);
    await chatInstance.gateway.sweep();
    expect(
      (await paused.desktop.receive("run.cancel", ofRun(paused.runId))).runId,
    ).toBe(paused.runId);
  });
  /**
   * A new turn served as the send serves it, paused on a blocking question:
   * the live chunks, the stored message with the resume snapshot the send
   * attaches to an awaiting turn, and a reload of it.
   */
  /** What a desktop adds to a question's pause; it is never kept. */
  const QUESTION_PAUSE_EXTRA = "Desktop-only note";

  const servedQuestionPause = async () => {
    const chatThreadId = await newThread();
    const chatTurnId = turnOf(chatThreadId);
    const { desktopId, desktop } = shared();
    const requestId = Bun.randomUUIDv7();
    const responseMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
    const question = {
      id: "item_law",
      name: HARNESS_QUESTION_TOOL,
      input: { questions: [{ id: "law" }] },
    };
    const localTurn = (resume?: RunAgentResumeItem[]) =>
      createLocalChatRun(
        contextFor(chatThreadId),
        resume === undefined
          ? startPlan(desktopId)
          : { type: "resume", harness: "codex" },
      ).stream({
        chatRunId: Bun.randomUUIDv7(),
        chatTurnId,
        messages: [{ role: "user", content: "Review the lease" }],
        instructions: "You are stella.",
        resume,
        abortSignal: new AbortController().signal,
      });
    const pausedServed = serveTurn(localTurn(), responseMessageId);
    const start = await desktop.receive("run.start");
    desktop.send({ type: "run.accepted", runId: start.runId });
    const sent = await harnessChunks(start.runId, [
      {
        type: "session.started",
        sessionId: harnessSessionId("codex-session-law"),
        continuation: { type: "fresh" },
      },
      {
        type: "question.requested",
        request: {
          requestId,
          toolCall: question,
          questions: [
            {
              id: "law",
              header: "Governing law",
              prompt: "Which law governs the lease?",
              options: [
                { label: "Czech", description: "Czech Civil Code" },
                { label: "Slovak", description: "Slovak Civil Code" },
              ],
              allowsFreeText: false,
              multiSelect: false,
              secret: false,
            },
          ],
          answerWith: "response",
        },
      },
      { type: "interaction.resolved", requestId },
      {
        type: "tool.completed",
        toolCall: question,
        result: { content: "Czech", status: "succeeded" },
      },
      { type: "text.completed", messageId: "msg_law", text: "Czech law." },
      { type: "turn.completed", usage: null },
    ]);
    const pauseAt =
      sent.findIndex(
        (chunk) =>
          isRecord(chunk) &&
          chunk["type"] === EventType.RUN_FINISHED &&
          isRecord(chunk["outcome"]) &&
          chunk["outcome"]["type"] === "interrupt",
      ) + 1;
    expect(pauseAt).toBeGreaterThan(0);
    const run = desktopRun(desktop, start.runId);
    // A desktop that puts more on the question's pause than it asks.
    await run.events(
      sent.slice(0, pauseAt).map((chunk) =>
        isRecord(chunk) &&
        chunk["type"] === EventType.RUN_FINISHED &&
        isRecord(chunk["outcome"]) &&
        Array.isArray(chunk["outcome"]["interrupts"])
          ? {
              ...chunk,
              outcome: {
                ...chunk["outcome"],
                interrupts: chunk["outcome"]["interrupts"].map(
                  (interrupt: unknown) =>
                    isRecord(interrupt) && isRecord(interrupt["metadata"])
                      ? {
                          ...interrupt,
                          expiresAt: QUESTION_PAUSE_EXTRA,
                          metadata: {
                            ...interrupt["metadata"],
                            output: QUESTION_PAUSE_EXTRA,
                          },
                        }
                      : interrupt,
                ),
              },
            }
          : chunk,
      ),
    );
    const paused = await pausedServed;
    const pause = paused.emitted.findLast(
      (chunk) =>
        chunk.type === EventType.RUN_FINISHED &&
        chunk.outcome?.type === "interrupt",
    );
    if (
      pause?.type !== EventType.RUN_FINISHED ||
      pause.outcome?.type !== "interrupt"
    ) {
      return panic("the served turn did not pause");
    }
    // As `streamChat` stores an awaiting turn: with its interrupts.
    const finish: StreamChatFinishEvent = {
      ...paused.finish,
      responseMessage: {
        ...paused.finish.responseMessage,
        metadata: {
          ...paused.finish.responseMessage.metadata,
          resumeSnapshot: {
            resumeState: { threadId: chatThreadId, runId: pause.runId },
            pendingInterrupts: pause.outcome.interrupts,
          },
        },
      },
    };
    const stored = persistTurn(finish, "harness").unwrap();
    return {
      chatThreadId,
      desktop,
      interrupts: pause.outcome.interrupts,
      localTurn,
      pause,
      paused,
      pauseAt,
      requestId,
      responseMessageId,
      run,
      runId: start.runId,
      sent,
      stored,
    };
  };

  /**
   * The continuation the page sends for a question it answers (`answers`)
   * or dismisses (`null`), resuming the question's interrupt.
   */
  const pageAnswer = async (
    served: Awaited<ReturnType<typeof servedQuestionPause>>,
    answers: Record<string, string[]> | null,
  ) => {
    const continued = Promise.withResolvers<{
      message: UIMessage | ModelMessage | undefined;
      resume: RunAgentResumeItem[];
    }>();
    const client = new ChatClient({
      threadId: served.chatThreadId,
      connection: {
        async *connect(messages, _data, _signal, runContext) {
          if (runContext?.resume !== undefined) {
            continued.resolve({
              message: messages.at(-1),
              resume: runContext.resume,
            });
            return;
          }
          yield* served.paused.emitted;
        },
      },
    });
    await client.sendMessage("Review the lease");
    // The page shows the question the reload shows.
    expect(shownParts(client.getMessages().at(-1)?.parts ?? [])).toEqual(
      shownParts(served.stored.reloaded.parts),
    );
    void client.resumeInterruptsUnsafe([
      answers === null
        ? { interruptId: served.requestId, status: "cancelled" }
        : {
            interruptId: served.requestId,
            status: "resolved",
            payload: { answers },
          },
    ]);
    const request = await continued.promise;
    return { message: assistantOf(request.message), resume: request.resume };
  };

  /** The send's validation of a continuation of the stored paused turn. */
  const validateContinuation = async (
    served: Awaited<ReturnType<typeof servedQuestionPause>>,
    continuation: {
      message: ReturnType<typeof assistantOf>;
      resume: RunAgentResumeItem[] | undefined;
    },
    ownership: ChatToolCallOwnership,
  ) =>
    await validateMessage({
      message: continuation.message,
      persistedMessage: { role: "assistant", content: served.stored.content },
      refRegistry: createChatRefRegistry(),
      resume: continuation.resume,
      safeDb: noDbReads,
      threadId: served.chatThreadId,
      toolCallOwnership: ownership,
      tools: {},
      userId: ids.userA1,
    });

  test("a question pause awaits the member, survives a reload, and the page's answer continues the same run once", async () => {
    const served = await servedQuestionPause();
    // The turn waits on the harness's question, a pause of its own kind.
    const callId =
      served.interrupts.at(0)?.toolCallId ?? panic("the pause names no call");
    expect(served.paused.finish.outcome).toEqual({
      type: "awaiting-user",
      interaction: { type: "harness-question", toolCallId: callId },
    });
    // A reload reads the question back as the live pause handed it out: the
    // call still open and the harness's, the interrupt with its questions.
    const reloadedCall = served.stored.reloaded.parts.find(
      (part) => part.type === "tool-call" && part.id === callId,
    );
    expect(reloadedCall).toMatchObject({
      name: HARNESS_QUESTION_TOOL,
      state: "input-complete",
    });
    expect(chatToolExecutor(reloadedCall)).toBe(CHAT_TOOL_EXECUTOR.harness);
    const reloadedSnapshot = served.stored.reloaded.metadata?.resumeSnapshot;
    expect(
      questionInterruptOf(reloadedSnapshot?.pendingInterrupts ?? []),
    ).toEqual(questionPauseOf(served.pause));
    // What the desktop added to the pause is in neither the stream nor the
    // stored turn.
    expect(
      JSON.stringify({ pause: served.pause, stored: served.stored }),
    ).not.toContain(QUESTION_PAUSE_EXTRA);
    expect(questionPauseOf(served.pause)).toMatchObject({
      type: "question",
      requestId: served.requestId,
      toolCallId: callId,
      questions: [{ id: "law" }],
    });

    const answered = await pageAnswer(served, { law: ["Czech"] });
    // Only the computer that holds the question answers it.
    expect(
      Result.isError(await validateContinuation(served, answered, "cloud")),
    ).toBe(true);
    const accepted = (
      await validateContinuation(served, answered, "harness")
    ).unwrap();
    // Answers the question would refuse never leave the API.
    const refusals: [string, unknown][] = [
      ["no reply", undefined],
      ["answers as text", { answers: { law: "Czech" } }],
      ["an option the question lacks", { answers: { law: ["Austrian"] } }],
      ["a question left out", { answers: {} }],
      [
        "two answers to a single choice",
        { answers: { law: ["Czech", "Slovak"] } },
      ],
      [
        "a question never asked",
        { answers: { law: ["Czech"], venue: ["Brno"] } },
      ],
    ];
    for (const [name, payload] of refusals) {
      const refused = await validateContinuation(
        served,
        {
          message: answered.message,
          resume: [
            {
              interruptId: served.requestId,
              status: "resolved",
              ...(payload === undefined ? {} : { payload }),
            },
          ],
        },
        "harness",
      );
      expect({ name, refused: Result.isError(refused) }).toEqual({
        name,
        refused: true,
      });
    }
    // An answer naming another request, or none at all, is no answer.
    for (const resume of [
      [
        {
          interruptId: Bun.randomUUIDv7(),
          status: "resolved" as const,
          payload: { answers: { law: ["Czech"] } },
        },
      ],
      undefined,
    ]) {
      expect(
        Result.isError(
          await validateContinuation(
            served,
            { message: answered.message, resume },
            "harness",
          ),
        ),
      ).toBe(true);
    }

    // The answer reaches the run that asked, once, and the turn reads on.
    const resumedServed = serveTurn(
      served.localTurn(answered.resume),
      served.responseMessageId,
      [accepted.message],
    );
    expect(
      await served.desktop.receive("run.answer", ofRun(served.runId)),
    ).toEqual({
      type: "run.answer",
      runId: served.runId,
      requestId: served.requestId,
      answers: { law: ["Czech"] },
    });
    await served.run.events(served.sent.slice(served.pauseAt));
    await served.run.finish("completed", "codex-session-law");
    const resumed = await resumedServed;
    expect(resumed.finish.outcome).toEqual({ type: "completed" });
    expect(await commandsOf(served.runId, "run.answer")).toHaveLength(1);
    expect(await commandsOf(served.runId, "run.interrupt")).toEqual([]);
    const finished = persistTurn(resumed.finish, "harness").unwrap();
    expect(
      finished.reloaded.parts.flatMap((part): [string, string][] =>
        part.type === "tool-call" ? [[part.name, part.state]] : [],
      ),
    ).toEqual([[HARNESS_QUESTION_TOOL, "complete"]]);
    expect(
      finished.reloaded.parts.some(
        (part) => part.type === "text" && part.content === "Czech law.",
      ),
    ).toBe(true);
  });

  test("a question the page dismisses is accepted and stops the run's turn", async () => {
    const served = await servedQuestionPause();
    const dismissed = await pageAnswer(served, null);
    expect(dismissed.resume).toEqual([
      { interruptId: served.requestId, status: "cancelled" },
    ]);
    expect(
      Result.isError(await validateContinuation(served, dismissed, "cloud")),
    ).toBe(true);
    const accepted = (
      await validateContinuation(served, dismissed, "harness")
    ).unwrap();
    const resumedServed = serveTurn(
      served.localTurn(dismissed.resume),
      served.responseMessageId,
      [accepted.message],
      dismissed.resume,
    );
    expect(
      (await served.desktop.receive("run.interrupt", ofRun(served.runId)))
        .runId,
    ).toBe(served.runId);
    await served.run.finish("interrupted", "codex-session-law");
    const resumed = await resumedServed;
    // The member's stop, as Stop would record it.
    expect(resumed.finish.outcome).toEqual({
      type: "cancelled",
      reason: "user-stop",
    });
    expect(await commandsOf(served.runId, "run.interrupt")).toHaveLength(1);
    expect(await commandsOf(served.runId, "run.answer")).toEqual([]);
  });
});

describe("undoing a turn's file changes", () => {
  type Thread = SafeId<"chatThread">;
  type Turn = SafeId<"chatTurn">;
  const MINUTE_MS = 60_000;
  let undoInstance: Instance;

  testState.beforeAll(async () => {
    // The account already holds the runners the earlier tests paired.
    undoInstance = await startInstance("api-undo", sharedDoorbell, {
      limits: { maxRunnersPerAccount: 1000 },
    });
  });

  const newThread = async (
    dataWorkspaceIds: SafeId<"workspace">[] = [],
  ): Promise<Thread> => {
    const id = toSafeId<"chatThread">(Bun.randomUUIDv7());
    await db.insert(chatThreads).values({
      id,
      organizationId: ids.orgA,
      userId: ids.userA1,
      title: "Files on this computer",
      dataWorkspaceIds,
    });
    return id;
  };

  const storeMessage = async (threadId: Thread, role: "user" | "assistant") => {
    const id = createSafeId<"chatMessage">();
    clock.now += 1;
    await db.insert(chatMessages).values({
      id,
      threadId,
      userId: ids.userA1,
      role,
      content: toPersistedChatMessageContentV3({
        data: [{ type: "text", content: `A ${role} message` }],
      }),
    });
    return id;
  };

  /**
   * A turn of the thread, running until `completeTurn` ends it. Its start
   * holds microseconds, as an accepted turn's does (the database's `now()`):
   * the newest-turn rule compares starts, and a whole millisecond would hide
   * a comparison that drops them.
   */
  const newTurn = async (threadId: Thread): Promise<Turn> => {
    const turnId = createSafeId<"chatTurn">();
    clock.now += 1;
    await db.insert(chatTurns).values({
      id: turnId,
      organizationId: ids.orgA,
      userId: ids.userA1,
      threadId,
      userMessageId: await storeMessage(threadId, "user"),
      status: "running",
      executionId: Bun.randomUUIDv7(),
      leaseExpiresAt: new Date(clock.now + DAY_MS),
      createdAt: sql`${new Date(clock.now).toISOString()}::timestamptz + interval '500 microseconds'`,
    });
    return turnId;
  };

  /** End a turn without an answer, as a refused run's turn ends. */
  const cancelUndoTurn = async (turnId: Turn) => {
    await db
      .update(chatTurns)
      .set({
        status: "cancelled",
        cancellationReason: "user-stop",
        executionId: null,
        leaseExpiresAt: null,
        settledAt: new Date(clock.now),
      })
      .where(eq(chatTurns.id, turnId));
  };

  const completeTurn = async (threadId: Thread, turnId: Turn) => {
    await db
      .update(chatTurns)
      .set({
        status: "completed",
        assistantMessageId: await storeMessage(threadId, "assistant"),
        executionId: null,
        leaseExpiresAt: null,
        settledAt: new Date(clock.now),
      })
      .where(eq(chatTurns.id, turnId));
  };

  const checkpointEvent = (runId: string, seq: number) => ({
    type: "run.event",
    runId,
    seq,
    chunk: {
      type: "CUSTOM",
      name: DESKTOP_RUNNER_CHECKPOINT_EVENT,
      value: { status: "taken" },
      timestamp: seq,
    },
  });

  /** Start the turn's run on the computer; the run.start it receives. */
  const startTurnRun = async (
    desktop: FakeDesktop,
    desktopId: string,
    chat: { threadId: Thread; turnId: Turn },
  ) => {
    const started = (
      await control.startRun({ ...startInput(desktopId), chat })
    ).unwrap();
    if (started.type !== "assigned") {
      return panic(`the run was not assigned: ${started.type}`);
    }
    return await desktop.receive("run.start", ofRun(started.runId));
  };

  /** A completed turn whose run saved the folder first, unless told not to. */
  const finishedTurn = async (
    desktop: FakeDesktop,
    desktopId: string,
    { threadId, checkpoint = true }: { threadId: Thread; checkpoint?: boolean },
  ) => {
    const turnId = await newTurn(threadId);
    const { runId } = await startTurnRun(desktop, desktopId, {
      threadId,
      turnId,
    });
    desktop.send({ type: "run.accepted", runId });
    const events = checkpoint ? [checkpointEvent(runId, 1)] : [];
    for (const event of events) {
      desktop.send(event);
      await desktop.receive("ack", ofRun(runId));
    }
    desktop.send({
      type: "run.finished",
      runId,
      seq: events.length + 1,
      outcome: "completed",
      harnessSessionId: null,
    });
    await desktop.receive("ack", ofRun(runId));
    await completeTurn(threadId, turnId);
    return { turnId, runId };
  };

  /** A computer on `protocol`, the current one unless a test names an older. */
  const connected = async (
    protocol: number = DESKTOP_RUNNER_PROTOCOL.current,
  ) => {
    const desktopId = Bun.randomUUIDv7();
    const desktop = await openDesktop(undoInstance, desktopId);
    await desktop.hello([], protocol);
    return { desktopId, desktop };
  };

  const request = async (threadId: Thread, turnId: Turn, by = owner) =>
    (
      await control.requestFolderRestore({ owner: by, threadId, turnId })
    ).unwrap();
  const read = async (threadId: Thread, turnId: Turn, by = owner) =>
    (await control.readFolderRestore({ owner: by, threadId, turnId })).unwrap();
  const accepted = async (threadId: Thread, turnId: Turn) => {
    const outcome = await request(threadId, turnId);
    return outcome.type === "accepted"
      ? outcome.restore
      : panic(`the undo was refused: ${outcome.reason}`);
  };
  /** The stored metadata of a turn's answer, as the page reads it. */
  const storedAnswerMetadata = async (turn: Turn) => {
    const [row] = await db
      .select({ id: chatMessages.id, content: chatMessages.content })
      .from(chatTurns)
      .innerJoin(
        chatMessages,
        eq(chatMessages.id, chatTurns.assistantMessageId),
      )
      .where(eq(chatTurns.id, turn));
    if (row === undefined) {
      return panic("the turn has no answer");
    }
    return chatMessageFromPersisted({ ...row, role: "assistant" }).metadata;
  };
  const settled = async (threadId: Thread, turnId: Turn) =>
    await waitForExternalState({
      description: "the computer's answer is stored",
      read: async () => {
        const undo = (await read(threadId, turnId))?.restore;
        return undo?.state === "sent" || undo?.state === "queued" ? null : undo;
      },
    });

  test("a relink settles the undo sent to the earlier key, which then blocks no run of the thread", async () => {
    const relinked = await createRlsDesktopCredentials(db, ids);
    const { desktopId, desktop } = await connected();
    const threadId = await newThread();
    const { turnId } = await finishedTurn(desktop, desktopId, { threadId });
    const undo = await accepted(threadId, turnId);
    await desktop.receive("folder.restore");
    expect((await read(threadId, turnId))?.restore?.state).toBe("sent");

    const after = await openDesktop(
      undoInstance,
      desktopId,
      await upgradeRequest(undoInstance, desktopId, relinked.a),
    );
    await after.hello();
    expect((await read(threadId, turnId))?.restore).toEqual({
      restoreId: undo.restoreId,
      state: "expired",
      reason: null,
    });
    const nextTurn = await newTurn(threadId);
    expect(
      (
        await control.startRun({
          ...startInput(desktopId),
          chat: { threadId, turnId: nextTurn },
        })
      ).unwrap().type,
    ).toBe("assigned");
    await after.close();
    await desktop.close();
  });

  test("the newest turn's undo reaches its computer once, survives a reload, and the next run is told once", async () => {
    const { desktopId, desktop } = await connected();
    const threadId = await newThread();
    const { turnId, runId } = await finishedTurn(desktop, desktopId, {
      threadId,
    });
    expect(await read(threadId, turnId)).toEqual({
      undoable: true,
      restore: null,
    });

    const undo = await accepted(threadId, turnId);
    expect(undo.state).toBe("queued");
    const sent = await desktop.receive("folder.restore");
    expect(sent).toEqual({
      type: "folder.restore",
      restoreId: undo.restoreId,
      folderId: threadId,
      linkedFolderId: null,
      runId,
    });
    // Asking again answers the same undo; nothing more is sent.
    expect(await accepted(threadId, turnId)).toEqual({
      restoreId: undo.restoreId,
      state: "sent",
      reason: null,
    });

    desktop.send({
      type: "folder.restored",
      restoreId: undo.restoreId,
      outcome: "restored",
    });
    expect(await settled(threadId, turnId)).toEqual({
      restoreId: undo.restoreId,
      state: "restored",
      reason: null,
    });
    // A repeated answer changes nothing, and the socket stays open.
    desktop.send({
      type: "folder.restored",
      restoreId: undo.restoreId,
      outcome: "failed",
    });
    desktop.send({
      type: "folder.restored",
      restoreId: Bun.randomUUIDv7(),
      outcome: "restored",
    });
    expect((await accepted(threadId, turnId)).state).toBe("restored");
    expect(
      desktop.received.filter(({ type }) => type === "folder.restore"),
    ).toHaveLength(1);

    // A run that carries the note but is refused before the computer
    // accepts it told nobody: the next run carries it again.
    const noteOf = async () =>
      (
        await db
          .select({
            notedAt: desktopRunnerFolderRestores.notedAt,
            notedRunId: desktopRunnerFolderRestores.notedRunId,
          })
          .from(desktopRunnerFolderRestores)
          .where(eq(desktopRunnerFolderRestores.id, undo.restoreId))
      ).at(0);
    const refusedTurn = await newTurn(threadId);
    const refused = await startTurnRun(desktop, desktopId, {
      threadId,
      turnId: refusedTurn,
    });
    expect(JSON.stringify(refused.messages.at(-1))).toContain(
      FOLDER_RESTORED_NOTE,
    );
    expect(await noteOf()).toEqual({
      notedAt: null,
      notedRunId: refused.runId,
    });
    desktop.send({
      type: "run.rejected",
      runId: refused.runId,
      reason: "at_capacity",
    });
    await waitForExternalState({
      description: "the refused run is stored as rejected",
      read: async () => (await runState(refused.runId))?.state === "rejected",
    });
    expect((await noteOf())?.notedAt).toBeNull();
    await cancelUndoTurn(refusedTurn);

    // The next run's request carries the note, told once the computer
    // accepts that run; later runs do not repeat it.
    const next = await newTurn(threadId);
    const told = await startTurnRun(desktop, desktopId, {
      threadId,
      turnId: next,
    });
    expect(JSON.stringify(told.messages.at(-1))).toContain(
      FOLDER_RESTORED_NOTE,
    );
    expect(await noteOf()).toEqual({ notedAt: null, notedRunId: told.runId });
    desktop.send({ type: "run.accepted", runId: told.runId });
    await waitForExternalState({
      description: "the accepted run's note is told",
      read: async () => (await noteOf())?.notedAt ?? null,
    });
    desktop.send({
      type: "run.finished",
      runId: told.runId,
      seq: 1,
      outcome: "completed",
      harnessSessionId: null,
    });
    await desktop.receive("ack", ofRun(told.runId));
    await completeTurn(threadId, next);
    const after = await startTurnRun(desktop, desktopId, {
      threadId,
      turnId: await newTurn(threadId),
    });
    expect(JSON.stringify(after.messages)).not.toContain(FOLDER_RESTORED_NOTE);
    await desktop.close();
  });

  test("a member who left a matter the thread holds data of can neither read nor ask an undo", async () => {
    const { desktopId, desktop } = await connected();
    const threadId = await newThread([ids.wsA2]);
    const { turnId, runId } = await finishedTurn(desktop, desktopId, {
      threadId,
    });
    const handlerContext = (access: "member" | "revoked") =>
      asTestRaw<never>({
        params: { threadId, turnId },
        safeDb: createMembershipSafeDb(db, {
          organizationId: ids.orgA,
          userId: ids.userA1,
          serverValidatedWorkspaceIds: [],
        }),
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
        getWorkspaceAccess: async (workspaceId: SafeId<"workspace">) =>
          await Promise.resolve(
            access === "member" ? { id: workspaceId, status: "active" } : null,
          ),
        recordAuditEvent: async () => await Promise.resolve(),
        createAuditRecorder: () => async () => await Promise.resolve(),
        memberRole: sessionMemberRole("member"),
        request: new Request("https://example.test/chat"),
        route: "/chat/threads/:threadId/turns/:turnId/local-files/undo",
        path: "/chat",
        headers: {},
        server: null,
        set: createResponseSet(),
        status: httpStatus,
      });
    const undoControl = () => control;
    const readUndo = createReadLocalFilesUndo({ control: undoControl });
    const askUndo = createUndoLocalFiles({ control: undoControl });
    /** The status code a refused request answers. */
    const statusOf = (result: unknown) =>
      isRecord(result) && typeof result["code"] === "number"
        ? result["code"]
        : null;

    await db
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.id, ids.memberA1wsA2));
    try {
      expect(statusOf(await readUndo.handler(handlerContext("revoked")))).toBe(
        404,
      );
      expect(statusOf(await askUndo.handler(handlerContext("revoked")))).toBe(
        404,
      );
      expect(
        await db
          .select({ id: desktopRunnerFolderRestores.id })
          .from(desktopRunnerFolderRestores)
          .where(eq(desktopRunnerFolderRestores.chatTurnId, turnId)),
      ).toEqual([]);
    } finally {
      await db.insert(workspaceMembers).values({
        id: ids.memberA1wsA2,
        workspaceId: ids.wsA2,
        userId: ids.userA1,
      });
    }

    // With the membership back, the same turn reads as undoable and its undo
    // reaches the computer.
    expect(await readUndo.handler(handlerContext("member"))).toEqual({
      undoable: true,
      undo: null,
    });
    expect(await askUndo.handler(handlerContext("member"))).toMatchObject({
      status: "accepted",
      undo: { state: "queued" },
    });
    expect((await desktop.receive("folder.restore")).runId).toBe(runId);
    await desktop.close();
  });

  test("an undone turn's answer carries the server's marker, which a newer turn leaves in place", async () => {
    const { desktopId, desktop } = await connected();
    const threadId = await newThread();
    const { turnId } = await finishedTurn(desktop, desktopId, { threadId });
    const undo = await accepted(threadId, turnId);
    await desktop.receive("folder.restore");
    desktop.send({
      type: "folder.restored",
      restoreId: undo.restoreId,
      outcome: "restored",
    });
    await settled(threadId, turnId);
    // A newer turn runs and finishes; the undone one is no longer the newest.
    const newer = await finishedTurn(desktop, desktopId, { threadId });

    expect((await storedAnswerMetadata(turnId))?.localFilesUndone).toEqual({
      at: expect.any(String),
    });
    expect((await storedAnswerMetadata(newer.turnId))?.localFilesUndone).toBe(
      undefined,
    );
    await desktop.close();
  });

  test("a refused undo leaves the answer unmarked", async () => {
    const { desktopId, desktop } = await connected();
    const threadId = await newThread();
    const { turnId } = await finishedTurn(desktop, desktopId, { threadId });
    const undo = await accepted(threadId, turnId);
    await desktop.receive("folder.restore");
    desktop.send({
      type: "folder.restored",
      restoreId: undo.restoreId,
      outcome: "folder_busy",
    });
    await settled(threadId, turnId);
    expect((await storedAnswerMetadata(turnId))?.localFilesUndone).toBe(
      undefined,
    );
    await desktop.close();
  });

  test("a turn's undo reads the same however many undos were asked before", async () => {
    const { desktopId, desktop } = await connected();
    const threadId = await newThread();
    const { turnId, runId } = await finishedTurn(desktop, desktopId, {
      threadId,
    });
    const counted = createDesktopRunnerControl({
      // SAFETY: PGlite and Bun SQL expose the same Drizzle query APIs.
      db: asTestRaw<DesktopRunnerDb>(withQueryLogger(db, queryCountLogger)),
      doorbell: sharedDoorbell,
      now,
      timing: TIMING,
    });
    const fixture = { control: counted, owner, threadId, turnId };
    const [runner] = await db
      .select({ deviceJkt: desktopRunners.deviceJkt })
      .from(desktopRunners)
      .where(eq(desktopRunners.desktopId, desktopId));
    const deviceJkt =
      runner?.deviceJkt ?? panic("the computer has a runner row");
    /** Undos the computer refused, each asked again after the last. */
    const refusedUndos = async (from: number, count: number) => {
      await db.insert(desktopRunnerFolderRestores).values(
        Array.from({ length: count }, (_, offset) => ({
          id: Bun.randomUUIDv7(),
          userId: ids.userA1,
          organizationId: ids.orgA,
          chatThreadId: threadId,
          chatTurnId: turnId,
          runId,
          desktopId,
          deviceJkt,
          state: "refused" as const,
          reason: "failed" as const,
          createdAt: new Date(clock.now + from + offset),
          expiresAt: new Date(clock.now + from + offset + MINUTE_MS),
          settledAt: new Date(clock.now + from + offset),
        })),
      );
    };
    // The small read already answers one undo, so both reads return the same
    // shape and only the undos asked before it differ.
    await refusedUndos(0, 1);
    const small = await chatLocalFilesUndoScalingScenario.measure(fixture);
    await refusedUndos(1, 20);
    const large = await chatLocalFilesUndoScalingScenario.measure(fixture);
    expect(small.statements).toBeGreaterThan(0);
    expect(readScalingViolations({ small, large })).toEqual([]);
    await desktop.close();
  });

  test("an undo still unanswered blocks runs only on its own computer", async () => {
    const own = await connected();
    const other = await connected();
    const threadId = await newThread();
    const { turnId } = await finishedTurn(own.desktop, own.desktopId, {
      threadId,
    });
    const undo = await accepted(threadId, turnId);
    // Sent and not answered: the computer may still be writing the folder.
    expect((await own.desktop.receive("folder.restore")).restoreId).toBe(
      undo.restoreId,
    );
    const next = await newTurn(threadId);
    // Another computer works in its own folder: its run starts.
    const elsewhere = (
      await control.startRun({
        ...startInput(other.desktopId),
        chat: { threadId, turnId: next },
      })
    ).unwrap();
    expect(elsewhere.type).toBe("assigned");
    // The undo's own computer starts no run in the folder until it answers.
    const here = (
      await control.startRun({
        ...startInput(own.desktopId),
        chat: { threadId, turnId: next },
      })
    ).unwrap();
    expect(here).toEqual({ type: "folder_busy" });
    await own.desktop.close();
    await other.desktop.close();
  });

  test("a desktop from before restores runs turns, is sent no restore, and its turns are not undone", async () => {
    const { desktopId, desktop } = await connected(
      DESKTOP_RUNNER_PROTOCOL.minimum,
    );
    expect(DESKTOP_RUNNER_PROTOCOL.minimum).toBeLessThan(
      DESKTOP_RUNNER_FOLDER_RESTORE_PROTOCOL,
    );
    const threadId = await newThread();
    const { turnId } = await finishedTurn(desktop, desktopId, { threadId });
    expect(await request(threadId, turnId)).toEqual({
      type: "refused",
      reason: "desktop_update_required",
    });
    await undoInstance.gateway.sweep();
    expect(
      desktop.received.filter(({ type }) => type === "folder.restore"),
    ).toEqual([]);
    expect(
      await db
        .select({ id: desktopRunnerFolderRestores.id })
        .from(desktopRunnerFolderRestores)
        .where(eq(desktopRunnerFolderRestores.chatTurnId, turnId)),
    ).toEqual([]);
    await desktop.close();
  });

  test("only the member's newest finished turn with a checkpoint is undone, and only while its computer is online", async () => {
    const { desktopId, desktop } = await connected();
    const threadId = await newThread();
    const older = await finishedTurn(desktop, desktopId, { threadId });
    const plain = await finishedTurn(desktop, desktopId, {
      threadId,
      checkpoint: false,
    });
    expect(await request(threadId, older.turnId)).toEqual({
      type: "refused",
      reason: "not_newest",
    });
    // Read as the undo decides: an older turn is not undoable.
    expect((await read(threadId, older.turnId))?.undoable).toBe(false);
    expect(await request(threadId, plain.turnId)).toEqual({
      type: "refused",
      reason: "no_checkpoint",
    });
    expect((await read(threadId, plain.turnId))?.undoable).toBe(false);

    // The member in another organization sees no turn.
    const outsider = { userId: ids.userA1, organizationId: ids.orgB };
    expect(await request(threadId, plain.turnId, outsider)).toEqual({
      type: "refused",
      reason: "not_found",
    });
    expect(await read(threadId, plain.turnId, outsider)).toBeNull();

    const newest = await finishedTurn(desktop, desktopId, { threadId });
    const running = await newTurn(threadId);
    expect(await request(threadId, newest.turnId)).toEqual({
      type: "refused",
      reason: "not_newest",
    });
    await db.delete(chatTurns).where(eq(chatTurns.id, running));

    await desktop.close();
    expect(await request(threadId, newest.turnId)).toEqual({
      type: "refused",
      reason: "desktop_offline",
    });
    expect(
      await db
        .select({ id: desktopRunnerFolderRestores.id })
        .from(desktopRunnerFolderRestores)
        .where(eq(desktopRunnerFolderRestores.chatThreadId, threadId)),
    ).toEqual([]);
  });

  test("a run still open in the thread refuses an undo", async () => {
    const { desktopId, desktop } = await connected();
    const threadId = await newThread();
    const done = await finishedTurn(desktop, desktopId, { threadId });
    // A run of the turn is still open on the computer.
    await startTurnRun(desktop, desktopId, { threadId, turnId: done.turnId });
    expect(await request(threadId, done.turnId)).toEqual({
      type: "refused",
      reason: "thread_busy",
    });
    await desktop.close();
  });

  test("the computer's refusal is stored with its reason, and the turn can be asked again", async () => {
    const { desktopId, desktop } = await connected();
    const threadId = await newThread();
    const { turnId } = await finishedTurn(desktop, desktopId, { threadId });
    for (const outcome of [
      "not_newest",
      "no_checkpoint",
      "folder_busy",
      "failed",
    ] as const) {
      const undo = await accepted(threadId, turnId);
      expect(undo.state).toBe("queued");
      const sent = await desktop.receive(
        "folder.restore",
        (message) =>
          message.type === "folder.restore" &&
          message.restoreId === undo.restoreId,
      );
      desktop.send({
        type: "folder.restored",
        restoreId: sent.restoreId,
        outcome,
      });
      expect(await settled(threadId, turnId)).toEqual({
        restoreId: undo.restoreId,
        state: "refused",
        reason: outcome,
      });
    }
    // A refused undo leaves nothing for the next run to be told.
    const next = await startTurnRun(desktop, desktopId, {
      threadId,
      turnId: await newTurn(threadId),
    });
    expect(JSON.stringify(next.messages)).not.toContain(FOLDER_RESTORED_NOTE);
    await desktop.close();
  });

  test("an undo no socket took expires and blocks no run after; one sent is sent again on the next socket and settles late", async () => {
    const threadId = await newThread();
    const { desktopId, desktop } = await connected();
    const { turnId, runId } = await finishedTurn(desktop, desktopId, {
      threadId,
    });
    await desktop.close();
    // The computer's row still reads connected and fresh, but no socket of
    // any API task holds it: the undo waits queued.
    await db
      .update(desktopRunners)
      .set({
        connection: "connected",
        instanceId: "api-elsewhere",
        sessionId: Bun.randomUUIDv7(),
        lastSeenAt: now(),
      })
      .where(eq(desktopRunners.desktopId, desktopId));
    const waiting = await accepted(threadId, turnId);
    expect(waiting.state).toBe("queued");
    // No run starts in the folder while the undo may still happen.
    const blockedTurn = await newTurn(threadId);
    const blocked = (
      await control.startRun({
        ...startInput(desktopId),
        chat: { threadId, turnId: blockedTurn },
      })
    ).unwrap();
    expect(blocked).toEqual({ type: "folder_busy" });
    await db.delete(chatTurns).where(eq(chatTurns.id, blockedTurn));

    clock.now += 2 * MINUTE_MS + 1;
    expect((await read(threadId, turnId))?.restore).toEqual({
      restoreId: waiting.restoreId,
      state: "expired",
      reason: null,
    });

    // Back online: the expired undo is never sent, and a new one is.
    const back = await openDesktop(undoInstance, desktopId);
    await back.hello();
    const again = await accepted(threadId, turnId);
    expect(again.restoreId).not.toBe(waiting.restoreId);
    const sent = await back.receive("folder.restore");
    expect(sent).toMatchObject({ restoreId: again.restoreId, runId });
    expect(
      back.received.filter(
        (message) =>
          message.type === "folder.restore" &&
          message.restoreId === waiting.restoreId,
      ),
    ).toEqual([]);

    // The socket drops before the answer: the next socket gets it again, and
    // its answer settles the undo however late it comes.
    await back.close();
    clock.now += 10 * MINUTE_MS;
    const later = await openDesktop(undoInstance, desktopId);
    await later.hello();
    const resent = await later.receive("folder.restore");
    expect(resent.restoreId).toBe(again.restoreId);
    later.send({
      type: "folder.restored",
      restoreId: again.restoreId,
      outcome: "restored",
    });
    expect(await settled(threadId, turnId)).toMatchObject({
      restoreId: again.restoreId,
      state: "restored",
    });
    await later.close();
  });

  test("the sweep sends an undo whose ring was lost", async () => {
    const { desktopId, desktop } = await connected();
    const threadId = await newThread();
    const { turnId } = await finishedTurn(desktop, desktopId, { threadId });
    const undo = (
      await requestFolderRestore(gatewayDb, {
        owner,
        threadId,
        turnId,
        restoreId: Bun.randomUUIDv7(),
        now: now(),
        seenSince: new Date(clock.now - TIMING.runnerFreshnessMs),
        expiresInMs: 2 * MINUTE_MS,
      })
    ).type;
    // Queued without ringing the doorbell, as a lost ring leaves it.
    expect(undo).toBe("queued");
    await undoInstance.gateway.sweep();
    expect((await desktop.receive("folder.restore")).folderId).toBe(threadId);
    await desktop.close();
  });
});
