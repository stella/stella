import { EventType } from "@tanstack/ai";
import type { ModelMessage } from "@tanstack/ai";
import { Result } from "better-result";
import * as v from "valibot";

import { AGENT_HARNESSES } from "./agent-harness";
import { API_STORABLE_INSTANT_CHECK } from "./api-date";
import { STELLA_API_VERSION_PREFIX } from "./api-version";
import {
  CHAT_LOCAL_RUN_TOOL_LIMITS,
  chatLocalRunShownText,
} from "./chat-local-run-tool";
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

/** Where a desktop opens its runner socket (`wss://<api>/v1/desktop/runner`). */
export const DESKTOP_RUNNER_PATH =
  `${STELLA_API_VERSION_PREFIX}/desktop/runner` as const;

/**
 * The installation id the desktop already reports with its presence. The
 * credential binds the device key; this names the installation the key runs
 * in, so runs can be bound to both.
 */
export const DESKTOP_RUNNER_DESKTOP_ID_HEADER = "stella-desktop-id";

/**
 * Why the API closed a runner socket. A desktop reconnects after every code
 * except `upgradeRequired` (until it is updated) and `superseded` (another
 * socket of the same installation took over). Refusals before the upgrade are
 * HTTP answers instead: 400 without a valid installation id, 401 or 403 from
 * account and device-proof authorization, 403 with code `feature_disabled`
 * for an account without the runner feature, 426 without a WebSocket upgrade,
 * 429 above the account's socket cap, 503 while the task drains.
 *
 * - `goingAway`: the API task is draining or the socket reached its maximum
 *   life; a `reconnect` frame with the delay to wait precedes it.
 * - `unsupportedData`: a binary frame; the protocol is JSON text.
 * - 1008, `policyViolation(reason)`: a frame the contract rejects
 *   (`not_json`, `unknown_type`, `invalid`), a message before `hello`
 *   (`hello_required`), a second `hello` (`hello_repeated`), a run message its
 *   run's state does not allow (`run_state`), a chunk that is not a valid
 *   AG-UI event or pauses for a question without a UUID request id
 *   (`unfoldable_chunk`), or a run message past what one run may
 *   store (`run_limit`; the API ends that run as lost).
 * - `tooLarge`: a frame above `DESKTOP_RUNNER_MAX_FRAME_BYTES`.
 * - `overloaded`: the desktop sent frames faster than they could be stored.
 * - `internalError`: the API could not persist or read what it needed; the
 *   desktop resends everything after its last `ack`.
 * - `upgradeRequired`: `hello` named a protocol outside the accepted range;
 *   an `upgrade_required` frame with the range precedes it.
 * - `superseded`: a newer socket of the same installation and device key
 *   was accepted.
 * - `heartbeatTimeout`: pings went unanswered.
 * - `sequenceGap`: a run message skipped a position; `welcome.resume` on the
 *   next socket says where to resume.
 * - `helloTimeout`: no `hello` arrived in time.
 * - `unknownRun`: a run message for a run this socket does not hold.
 * - `tooManyRunners`: the account holds as many installations as it may, and
 *   none can make room.
 * - `credentialRevoked`: the device key's credential was revoked, expired or
 *   unlinked; the desktop must link again.
 * - `featureDisabled`: the account no longer has the runner feature.
 */
export const DESKTOP_RUNNER_CLOSE = {
  goingAway: { code: 1001, reason: "going_away" },
  unsupportedData: { code: 1003, reason: "binary_frame" },
  tooLarge: { code: 1009, reason: "too_large" },
  internalError: { code: 1011, reason: "internal_error" },
  overloaded: { code: 1013, reason: "overloaded" },
  upgradeRequired: { code: 4001, reason: "upgrade_required" },
  superseded: { code: 4002, reason: "superseded" },
  heartbeatTimeout: { code: 4003, reason: "heartbeat_timeout" },
  sequenceGap: { code: 4004, reason: "sequence_gap" },
  helloTimeout: { code: 4005, reason: "hello_timeout" },
  unknownRun: { code: 4006, reason: "unknown_run" },
  tooManyRunners: { code: 4007, reason: "too_many_runners" },
  credentialRevoked: { code: 4008, reason: "credential_revoked" },
  featureDisabled: { code: 4009, reason: "feature_disabled" },
} as const;
export const DESKTOP_RUNNER_POLICY_VIOLATION_CODE = 1008;

