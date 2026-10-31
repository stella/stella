import { EventType } from "@tanstack/ai";
import { Result } from "better-result";
import * as v from "valibot";

import { AGENT_HARNESSES } from "@stll/api-contract/agent-harness";
import { desktopVersionSchema } from "@stll/api-contract/desktop-presence";
import {
  DESKTOP_RUNNER_APPROVAL_DECISIONS,
  DESKTOP_RUNNER_APPROVAL_KINDS,
  DESKTOP_RUNNER_FS_POLICIES,
  DESKTOP_RUNNER_HARNESS_CAPABILITIES,
  DESKTOP_RUNNER_NETWORK_POLICIES,
  DESKTOP_RUNNER_RUN_OUTCOMES,
} from "@stll/api-contract/desktop-runner";

/**
 * Wire contract between the desktop app and its harness sidecar, the holder
 * process that keeps runs going while the app is closed: one JSON object per
 * line in each direction over the holder's local socket (a Unix socket, or a
 * named pipe on Windows). The holder writes its own log to a file, never to
 * the socket.
 *
 * Rules:
 * - The host sends `hello` first, carrying the secret the holder wrote next
 *   to its socket. A first line that is not a `hello` with that secret is
 *   closed without a reply. Both sides name `SIDECAR_PROTOCOL`; a mismatch is
 *   answered with `rejected` and closes the connection. Host and sidecar ship
 *   in one bundle, so there is no range.
 * - One host at a time: an authenticated connection replaces the previous
 *   one, which is closed. Closing a connection never stops a run.
 * - Every per-run message carries `seq`, numbered from 1 per run by the
 *   holder. The holder keeps each until the host acknowledges it (`ack`,
 *   cumulative) and sends the ones after the host's resume point again, in
 *   order, when the host resumes the run (`hello.resume` or `resume`). Only
 *   runs the connection started or resumed stream to it. The desktop relays
 *   `seq` unchanged as the runner protocol's sequence.
 * - Unknown fields are ignored (objects strip them). Unknown message types and
 *   closed values are rejected; the sidecar answers each rejected line with a
 *   `rejected` message naming why.
 * - Run ids, approval request ids, decisions, outcomes and policies use the
 *   desktop runner protocol's vocabulary, so the host relays them unchanged.
 *
 * `protocol.fixtures.json` holds valid and rejected examples of every message;
 * the desktop's serde types round-trip the same file.
 */
export const SIDECAR_PROTOCOL = 2;

/**
 * Largest line either side writes or accepts, in UTF-8 bytes. A `run.start`
 * carries a whole runner frame's transcript plus local paths.
 */
export const SIDECAR_MAX_LINE_BYTES = 8 * 1024 * 1024;

export const SIDECAR_HOST_MESSAGE = {
  hello: "hello",
  harnessProbe: "harness.probe",
  runStart: "run.start",
  runApproval: "run.approval",
  runInterrupt: "run.interrupt",
  runCancel: "run.cancel",
  runToken: "run.token",
  ack: "ack",
  resume: "resume",
  drain: "drain",
  shutdown: "shutdown",
} as const;

export const SIDECAR_MESSAGE = {
  hello: "hello",
  harnessProbed: "harness.probed",
  runEvent: "run.event",
  runApprovalRequest: "run.approval_request",
  runFinished: "run.finished",
  rejected: "rejected",
} as const;

/** Why the sidecar refused a line from the host. */
export const SIDECAR_REJECTIONS = [
  "too_large",
  "not_json",
  "unknown_type",
  "invalid",
  "hello_repeated",
  "protocol_mismatch",
  "unknown_run",
  "duplicate_run",
  "draining",
  "at_capacity",
  "origin_mismatch",
] as const;
export type SidecarRejection = (typeof SIDECAR_REJECTIONS)[number];

/** Why a probe could not report the harness. */
export const SIDECAR_PROBE_FAILURES = [
  "harness_unavailable",
  "protocol_violation",
  "unsupported",
] as const;

/** Whether a holder takes new runs or only finishes the ones it holds. */
export const SIDECAR_HOLDER_MODES = ["serving", "draining"] as const;
export type SidecarHolderMode = (typeof SIDECAR_HOLDER_MODES)[number];

