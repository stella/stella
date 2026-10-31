import { EventType } from "@tanstack/ai";
import type { ModelMessage } from "@tanstack/ai";
import { Result } from "better-result";
import * as v from "valibot";

import { AGENT_HARNESSES } from "./agent-harness";
import { API_STORABLE_INSTANT_CHECK } from "./api-date";
import type { DesktopFeatureId } from "./desktop-feature-access";
import {
  desktopProtocolSchema,
  desktopVersionSchema,
} from "./desktop-presence";

/**
 * Wire contract for the outbound WebSocket a desktop runner holds to the API.
 * The desktop runs a coding-agent harness locally and streams what it
 * produces; the API sends run commands.
 *
 * Compatibility rules:
 * - The protocol is one integer. The API accepts `current` and the version
 *   before it, so a change keeps every message of the previous version valid,
 *   and the API sends a desktop only message types of the version it accepted.
 * - Unknown fields are ignored (objects strip them). Unknown message types,
 *   chunk types and closed values are rejected.
 * - `hello` keeps `type` and `protocol` stable across versions, so the API can
 *   read the version of a desktop whose other fields it cannot parse.
 *
 * `desktop-runner.fixtures.json` holds valid examples of every message and
 * closed value plus rejected ones; the desktop's serde types round-trip the
 * same file, so either side drifting fails its tests.
 */
export const DESKTOP_RUNNER_PROTOCOL = { current: 1, minimum: 1 } as const;

/** Largest frame either side sends or accepts, in UTF-8 bytes. */
export const DESKTOP_RUNNER_MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * The desktop feature an account needs to hold runner sockets. The API refuses
 * the upgrade without it and closes open sockets once it is turned off.
 */
export const DESKTOP_RUNNER_FEATURE_ID =
  "local-agents" as const satisfies DesktopFeatureId;

/**
 * What one account may hold through runner sockets and what one run may
 * store. The API enforces each; a desktop speaks the protocol without them.
 */
export type DesktopRunnerLimits = {
  /** Installations (installation id and device key) per account and organization. */
  readonly maxRunnersPerAccount: number;
  /**
   * How long a run may wait to be accepted, or for its computer to return,
   * before the API ends it as lost.
   */
  readonly abandonedRunMs: number;
  /** Sequenced messages (events, approval requests, the final one) one run may store. */
  readonly maxMessagesPerRun: number;
  /** UTF-8 bytes of sequenced messages one run may store. */
  readonly maxMessageBytesPerRun: number;
  /** Commands one run may queue, its `run.start` included. */
  readonly maxCommandsPerRun: number;
  /** How long an ended run, with its messages and commands, is kept. */
  readonly endedRunRetentionMs: number;
  /** UTF-8 bytes of frames one socket may have waiting to be stored. */
  readonly maxQueuedBytesPerSocket: number;
  /** Runner sockets one account may hold open on one API task. */
  readonly maxSocketsPerAccount: number;
};

export const DESKTOP_RUNNER_LIMITS = {
  maxRunnersPerAccount: 10,
  abandonedRunMs: 24 * 60 * 60_000,
  maxMessagesPerRun: 20_000,
  maxMessageBytesPerRun: 64 * 1024 * 1024,
  maxCommandsPerRun: 2000,
  endedRunRetentionMs: 30 * 24 * 60 * 60_000,
  maxQueuedBytesPerSocket: 4 * DESKTOP_RUNNER_MAX_FRAME_BYTES,
  maxSocketsPerAccount: 4,
} as const satisfies DesktopRunnerLimits;

export const DESKTOP_RUNNER_DESKTOP_MESSAGE = {
  hello: "hello",
  harnessStatus: "harness.status",
  runAccepted: "run.accepted",
  runRejected: "run.rejected",
  runEvent: "run.event",
  runApprovalRequest: "run.approval_request",
  runFinished: "run.finished",
} as const;