/** The reason a `policyViolation` close carries. */
export const DESKTOP_RUNNER_POLICY_REASONS = [
  "not_json",
  "unknown_type",
  "invalid",
  "hello_required",
  "hello_repeated",
  "run_state",
  "unfoldable_chunk",
  "run_limit",
] as const;
type DesktopRunnerPolicyReason = (typeof DESKTOP_RUNNER_POLICY_REASONS)[number];

export type DesktopRunnerClose =
  | (typeof DESKTOP_RUNNER_CLOSE)[keyof typeof DESKTOP_RUNNER_CLOSE]
  | {
      code: typeof DESKTOP_RUNNER_POLICY_VIOLATION_CODE;
      reason: DesktopRunnerPolicyReason;
    };

export const policyViolation = (
  reason: DesktopRunnerPolicyReason,
): DesktopRunnerClose => ({
  code: DESKTOP_RUNNER_POLICY_VIOLATION_CODE,
  reason,
});

/** How long the gateway waits for things and how long it holds them. */
export type DesktopRunnerTiming = {
  /** Between pings; two unanswered intervals close the socket. */
  readonly pingIntervalMs: number;
  /** A socket's life before the API asks the desktop to reconnect. */
  readonly maxSocketLifeMs: number;
  /** Before a socket that sent no `hello` is closed. */
  readonly helloTimeoutMs: number;
  /** A run's lease, renewed by every heartbeat of the socket holding it. */
  readonly leaseMs: number;
  /** How recently a runner must have been seen for routing to pick it. */
  readonly runnerFreshnessMs: number;
  /** Between sweeps for expired leases and commands a doorbell missed. */
  readonly sweepIntervalMs: number;
  /** Upper bound of the `reconnect` delay spread over a draining task's sockets. */
  readonly drainSpreadMs: number;
  /** A run's MCP token is refreshed when it has less than this left. */
  readonly tokenRefreshMarginMs: number;
};

export const DESKTOP_RUNNER_TIMING = {
  pingIntervalMs: 20_000,
  maxSocketLifeMs: 60 * 60_000,
  helloTimeoutMs: 10_000,
  leaseMs: 90_000,
  runnerFreshnessMs: 60_000,
  sweepIntervalMs: 15_000,
  drainSpreadMs: 30_000,
  tokenRefreshMarginMs: 5 * 60_000,
} as const satisfies DesktopRunnerTiming;

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
  runAnswer: "run.answer",
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
  unavailable: "unavailable",
} as const;

/**
 * Why an installed harness could not be checked, so it is neither offered nor
 * called unsupported: the desktop only knows that it cannot run it right now.
 *
 * - `harness_failed`: the harness did not start, exited or stopped answering.
 * - `unexpected_answer`: the harness answered in a way the desktop cannot read.
 * - `probe_failed`: the desktop's own harness host could not ask it.
 */
export const DESKTOP_RUNNER_HARNESS_UNAVAILABLE_REASONS = [
  "harness_failed",
  "unexpected_answer",
  "probe_failed",
] as const;

/** What a ready harness reports it can do; the API never assumes more. */
export const DESKTOP_RUNNER_HARNESS_CAPABILITIES = [
  "approvals",
  "interrupt",
  "resume",
  "image_input",
] as const;

/**
 * Why a desktop refused a run command. `harness_unavailable` matches a harness
 * reported `unavailable`; `run_too_large` is a `run.start` the desktop cannot
 * hand to its harness host whole, which no retry on that computer fixes.
 */
