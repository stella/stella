import { EventType } from "@tanstack/ai";
import { Result } from "better-result";
import * as v from "valibot";

import { AGENT_HARNESSES } from "@stll/api-contract/agent-harness";
import { CHAT_LOCAL_RUN_TOOL_LIMITS } from "@stll/api-contract/chat-local-run-tool";
import { desktopVersionSchema } from "@stll/api-contract/desktop-presence";
import {
  DESKTOP_RUNNER_APPROVAL_DECISIONS,
  DESKTOP_RUNNER_APPROVAL_KINDS,
  DESKTOP_RUNNER_APPROVAL_MODES,
  DESKTOP_RUNNER_FS_POLICIES,
  DESKTOP_RUNNER_HARNESS_CAPABILITIES,
  DESKTOP_RUNNER_NETWORK_POLICIES,
  DESKTOP_RUNNER_REASONING_EFFORTS,
  DESKTOP_RUNNER_RUN_OUTCOMES,
  desktopRunnerAttachmentSchema,
  desktopRunnerQuestionAnswersSchema,
  MAX_RUN_ATTACHMENTS,
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
 *   runs the connection started or resumed stream to it. `seq` is the
 *   holder's own position: the desktop numbers what it relays upstream
 *   itself and acks a holder position once its own journal holds it.
 * - A harness process the desktop must authorize (`launch.processGrant`)
 *   is reported in `harness.process` before it is asked anything, and is
 *   used only after `harness.process_granted`. The report is sent again
 *   whenever a connection resumes a run whose process still runs.
 * - Unknown fields are ignored (objects strip them). Unknown message types and
 *   closed values are rejected; the sidecar answers each rejected line with a
 *   `rejected` message naming why.
 * - Run ids, approval request ids, decisions, outcomes and policies use the
 *   desktop runner protocol's vocabulary, so the host relays them unchanged.
 * - `folder.restore` puts a run's folder back as its checkpoint saved it
 *   (`checkpoints.ts`) and is answered by one `folder.restored`. It is not a
 *   run message: it is not numbered and goes to the current connection only.
 *
 * `protocol.fixtures.json` holds valid and rejected examples of every message;
 * the desktop's serde types round-trip the same file.
 */
export const SIDECAR_PROTOCOL = 4;

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
  runAnswer: "run.answer",
  runInterrupt: "run.interrupt",
  runCancel: "run.cancel",
  runToken: "run.token",
  ack: "ack",
  resume: "resume",
  harnessProcessGranted: "harness.process_granted",
  folderRestore: "folder.restore",
  drain: "drain",
  shutdown: "shutdown",
} as const;

export const SIDECAR_MESSAGE = {
  hello: "hello",
  harnessProbed: "harness.probed",
  harnessProcess: "harness.process",
  runEvent: "run.event",
  runApprovalRequest: "run.approval_request",
  runFinished: "run.finished",
  folderRestored: "folder.restored",
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

/**
 * How a folder restore ended: done, no checkpoint for the run, a newer
 * checkpoint not undone yet, a run using the folder, or a failure that left
 * the folder as it was before the restore.
 */
export const SIDECAR_RESTORE_OUTCOMES = [
  "restored",
  "no_checkpoint",
  "not_newest",
  "folder_busy",
  "failed",
] as const;
export type SidecarRestoreOutcome = (typeof SIDECAR_RESTORE_OUTCOMES)[number];

/** Whether a holder takes new runs or only finishes the ones it holds. */
export const SIDECAR_HOLDER_MODES = ["serving", "draining"] as const;
export type SidecarHolderMode = (typeof SIDECAR_HOLDER_MODES)[number];

/**
 * Beside a run's folder, the sidecar keeps its checkpoints under the folder's
 * name with this suffix (`checkpoints.ts`); the desktop removes them with the
 * folder.
 */
export const SIDECAR_CHECKPOINT_STORE_SUFFIX = ".checkpoints";

/**
 * Beside a run's folder, under the folder's name with this suffix, what the
 * runs' steps produced (`step-outputs.ts`): one folder per run holding the
 * run's output key, which the desktop writes, and one file per step, which
 * the sidecar writes. The desktop serves them to a page on this computer and
 * removes them with the folder.
 */
export const SIDECAR_STEP_OUTPUT_STORE_SUFFIX = ".step-outputs";

/** Runs one `hello` may resume or list. */
export const SIDECAR_MAX_HELD_RUNS = 1000;

/** Hex characters of the secret a host presents in `hello`. */
const SIDECAR_SECRET_HEX_LENGTH = 64;

const MAX_MESSAGE_TYPE_LENGTH = 64;
const MAX_MODELS = 100;
const MAX_RUN_MESSAGES = 1000;
const MAX_RUN_SKILL_FOLDERS = 32;
const MAX_RUN_TOOL_DIRECTORIES = 8;
const MAX_LAUNCH_ENTRIES = 32;
/** Process ids are unsigned 32-bit on every platform the desktop runs on. */
const MAX_PID = 4_294_967_295;

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

const environmentNameSchema = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u),
);