export const DESKTOP_RUNNER_SERVER_MESSAGE = {
  welcome: "welcome",
  upgradeRequired: "upgrade_required",
  reconnect: "reconnect",
  runStart: "run.start",
  runInput: "run.input",
  runApproval: "run.approval",
  runInterrupt: "run.interrupt",
  runCancel: "run.cancel",
  runToken: "run.token",
  ack: "ack",
} as const;

export const DESKTOP_RUNNER_HARNESS_STATE = {
  ready: "ready",
  needsLogin: "needs_login",
  limitUntil: "limit_until",
  notInstalled: "not_installed",
  unsupported: "unsupported",
} as const;

/** What a ready harness reports it can do; the API never assumes more. */
export const DESKTOP_RUNNER_HARNESS_CAPABILITIES = [
  "approvals",
  "interrupt",
  "resume",
  "image_input",
] as const;

/** Why a desktop refused a run command. */
export const DESKTOP_RUNNER_REJECT_REASONS = [
  "harness_not_installed",
  "harness_needs_login",
  "harness_limited",
  "harness_unsupported",
  "harness_version_unavailable",
  "model_unavailable",
  "policy_unsupported",
  "at_capacity",
  "unknown_run",
] as const;

export const DESKTOP_RUNNER_APPROVAL_KINDS = [
  "command",
  "file_change",
  "mcp_tool",
  "tool",
] as const;

export const DESKTOP_RUNNER_APPROVAL_DECISIONS = [
  "approve",
  "approve_for_session",
  "deny",
] as const;

export const DESKTOP_RUNNER_RUN_OUTCOMES = [
  "completed",
  "interrupted",
  "cancelled",
  "failed",
  "limit_reached",
  "needs_login",
] as const;

/**
 * A local run's sandbox. The network is open and file writes stay inside the
 * run workspace; workspace data is reachable only through the run's MCP token.
 */
export const DESKTOP_RUNNER_NETWORK_POLICIES = ["open"] as const;
export const DESKTOP_RUNNER_FS_POLICIES = ["workspace"] as const;

const MAX_SEQ = 4_294_967_295;
const MAX_ACTIVE_RUNS = 64;
const MAX_MODELS = 100;
const MAX_RUN_MESSAGES = 1000;
const MAX_RECONNECT_DELAY_MS = 600_000;
const MAX_MESSAGE_TYPE_LENGTH = 64;

const listsOnce = (keys: readonly string[]) =>
  new Set(keys).size === keys.length;

const runIdSchema = v.pipe(v.string(), v.uuid());
const requestIdSchema = v.pipe(v.string(), v.uuid());
/** Position of a desktop message in its run's stream, starting at 1. */
const seqSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(MAX_SEQ),
);
/** The last position a side holds; 0 before the first. */
const heldSeqSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(MAX_SEQ),
);
const instantSchema = v.pipe(
  v.string(),
  v.maxLength(32),
  v.isoTimestamp(),
  API_STORABLE_INSTANT_CHECK,
);
const harnessSchema = v.picklist(AGENT_HARNESSES);
const harnessSessionIdSchema = v.nullable(
  v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
);
const modelIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
/** Longest MCP token a run message carries. */
export const DESKTOP_RUNNER_MAX_TOKEN_LENGTH = 8192;
const tokenSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(DESKTOP_RUNNER_MAX_TOKEN_LENGTH),
);

const harnessModelSchema = v.object({
  id: modelIdSchema,
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
});