export const DESKTOP_RUNNER_REJECT_REASONS = [
  "harness_not_installed",
  "harness_needs_login",
  "harness_limited",
  "harness_unsupported",
  "harness_unavailable",
  "harness_version_unavailable",
  "model_unavailable",
  "policy_unsupported",
  "at_capacity",
  "run_too_large",
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

/**
 * How much a local run asks before it acts, chosen per thread.
 * - `ask`: edits inside the run workspace go ahead; commands and anything
 *   else are asked about.
 * - `auto`: the harness decides what is safe to do on its own and asks
 *   about the rest.
 * - `full_auto`: everything inside the harness's OS sandbox (writes confined
 *   to the run workspace and its caches) runs without asking; leaving the
 *   sandbox is always asked about. A desktop that cannot sandbox the
 *   harness does not offer it.
 */
export const DESKTOP_RUNNER_APPROVAL_MODES = [
  "ask",
  "auto",
  "full_auto",
] as const;
export type DesktopRunnerApprovalMode =
  (typeof DESKTOP_RUNNER_APPROVAL_MODES)[number];
/** The mode every harness supports, and a thread's mode until one is chosen. */
export const DESKTOP_RUNNER_DEFAULT_APPROVAL_MODE =
  "ask" satisfies DesktopRunnerApprovalMode;

const MAX_SEQ = 4_294_967_295;
const MAX_ACTIVE_RUNS = 64;
const MAX_MODELS = 100;
const MAX_RUN_MESSAGES = 1000;
const MAX_RECONNECT_DELAY_MS = 600_000;
/** Files one `run.start` may copy; a chat's earlier files are already there. */
export const MAX_RUN_ATTACHMENTS = 32;
const MAX_MESSAGE_TYPE_LENGTH = 64;

const listsOnce = (keys: readonly string[]) =>
  new Set(keys).size === keys.length;

/**
 * What one `run.answer` may carry. A run asks a blocking question as a chunk
 * whose `RUN_FINISHED` interrupt has `metadata.kind: "question"`; the answers
 * name each question by its id. Lengths are UTF-16 code units, as JavaScript
 * counts them.
 */
export const DESKTOP_RUNNER_ANSWER_LIMITS = {
  maxQuestions: 32,
  maxAnswersPerQuestion: 64,
  maxAnswerLength: 16_384,
  maxQuestionIdLength: 256,
} as const;

/** The keys `v.record` leaves out of what it parses, without an issue. */
const RECORD_DROPPED_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

/**
 * The id a blocking question names one of its questions by, in the pause
 * that asks it and in the answers alike. Answers are a record keyed by this
 * id, so an id the record would drop could never be answered.
 */
export const desktopRunnerQuestionIdSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(DESKTOP_RUNNER_ANSWER_LIMITS.maxQuestionIdLength),
  v.check(
    (id) => !RECORD_DROPPED_KEYS.has(id),
    "A question id must survive as an answer key",
  ),
);

/**
 * Answers to a blocking question, keyed by question id: option labels or
 * free text. A question may be answered by several options.
 */
export const desktopRunnerQuestionAnswersSchema = v.pipe(
  v.record(
    desktopRunnerQuestionIdSchema,
    v.pipe(
      v.array(
        v.pipe(
          v.string(),
          v.maxLength(DESKTOP_RUNNER_ANSWER_LIMITS.maxAnswerLength),
        ),
      ),
      v.maxLength(DESKTOP_RUNNER_ANSWER_LIMITS.maxAnswersPerQuestion),
    ),
  ),
  v.check(
    (answers) =>
      Object.keys(answers).length <= DESKTOP_RUNNER_ANSWER_LIMITS.maxQuestions,
    `At most ${String(DESKTOP_RUNNER_ANSWER_LIMITS.maxQuestions)} questions are answered at once`,
  ),
);
export type DesktopRunnerQuestionAnswers = v.InferOutput<
  typeof desktopRunnerQuestionAnswersSchema