/**
 * What the desktop adds to a harness process's launch beyond its managed
 * home, such as Codex on the user's ChatGPT plan. Values may name a private
 * channel and are never logged.
 */
const harnessLaunchSettingsSchema = v.pipe(
  v.object({
    /** Passed to Codex as `-c <override>`, in order; no other harness takes any. */
    configOverrides: v.pipe(
      v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(8192))),
      v.maxLength(MAX_LAUNCH_ENTRIES),
    ),
    /** Set in the harness's environment, over what the holder inherited. */
    environment: v.pipe(
      v.record(environmentNameSchema, v.pipe(v.string(), v.maxLength(8192))),
      v.check(
        (environment) => Object.keys(environment).length <= MAX_LAUNCH_ENTRIES,
        "At most 32 variables",
      ),
    ),
    /** Removed from the environment the harness inherits. */
    removedEnvironment: v.pipe(
      v.array(environmentNameSchema),
      v.maxLength(MAX_LAUNCH_ENTRIES),
    ),
    /**
     * The client name the harness introduces itself with, when a credential
     * was registered under one; `null` keeps the adapter's own.
     */
    clientName: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
    /**
     * The desktop authorizes the harness process before it is asked
     * anything: see `harness.process`.
     */
    processGrant: v.boolean(),
  }),
  v.check(
    (settings) =>
      !settings.removedEnvironment.some((name) =>
        Object.hasOwn(settings.environment, name),
      ),
    "A variable is either set or removed",
  ),
);
export type SidecarHarnessLaunchSettings = v.InferOutput<
  typeof harnessLaunchSettingsSchema
>;