const harnessReportSchema = v.variant("state", [
  v.object({
    id: harnessSchema,
    state: v.literal(DESKTOP_RUNNER_HARNESS_STATE.ready),
    version: desktopVersionSchema,
    capabilities: v.pipe(
      v.array(v.picklist(DESKTOP_RUNNER_HARNESS_CAPABILITIES)),
      v.check(
        (capabilities) => listsOnce(capabilities),
        "Capabilities are listed once",
      ),
    ),
    models: v.pipe(
      v.array(harnessModelSchema),
      v.minLength(1),
      v.maxLength(MAX_MODELS),
      v.check(
        (items) => listsOnce(items.map(({ id }) => id)),
        "Model ids are listed once",
      ),
    ),
  }),
  v.object({
    id: harnessSchema,
    state: v.literal(DESKTOP_RUNNER_HARNESS_STATE.needsLogin),
    version: desktopVersionSchema,
  }),
  v.object({
    id: harnessSchema,
    state: v.literal(DESKTOP_RUNNER_HARNESS_STATE.limitUntil),
    version: desktopVersionSchema,
    resetsAt: instantSchema,
  }),
  v.object({
    id: harnessSchema,
    state: v.literal(DESKTOP_RUNNER_HARNESS_STATE.notInstalled),
  }),
  v.object({
    id: harnessSchema,
    state: v.literal(DESKTOP_RUNNER_HARNESS_STATE.unsupported),
    /** `null` when this desktop cannot run the harness at any version. */
    version: v.nullable(desktopVersionSchema),
  }),
]);
export type DesktopRunnerHarnessReport = v.InferOutput<
  typeof harnessReportSchema
>;
/** One harness report, for a consumer reading back reports it stored. */
export const desktopRunnerHarnessReportSchema = harnessReportSchema;

/**
 * A TanStack `StreamChunk` as it crosses the socket. Only its type is checked
 * against the TanStack event vocabulary; a consumer narrows the remaining
 * fields to `StreamChunk` before folding them into a message.
 */
const streamChunkSchema = v.looseObject({ type: v.enum(EventType) });
export type DesktopRunnerChunk = v.InferOutput<typeof streamChunkSchema>;

/** The roles of a TanStack `ModelMessage`, checked both ways in the tests. */
export const DESKTOP_RUNNER_MESSAGE_ROLES = [
  "user",
  "assistant",
  "tool",
] as const satisfies readonly ModelMessage["role"][];

/** A TanStack `ModelMessage` sent to the harness; only its role is checked. */
const modelMessageSchema = v.looseObject({
  role: v.picklist(DESKTOP_RUNNER_MESSAGE_ROLES),
});

export const desktopRunnerDesktopMessageSchema = v.variant("type", [
  v.object({
    type: v.literal(DESKTOP_RUNNER_DESKTOP_MESSAGE.hello),
    protocol: desktopProtocolSchema,
    appVersion: desktopVersionSchema,
    sidecarVersion: desktopVersionSchema,
    harnesses: v.pipe(
      v.array(harnessReportSchema),
      v.maxLength(AGENT_HARNESSES.length),
      v.check(
        (items) => listsOnce(items.map(({ id }) => id)),
        "Each harness reports once",
      ),
    ),
    /** Runs the desktop still holds, with the last position it produced. */
    activeRuns: v.pipe(
      v.array(v.object({ runId: runIdSchema, lastSeq: heldSeqSchema })),
      v.maxLength(MAX_ACTIVE_RUNS),
      v.check(
        (runs) => listsOnce(runs.map(({ runId }) => runId)),
        "Each run is listed once",
      ),
    ),
  }),
  v.object({
    type: v.literal(DESKTOP_RUNNER_DESKTOP_MESSAGE.harnessStatus),
    harness: harnessReportSchema,
  }),
  v.object({
    type: v.literal(DESKTOP_RUNNER_DESKTOP_MESSAGE.runAccepted),
    runId: runIdSchema,
  }),
  v.object({
    type: v.literal(DESKTOP_RUNNER_DESKTOP_MESSAGE.runRejected),
    runId: runIdSchema,
    reason: v.picklist(DESKTOP_RUNNER_REJECT_REASONS),
  }),
  v.object({
    type: v.literal(DESKTOP_RUNNER_DESKTOP_MESSAGE.runEvent),
    runId: runIdSchema,
    seq: seqSchema,
    chunk: streamChunkSchema,
  }),
  /**
   * Approval requests and the final message share the run's sequence with its
   * events, so one cumulative `ack` covers everything the desktop must resend.
   */
  v.object({
    type: v.literal(DESKTOP_RUNNER_DESKTOP_MESSAGE.runApprovalRequest),
    runId: runIdSchema,
    seq: seqSchema,
    requestId: requestIdSchema,
    kind: v.picklist(DESKTOP_RUNNER_APPROVAL_KINDS),
    summary: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
  }),
  v.object({
    type: v.literal(DESKTOP_RUNNER_DESKTOP_MESSAGE.runFinished),
    runId: runIdSchema,
    seq: seqSchema,
    outcome: v.picklist(DESKTOP_RUNNER_RUN_OUTCOMES),
    /** The harness session a later run resumes; `null` if none started. */
    harnessSessionId: harnessSessionIdSchema,
  }),
]);
export type DesktopRunnerDesktopMessage = v.InferOutput<
  typeof desktopRunnerDesktopMessageSchema