>;

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
    /**
     * The approval modes this desktop can run the harness in. A desktop or a
     * stored report from before modes existed offers the default alone.
     */
    approvalModes: v.optional(
      v.pipe(
        v.array(v.picklist(DESKTOP_RUNNER_APPROVAL_MODES)),
        v.check((modes) => listsOnce(modes), "Approval modes are listed once"),
        v.check(
          (modes) => modes.includes(DESKTOP_RUNNER_DEFAULT_APPROVAL_MODE),
          "Every harness supports the default approval mode",
        ),
      ),
      [DESKTOP_RUNNER_DEFAULT_APPROVAL_MODE],
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
  v.object({
    id: harnessSchema,
    state: v.literal(DESKTOP_RUNNER_HARNESS_STATE.unavailable),
    reason: v.picklist(DESKTOP_RUNNER_HARNESS_UNAVAILABLE_REASONS),
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

export const DESKTOP_RUNNER_ATTACHMENT_LINK_MAX_LENGTH = 8192;

const ATTACHMENT_PATH = /^attachments\/[\da-f-]{36}\/[^/\\\0]{1,255}$/u;

/**
 * Where a chat's attached file lands in the run's folder, relative to it. The
 * file's id keeps two files of one name apart and a name out of the path's
 * structure; the name stays readable for the agent and the member.
 */
export const desktopRunnerAttachmentPathSchema = v.pipe(
  v.string(),
  v.regex(ATTACHMENT_PATH),
  v.check(
    (path) => !path.split("/").some((part) => part === ".." || part === "."),
    "An attachment stays inside its folder",
  ),
);

/** Short of every filesystem's limit, with room for a long extension. */
const ATTACHMENT_NAME_MAX_CHARS = 120;
const ATTACHMENT_EXTENSION = /\.[^.]{1,16}$/u;

const boundedAttachmentName = (name: string) => {
  const characters = Array.from(name);
  if (characters.length <= ATTACHMENT_NAME_MAX_CHARS) {
    return name;
  }
  const suffix = ATTACHMENT_EXTENSION.exec(name)?.[0] ?? "";
  return `${characters
    .slice(0, ATTACHMENT_NAME_MAX_CHARS - Array.from(suffix).length)
    .join("")}${suffix}`;
};

export const desktopRunnerAttachmentPath = (
  fileId: string,
  sanitizedFileName: string,
): string =>
  `attachments/${fileId}/${boundedAttachmentName(sanitizedFileName)}`;

/**
 * A file to copy before the run starts. The link is signed when the command is
 * sent and expires soon after, so a stored `run.start` never holds one.
 */
export const desktopRunnerAttachmentSchema = v.object({
  path: desktopRunnerAttachmentPathSchema,
  url: v.pipe(
    v.string(),
    v.maxLength(DESKTOP_RUNNER_ATTACHMENT_LINK_MAX_LENGTH),
    v.url(),
    v.startsWith("https://"),
  ),
});
export type DesktopRunnerAttachment = v.InferOutput<
  typeof desktopRunnerAttachmentSchema
>;

/**
 * Where a run's output file is posted, over HTTP and with the run's agent
 * token: a file does not fit a socket frame or what one run may store.
 */
export const desktopRunnerOutputPath = (runId: string) =>
  `${STELLA_API_VERSION_PREFIX}/chat/local-runs/${encodeURIComponent(runId)}/outputs` as const;

/** The largest file a run hands back; both ends hold it to this. */
export const DESKTOP_RUNNER_OUTPUT_MAX_BYTES = 50 * 1024 * 1024;

/** What the API answers once it stored a run's output file. */
export const desktopRunnerOutputUploadedSchema = v.strictObject({
  fileId: v.pipe(v.string(), v.uuid()),
});

/**
 * The CUSTOM chunk a desktop reports one output file with, before the run's
 * finish. It names a file; it never makes one: the API checks an uploaded id
 * against the run's thread and owner and mints the message part itself.
 */
export const DESKTOP_RUNNER_OUTPUT_EVENT = "stella.run-output";

const outputFileNameSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(255),
);

export const desktopRunnerOutputEventSchema = v.variant("status", [
  v.strictObject({
    status: v.literal("uploaded"),
    fileId: v.pipe(v.string(), v.uuid()),
    fileName: outputFileNameSchema,
  }),
  v.strictObject({
    status: v.literal("failed"),
    fileName: outputFileNameSchema,
  }),
]);
export type DesktopRunnerOutputEvent = v.InferOutput<
  typeof desktopRunnerOutputEventSchema
>;

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
    /**
     * What the approval asks, kept as one bounded line however a desktop
     * wrote it (`chatLocalRunApprovalMessage` already is one), so a longer
     * summary is stored shown and the run still resumes.
     */
    summary: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(4000),
      v.transform((summary) =>
        chatLocalRunShownText(summary, CHAT_LOCAL_RUN_TOOL_LIMITS.approval),
      ),
    ),
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
    /** The folder the run works in; a chat's runs share one, so files stay between turns. */
    folderId: v.pipe(v.string(), v.uuid()),
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
    attachments: v.pipe(
      v.array(desktopRunnerAttachmentSchema),
      v.maxLength(MAX_RUN_ATTACHMENTS),
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
  /**
   * Answers to a blocking question the run asked; `requestId` is the id of
   * the question's interrupt in the run's chunks.
   */
  v.object({
    type: v.literal(DESKTOP_RUNNER_SERVER_MESSAGE.runAnswer),
    runId: runIdSchema,
    requestId: requestIdSchema,
    answers: desktopRunnerQuestionAnswersSchema,
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