/** Runs one `hello` may resume or list. */
export const SIDECAR_MAX_HELD_RUNS = 1000;

/** Hex characters of the secret a host presents in `hello`. */
export const SIDECAR_SECRET_HEX_LENGTH = 64;

const MAX_MESSAGE_TYPE_LENGTH = 64;
const MAX_MODELS = 100;
const MAX_RUN_MESSAGES = 1000;

const runIdSchema = v.pipe(v.string(), v.uuid());
const requestIdSchema = v.pipe(v.string(), v.uuid());
const seqSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
/** A position in a run's messages; 0 is before the first. */
const positionSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const protocolSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const secretSchema = v.pipe(
  v.string(),
  v.regex(new RegExp(`^[0-9a-f]{${SIDECAR_SECRET_HEX_LENGTH}}$`, "u")),
);
const harnessSchema = v.picklist(AGENT_HARNESSES);
const absolutePathSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(4096),
  v.check(
    (value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value),
    "An absolute path",
  ),
);
const tokenSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(8192));
const instantSchema = v.pipe(v.string(), v.maxLength(32), v.isoTimestamp());
const modelIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const originSchema = v.pipe(
  v.string(),
  v.maxLength(2048),
  v.url(),
  v.check((value) => {
    const url = URL.parse(value);
    return (
      url !== null &&
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === value
    );
  }, "An http(s) origin without a path"),
);

/** A TanStack `ModelMessage`; only its role is checked, as on the socket. */
const modelMessageSchema = v.looseObject({
  role: v.picklist(["user", "assistant", "tool"]),
});

/** A TanStack `StreamChunk`; only its type is checked, as on the socket. */
const EVENT_TYPES: ReadonlySet<string> = new Set(Object.values(EventType));
const chunkSchema = v.looseObject({
  type: v.pipe(
    v.string(),
    v.check((type) => EVENT_TYPES.has(type), "A TanStack event type"),
  ),
});

const harnessLaunchEntries = {
  harness: harnessSchema,
  /** The managed CLI the installer leased; never resolved from `PATH`. */
  executable: absolutePathSchema,
  /** The stella-owned home the CLI runs with (`CODEX_HOME`, ...). */
  configDir: absolutePathSchema,
};

const resumePointEntries = {
  runId: runIdSchema,
  /** The last `seq` the host holds; the holder sends the ones after it. */
  afterSeq: positionSchema,
};

/**
 * The fields every `hello` keeps across protocol versions, so a holder can
 * check the secret and answer a mismatch without reading the rest.
 */
export const sidecarHelloPreambleSchema = v.object({
  type: v.literal(SIDECAR_HOST_MESSAGE.hello),
  protocol: protocolSchema,
  secret: secretSchema,
});