>;

export const desktopRunnerServerMessageSchema = v.variant("type", [
  v.object({
    type: v.literal(DESKTOP_RUNNER_SERVER_MESSAGE.welcome),
    protocol: desktopProtocolSchema,
    /** For each held run the API knows, the last position it persisted. */
    resume: v.pipe(
      v.array(v.object({ runId: runIdSchema, ackSeq: heldSeqSchema })),
      v.maxLength(MAX_ACTIVE_RUNS),
      v.check(
        (runs) => listsOnce(runs.map(({ runId }) => runId)),
        "Each run is listed once",
      ),
    ),
  }),
  v.object({
    type: v.literal(DESKTOP_RUNNER_SERVER_MESSAGE.upgradeRequired),
    minimumProtocol: desktopProtocolSchema,
    currentProtocol: desktopProtocolSchema,
  }),
  v.object({
    type: v.literal(DESKTOP_RUNNER_SERVER_MESSAGE.reconnect),
    afterMs: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(0),
      v.maxValue(MAX_RECONNECT_DELAY_MS),
    ),
  }),
  v.object({
    type: v.literal(DESKTOP_RUNNER_SERVER_MESSAGE.runStart),
    runId: runIdSchema,
    harness: harnessSchema,
    harnessVersion: desktopVersionSchema,
    model: modelIdSchema,
    /** The session to resume, from an earlier run's `run.finished`. */
    harnessSessionId: harnessSessionIdSchema,
    instructions: v.pipe(v.string(), v.maxLength(65_536)),
    messages: v.pipe(
      v.array(modelMessageSchema),
      v.minLength(1),
      v.maxLength(MAX_RUN_MESSAGES),
    ),
    policy: v.object({
      network: v.picklist(DESKTOP_RUNNER_NETWORK_POLICIES),
      fs: v.picklist(DESKTOP_RUNNER_FS_POLICIES),
    }),
    mcp: v.object({
      serverName: v.pipe(v.string(), v.regex(/^[a-z][a-z\d_]{0,63}$/u)),
      url: v.pipe(v.string(), v.maxLength(2048), v.url()),
      token: tokenSchema,
      expiresAt: instantSchema,
    }),
  }),
  v.object({
    type: v.literal(DESKTOP_RUNNER_SERVER_MESSAGE.runInput),
    runId: runIdSchema,
    inputId: v.pipe(v.string(), v.uuid()),
    message: v.looseObject({ role: v.literal("user") }),
  }),
  v.object({
    type: v.literal(DESKTOP_RUNNER_SERVER_MESSAGE.runApproval),
    runId: runIdSchema,
    requestId: requestIdSchema,
    decision: v.picklist(DESKTOP_RUNNER_APPROVAL_DECISIONS),
  }),
  v.object({
    type: v.literal(DESKTOP_RUNNER_SERVER_MESSAGE.runInterrupt),
    runId: runIdSchema,
  }),
  v.object({
    type: v.literal(DESKTOP_RUNNER_SERVER_MESSAGE.runCancel),
    runId: runIdSchema,
  }),
  /** A refreshed MCP token for the run, replacing the one it holds. */
  v.object({
    type: v.literal(DESKTOP_RUNNER_SERVER_MESSAGE.runToken),
    runId: runIdSchema,
    token: tokenSchema,
    expiresAt: instantSchema,
  }),
  /** Every desktop message of the run up to `seq` is persisted. */
  v.object({
    type: v.literal(DESKTOP_RUNNER_SERVER_MESSAGE.ack),
    runId: runIdSchema,
    seq: seqSchema,
  }),
]);
export type DesktopRunnerServerMessage = v.InferOutput<
  typeof desktopRunnerServerMessageSchema