const harnessLaunchEntries = {
  harness: harnessSchema,
  /** The managed CLI the installer leased; never resolved from `PATH`. */
  executable: absolutePathSchema,
  /** The stella-owned home the CLI runs with (`CODEX_HOME`, ...). */
  configDir: absolutePathSchema,
  launch: harnessLaunchSettingsSchema,
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
const sidecarHelloPreambleSchema = v.object({
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
    /** The chat's own cache folder, writable in every sandbox. */
    cacheDir: absolutePathSchema,
    model: modelIdSchema,
    /** The effort the turn asks the model for; `null` leaves it to the harness. */
    reasoningEffort: v.nullable(v.picklist(DESKTOP_RUNNER_REASONING_EFFORTS)),
    instructions: v.pipe(v.string(), v.maxLength(65_536)),
    messages: v.pipe(
      v.array(modelMessageSchema),
      v.minLength(1),
      v.maxLength(MAX_RUN_MESSAGES),
    ),
    /** Files to copy into `workspaceDir` before the harness starts. */
    attachments: v.pipe(
      v.array(desktopRunnerAttachmentSchema),
      v.maxLength(MAX_RUN_ATTACHMENTS),
    ),
    /**
     * The skill folders the member listed on this computer. The desktop adds
     * them to a run the API started, and never tells the API about them.
     */
    skillFolders: v.pipe(
      v.array(
        v.object({
          name: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
          path: absolutePathSchema,
        }),
      ),
      v.maxLength(MAX_RUN_SKILL_FOLDERS),
    ),
    /** Directories of managed tools, put first on the harness's `PATH`. */
    toolPath: v.pipe(
      v.array(absolutePathSchema),
      v.maxLength(MAX_RUN_TOOL_DIRECTORIES),
    ),
    /** The native session to resume; `null` starts fresh. */
    harnessSessionId: v.nullable(
      v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
    ),
    policy: v.object({
      network: v.picklist(DESKTOP_RUNNER_NETWORK_POLICIES),
      fs: v.picklist(DESKTOP_RUNNER_FS_POLICIES),
      approvals: v.picklist(DESKTOP_RUNNER_APPROVAL_MODES),
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
  /**
   * Answers to a blocking question the run asked; the request id is the one
   * its chunk's interrupt carries. Answers name an option by its label or
   * hold free text, keyed by question id.
   */
  v.object({
    type: v.literal(SIDECAR_HOST_MESSAGE.runAnswer),
    runId: runIdSchema,
    requestId: requestIdSchema,
    answers: desktopRunnerQuestionAnswersSchema,
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
  /**
   * The desktop authorized the process `harness.process` reported for this
   * run id or probe request id; the harness may go on.
   */
  v.object({
    type: v.literal(SIDECAR_HOST_MESSAGE.harnessProcessGranted),
    id: requestIdSchema,
  }),
  /**
   * Put the run's folder back as it was before the run, from the checkpoint
   * the run took. Refused while any run uses the folder.
   */
  v.object({
    type: v.literal(SIDECAR_HOST_MESSAGE.folderRestore),
    requestId: requestIdSchema,
    workspaceDir: absolutePathSchema,
    runId: runIdSchema,
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
export type SidecarFolderRestore = Extract<
  SidecarHostMessage,
  { type: "folder.restore" }
>;

const probeOutcomeSchema = v.variant("type", [
  v.object({
    type: v.literal("ready"),
    version: desktopVersionSchema,
    capabilities: v.array(v.picklist(DESKTOP_RUNNER_HARNESS_CAPABILITIES)),
    /** The approval modes this computer can run the harness in. */
    approvalModes: v.array(v.picklist(DESKTOP_RUNNER_APPROVAL_MODES)),
    models: v.pipe(
      v.array(
        v.object({
          id: modelIdSchema,
          label: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
          isDefault: v.boolean(),
          reasoningEfforts: v.pipe(
            v.array(v.picklist(DESKTOP_RUNNER_REASONING_EFFORTS)),
            v.maxLength(DESKTOP_RUNNER_REASONING_EFFORTS.length),
          ),
        }),
      ),
      v.maxLength(MAX_MODELS),
    ),
  }),
  v.object({ type: v.literal("needs_login"), version: desktopVersionSchema }),
  /** Signed in, with the plan's usage limit exhausted until `resetsAt`. */
  v.object({
    type: v.literal("limit_until"),
    version: desktopVersionSchema,
    resetsAt: instantSchema,
  }),
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
  /**
   * A harness process started for a run (`id` is its run id) or a probe
   * (its request id) whose launch asked for a process grant. Not numbered:
   * the holder sends it again when a connection resumes the run.
   */
  v.object({
    type: v.literal(SIDECAR_MESSAGE.harnessProcess),
    id: requestIdSchema,
    pid: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_PID)),
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
    /** `chatLocalRunApprovalMessage`, as the runner protocol bounds it. */
    summary: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(CHAT_LOCAL_RUN_TOOL_LIMITS.approval),
    ),
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
  /** The answer to `folder.restore`; it names no file. */
  v.object({
    type: v.literal(SIDECAR_MESSAGE.folderRestored),
    requestId: requestIdSchema,
    outcome: v.picklist(SIDECAR_RESTORE_OUTCOMES),
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
      /** The run a known message was for, when it named one validly. */
      runId?: string | null;
    };

const HOST_MESSAGE_TYPES: ReadonlySet<string> = new Set(
  Object.values(SIDECAR_HOST_MESSAGE),
);
const lineTypeSchema = v.object({ type: v.string() });

const utf8Length = (line: string) => new TextEncoder().encode(line).byteLength;

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
  if (parsed.success) {
    return { type: "message", message: parsed.output };
  }
  // The run the line was for, so the host can end it instead of waiting.
  const run = v.safeParse(v.object({ runId: runIdSchema }), json.value);
  return {
    type: "rejected",
    reason: "invalid",
    messageType,
    runId: run.success ? run.output.runId : null,
  };
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

export type SidecarEncoded =
  | { type: "line"; line: string }
  | { type: "refused"; reason: "invalid" | "too_large" };

/**
 * One socket line, or why the message cannot be written: it breaks the
 * contract (a field over its bound) or exceeds the line limit. Never throws,
 * so each caller decides what an unwritable message means for its run.
 */
export const encodeSidecarMessage = (
  message: SidecarMessage,
): SidecarEncoded => {
  const parsed = v.safeParse(sidecarMessageSchema, message);
  if (!parsed.success) {
    return { type: "refused", reason: "invalid" };
  }
  const line = JSON.stringify(parsed.output);
  return utf8Length(line) > SIDECAR_MAX_LINE_BYTES
    ? { type: "refused", reason: "too_large" }
    : { type: "line", line: `${line}\n` };
};