export const sidecarHostMessageSchema = v.variant("type", [
  v.object({
    ...sidecarHelloPreambleSchema.entries,
    appVersion: desktopVersionSchema,
    /** The only upstream the MCP proxy forwards to. */
    apiOrigin: originSchema,
    /** Runs whose messages after each point the holder sends again. */
    resume: v.pipe(
      v.array(v.object(resumePointEntries)),
      v.maxLength(SIDECAR_MAX_HELD_RUNS),
    ),
  }),
  v.object({
    type: v.literal(SIDECAR_HOST_MESSAGE.harnessProbe),
    requestId: requestIdSchema,
    ...harnessLaunchEntries,
  }),
  v.object({
    type: v.literal(SIDECAR_HOST_MESSAGE.runStart),
    runId: runIdSchema,
    /** The stella thread the run's chunks are stamped with. */
    threadId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    ...harnessLaunchEntries,
    /** The directory the harness runs in and may write to. */
    workspaceDir: absolutePathSchema,
    model: modelIdSchema,
    instructions: v.pipe(v.string(), v.maxLength(65_536)),
    messages: v.pipe(
      v.array(modelMessageSchema),
      v.minLength(1),
      v.maxLength(MAX_RUN_MESSAGES),
    ),
    /** The native session to resume; `null` starts fresh. */
    harnessSessionId: v.nullable(
      v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
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
    type: v.literal(SIDECAR_HOST_MESSAGE.runApproval),
    runId: runIdSchema,
    requestId: requestIdSchema,
    decision: v.picklist(DESKTOP_RUNNER_APPROVAL_DECISIONS),
  }),
  v.object({
    type: v.literal(SIDECAR_HOST_MESSAGE.runInterrupt),
    runId: runIdSchema,
  }),
  v.object({
    type: v.literal(SIDECAR_HOST_MESSAGE.runCancel),
    runId: runIdSchema,
  }),
  /** A newer MCP token; the proxy uses it from the next request on. */
  v.object({
    type: v.literal(SIDECAR_HOST_MESSAGE.runToken),
    runId: runIdSchema,
    token: tokenSchema,
    expiresAt: instantSchema,
  }),
  /** The host's upstream stored every message of the run up to `seq`. */
  v.object({
    type: v.literal(SIDECAR_HOST_MESSAGE.ack),
    runId: runIdSchema,
    seq: seqSchema,
  }),
  /** Send the run's messages after `afterSeq` again, then its new ones. */
  v.object({
    type: v.literal(SIDECAR_HOST_MESSAGE.resume),
    ...resumePointEntries,
  }),
  /** Take no new runs; exit once every held run is finished and acked. */
  v.object({ type: v.literal(SIDECAR_HOST_MESSAGE.drain) }),
  /** Stop every run and exit. */
  v.object({ type: v.literal(SIDECAR_HOST_MESSAGE.shutdown) }),
]);
export type SidecarHostMessage = v.InferOutput<typeof sidecarHostMessageSchema>;
export type SidecarHostHello = Extract<SidecarHostMessage, { type: "hello" }>;
export type SidecarRunStart = Extract<
  SidecarHostMessage,
  { type: "run.start" }
>;

const probeOutcomeSchema = v.variant("type", [
  v.object({
    type: v.literal("ready"),
    version: desktopVersionSchema,
    capabilities: v.array(v.picklist(DESKTOP_RUNNER_HARNESS_CAPABILITIES)),
    models: v.pipe(
      v.array(
        v.object({
          id: modelIdSchema,
          label: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
          isDefault: v.boolean(),
        }),
      ),
      v.maxLength(MAX_MODELS),
    ),
  }),
  v.object({ type: v.literal("needs_login"), version: desktopVersionSchema }),
  /** A version the compatibility policy refuses for this desktop release. */
  v.object({
    type: v.literal("unsupported"),
    version: desktopVersionSchema,
    /** `null` when no policy covers this desktop release. */
    recommendedVersion: v.nullable(desktopVersionSchema),
  }),
  v.object({
    type: v.literal("failed"),
    reason: v.picklist(SIDECAR_PROBE_FAILURES),
    message: v.pipe(v.string(), v.maxLength(4000)),
  }),
]);
export type SidecarProbeOutcome = v.InferOutput<typeof probeOutcomeSchema>;

export const sidecarMessageSchema = v.variant("type", [
  v.object({
    type: v.literal(SIDECAR_MESSAGE.hello),
    protocol: protocolSchema,
    sidecarVersion: desktopVersionSchema,
    mode: v.picklist(SIDECAR_HOLDER_MODES),
    /** Every run the holder holds: running, or finished and not yet acked. */
    runs: v.pipe(
      v.array(
        v.object({
          runId: runIdSchema,
          harness: harnessSchema,
          /** The run's latest `seq`; 0 before its first message. */
          lastSeq: positionSchema,
        }),
      ),
      v.maxLength(SIDECAR_MAX_HELD_RUNS),
    ),
  }),
  v.object({
    type: v.literal(SIDECAR_MESSAGE.harnessProbed),
    requestId: requestIdSchema,
    harness: harnessSchema,
    outcome: probeOutcomeSchema,
  }),
  v.object({
    type: v.literal(SIDECAR_MESSAGE.runEvent),
    runId: runIdSchema,
    seq: seqSchema,
    chunk: chunkSchema,
  }),
  /** The same request id rides the chunk's interrupt and `run.approval`. */
  v.object({
    type: v.literal(SIDECAR_MESSAGE.runApprovalRequest),
    runId: runIdSchema,
    seq: seqSchema,
    requestId: requestIdSchema,
    kind: v.picklist(DESKTOP_RUNNER_APPROVAL_KINDS),
    summary: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
  }),
  /** The run's last message; every accepted `run.start` ends with one. */
  v.object({
    type: v.literal(SIDECAR_MESSAGE.runFinished),
    runId: runIdSchema,
    seq: seqSchema,
    outcome: v.picklist(DESKTOP_RUNNER_RUN_OUTCOMES),
    harnessSessionId: v.nullable(
      v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
    ),
  }),
  v.object({
    type: v.literal(SIDECAR_MESSAGE.rejected),
    reason: v.picklist(SIDECAR_REJECTIONS),
    /** The refused line's `type`, bounded, when it had one. */
    messageType: v.nullable(
      v.pipe(v.string(), v.maxLength(MAX_MESSAGE_TYPE_LENGTH)),
    ),
    runId: v.nullable(runIdSchema),
  }),
]);
export type SidecarMessage = v.InferOutput<typeof sidecarMessageSchema>;
export type SidecarHolderHello = Extract<SidecarMessage, { type: "hello" }>;
export type SidecarRunMessage = Extract<
  SidecarMessage,
  { type: "run.event" | "run.approval_request" | "run.finished" }
>;

type WithoutSeq<T> = T extends unknown ? Omit<T, "seq"> : never;
/** A per-run message before the holder numbers it. */
export type SidecarRunOutput = WithoutSeq<SidecarRunMessage>;
/** What the command loop writes; the holder numbers the run messages. */
export type SidecarHostOutput =
  Exclude<SidecarMessage, SidecarRunMessage> | SidecarRunOutput;

export type SidecarHostLine =
  | { type: "message"; message: SidecarHostMessage }
  | {
      type: "rejected";
      reason: Extract<
        SidecarRejection,
        "too_large" | "not_json" | "unknown_type" | "invalid"
      >;
      messageType: string | null;
    };

const HOST_MESSAGE_TYPES: ReadonlySet<string> = new Set(
  Object.values(SIDECAR_HOST_MESSAGE),
);
const lineTypeSchema = v.object({ type: v.string() });

export const utf8Length = (line: string) =>
  new TextEncoder().encode(line).byteLength;

/** A line as JSON; `null` when it is over the limit or not JSON. */
const parseJsonLine = (line: string): { value: unknown } | null => {
  if (utf8Length(line) > SIDECAR_MAX_LINE_BYTES) {
    return null;
  }
  const json = Result.try((): unknown => JSON.parse(line));
  return Result.isOk(json) ? { value: json.value } : null;
};

/**
 * Read one line the host wrote. An unknown type is its own rejection,
 * distinct from a known type with invalid fields.
 */
export const parseSidecarHostLine = (line: string): SidecarHostLine => {
  if (utf8Length(line) > SIDECAR_MAX_LINE_BYTES) {
    return { type: "rejected", reason: "too_large", messageType: null };
  }
  const json = parseJsonLine(line);
  if (json === null) {
    return { type: "rejected", reason: "not_json", messageType: null };
  }
  const typed = v.safeParse(lineTypeSchema, json.value);
  if (!typed.success) {
    return { type: "rejected", reason: "invalid", messageType: null };
  }
  const messageType = typed.output.type.slice(0, MAX_MESSAGE_TYPE_LENGTH);
  if (!HOST_MESSAGE_TYPES.has(typed.output.type)) {
    return { type: "rejected", reason: "unknown_type", messageType };
  }
  const parsed = v.safeParse(sidecarHostMessageSchema, json.value);
  return parsed.success
    ? { type: "message", message: parsed.output }
    : { type: "rejected", reason: "invalid", messageType };
};

/**
 * The stable part of a connection's first line, or `null` when the line is
 * not a `hello` at all; the holder then closes without a reply.
 */
export const parseSidecarHelloPreamble = (line: string) => {
  const json = parseJsonLine(line);
  if (json === null) {
    return null;
  }
  const parsed = v.safeParse(sidecarHelloPreambleSchema, json.value);
  return parsed.success ? parsed.output : null;
};

/** One socket line; `null` when the message cannot be framed within limits. */
export const encodeSidecarMessage = (
  message: SidecarMessage,
): string | null => {
  const line = JSON.stringify(v.parse(sidecarMessageSchema, message));
  return utf8Length(line) > SIDECAR_MAX_LINE_BYTES ? null : `${line}\n`;
};