>;

export const DESKTOP_RUNNER_FRAME_REJECTION = {
  tooLarge: "too_large",
  notJson: "not_json",
  unknownType: "unknown_type",
  invalid: "invalid",
} as const;
type DesktopRunnerFrameRejection =
  (typeof DESKTOP_RUNNER_FRAME_REJECTION)[keyof typeof DESKTOP_RUNNER_FRAME_REJECTION];

/** What one frame from a desktop turned out to be. */
export type DesktopRunnerFrame =
  | { type: "message"; message: DesktopRunnerDesktopMessage }
  | { type: "unsupported_protocol"; protocol: number }
  | {
      type: "rejected";
      reason: DesktopRunnerFrameRejection;
      /** The frame's `type`, bounded, when it had one. */
      messageType: string | null;
    };

const DESKTOP_MESSAGE_TYPES: ReadonlySet<string> = new Set(
  Object.values(DESKTOP_RUNNER_DESKTOP_MESSAGE),
);
const frameTypeSchema = v.object({ type: v.string() });
const helloProtocolSchema = v.object({
  type: v.literal(DESKTOP_RUNNER_DESKTOP_MESSAGE.hello),
  protocol: desktopProtocolSchema,
});

/** A UTF-16 code unit encodes to at most three UTF-8 bytes. */
const MAX_UTF8_BYTES_PER_CODE_UNIT = 3;

const exceedsFrameLimit = (frame: string) => {
  if (frame.length > DESKTOP_RUNNER_MAX_FRAME_BYTES) {
    return true;
  }
  if (
    frame.length * MAX_UTF8_BYTES_PER_CODE_UNIT <=
    DESKTOP_RUNNER_MAX_FRAME_BYTES
  ) {
    return false;
  }
  return (
    new TextEncoder().encode(frame).byteLength > DESKTOP_RUNNER_MAX_FRAME_BYTES
  );
};

const rejectFrame = (
  reason: DesktopRunnerFrameRejection,
  messageType: string | null,
): DesktopRunnerFrame => ({ type: "rejected", reason, messageType });

/**
 * Read one text frame a desktop sent. An unknown message type is its own
 * rejection, distinct from a known type with invalid fields, and a `hello`
 * outside the accepted protocol range is reported before its other fields are
 * read.
 */
export const parseDesktopRunnerFrame = (frame: string): DesktopRunnerFrame => {
  if (exceedsFrameLimit(frame)) {
    return rejectFrame(DESKTOP_RUNNER_FRAME_REJECTION.tooLarge, null);
  }
  const json = Result.try((): unknown => JSON.parse(frame));
  if (Result.isError(json)) {
    return rejectFrame(DESKTOP_RUNNER_FRAME_REJECTION.notJson, null);
  }
  const framed = v.safeParse(frameTypeSchema, json.value);
  if (!framed.success) {
    return rejectFrame(DESKTOP_RUNNER_FRAME_REJECTION.invalid, null);
  }
  const messageType = framed.output.type.slice(0, MAX_MESSAGE_TYPE_LENGTH);
  if (!DESKTOP_MESSAGE_TYPES.has(framed.output.type)) {
    return rejectFrame(DESKTOP_RUNNER_FRAME_REJECTION.unknownType, messageType);
  }
  const hello = v.safeParse(helloProtocolSchema, json.value);
  if (
    hello.success &&
    (hello.output.protocol < DESKTOP_RUNNER_PROTOCOL.minimum ||
      hello.output.protocol > DESKTOP_RUNNER_PROTOCOL.current)
  ) {
    return { type: "unsupported_protocol", protocol: hello.output.protocol };
  }
  const message = v.safeParse(desktopRunnerDesktopMessageSchema, json.value);
  if (!message.success) {
    return rejectFrame(DESKTOP_RUNNER_FRAME_REJECTION.invalid, messageType);
  }
  return { type: "message", message: message.output };
};
