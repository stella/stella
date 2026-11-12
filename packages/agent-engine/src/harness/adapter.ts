import { type Result, TaggedError } from "better-result";

import type { AgentHarness } from "@stll/api-contract/agent-harness";
import type {
  DESKTOP_RUNNER_APPROVAL_DECISIONS,
  DESKTOP_RUNNER_FS_POLICIES,
  DESKTOP_RUNNER_HARNESS_CAPABILITIES,
  DESKTOP_RUNNER_NETWORK_POLICIES,
  DesktopRunnerApprovalMode,
  DesktopRunnerReasoningEffort,
} from "@stll/api-contract/desktop-runner";

import type { StellaSandboxMcpBinding } from "../sandbox";
import type { HarnessEvent, HarnessSessionId } from "./events";
import type { HarnessTranscriptMessage } from "./transcript-handoff";

/**
 * Guardrails for a turn on the user's own computer, in the runner protocol's
 * terms. The network is open: a local run's access to stella is bounded by
 * its short-lived, run-scoped MCP token, not by egress rules. Writes stay
 * inside the run's workspace directory, and the harness asks before acting
 * outside that. `approvals` sets how much it asks inside those bounds.
 */
export type HarnessRunPolicy = {
  network: (typeof DESKTOP_RUNNER_NETWORK_POLICIES)[number];
  fs: (typeof DESKTOP_RUNNER_FS_POLICIES)[number];
  approvals: DesktopRunnerApprovalMode;
};

export type HarnessCapability =
  (typeof DESKTOP_RUNNER_HARNESS_CAPABILITIES)[number];

/** The image formats both harnesses' models read. */
export type HarnessImageMediaType =
  "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/**
 * A file of the turn's request that the harness hands its model as input,
 * beside the copy in the run's folder that the prompt names.
 */
export type HarnessInputFile =
  | { type: "image"; mediaType: HarnessImageMediaType; base64: string }
  | { type: "pdf"; base64: string };
export type HarnessInputFileType = HarnessInputFile["type"];

/**
 * Resuming a native session is an optimization. The caller asks for it only
 * when the previous turn ran on the same engine, device and harness; the
 * adapter falls back to the transcript when the session is gone and reports
 * that as `resume_unavailable` on `session.started`.
 */
export type HarnessContinuationRequest =
  { type: "fresh" } | { type: "resume"; sessionId: HarnessSessionId };

/**
 * A skill folder the member listed on this computer. It reaches the turn from
 * the desktop alone and is never sent to the API.
 */
export type HarnessSkillFolder = {
  /** The skill's name, from its `SKILL.md`. */
  name: string;
  /** Absolute path of the folder holding that `SKILL.md`; never written to. */
  path: string;
};

export type HarnessTurnInput = {
  /** Stella run id; stamped on every chunk the turn produces. */
  runId: string;
  /** Stella thread id; stamped on every chunk the turn produces. */
  threadId: string;
  /** Absolute directory the harness runs in and may write to. */
  workspaceDir: string;
  /**
   * Absolute stella-owned cache directory of the run's chat, beside its
   * folder: package managers and `XDG_CACHE_HOME` tools write there, writable
   * inside every harness sandbox and never shared with another chat.
   */
  cacheDir: string;
  /** Skills the harness loads for the turn, through its own mechanism. */
  skillFolders: readonly HarnessSkillFolder[];
  /**
   * The hosts those skills declare (`stella-network-hosts`): the only hosts a
   * sandboxed command may reach without the member being asked.
   */
  networkHosts: readonly string[];
  /**
   * Absolute directories of tools the desktop manages, such as Bun, which the
   * turn's commands find ahead of what the computer has.
   */
  toolPath: readonly string[];
  /** A model id the harness itself reported through `probe`. */
  model: string;
  /**
   * An effort `probe` reported for the model, asked of it for this turn;
   * `null` leaves it to the harness.
   */
  reasoningEffort: DesktopRunnerReasoningEffort | null;
  /** Developer instructions for the harness. */
  instructions: string;
  policy: HarnessRunPolicy;
  /** Stella workspace access. */
  mcp: StellaSandboxMcpBinding;
  /**
   * The member's Chrome through the stella extension, served on this
   * computer; `null` where the holder has no browser bridge.
   */
  browser: StellaSandboxMcpBinding | null;
  /**
   * The persisted conversation, ending with the user message that starts
   * this turn. It is the portable context: a conversation may change engine
   * or harness between turns, so every turn can start from it alone.
   */
  transcript: readonly HarnessTranscriptMessage[];
  /**
   * Files of the last user message the model reads directly, of the types
   * the adapter's `inputFileTypes` lists. Their copies stay in the folder.
   */
  inputFiles: readonly HarnessInputFile[];
  continuation: HarnessContinuationRequest;
};

export type HarnessInteractionResponse =
  | {
      type: "approval";
      requestId: string;
      /** One of the decisions the request offered. */
      decision: (typeof DESKTOP_RUNNER_APPROVAL_DECISIONS)[number];
    }
  | {
      type: "answers";
      requestId: string;
      /** Question id to its answers: option labels or free text. */
      answers: Readonly<Record<string, readonly string[]>>;
    };

export class HarnessRespondError extends TaggedError("HarnessRespondError")<{
  reason:
    | "unknown_request"
    | "already_resolved"
    | "invalid_response"
    | "answer_with_message"
    | "turn_ended";
  message: string;
}> {}

/**
 * One running turn. `events` has a single consumer and ends after exactly one
 * terminal event (`turn.completed`, `turn.interrupted` or `turn.failed`).
 */
export type HarnessTurn = {
  readonly events: AsyncIterable<HarnessEvent>;
  respond: (
    response: HarnessInteractionResponse,
  ) => Promise<Result<void, HarnessRespondError>>;
  /** Stops the turn; `events` then ends with `turn.interrupted`. */
  interrupt: () => Promise<void>;
  /** Releases the harness process; safe to call more than once. */
  dispose: () => Promise<void>;
};

export class HarnessStartError extends TaggedError("HarnessStartError")<{
  reason:
    | "auth_required"
    | "invalid_transcript"
    | "harness_unavailable"
    | "protocol_violation"
    | "start_rejected"
    /** The run's approval mode needs a sandbox the harness cannot start. */
    | "sandbox_unavailable";
  message: string;
}> {}

/** Account state as the harness reports it; credentials never leave it. */
export type HarnessAuth =
  | { type: "signed_in"; method: string; plan: string | null }
  | { type: "signed_out" };

/** A model as the harness lists it; Stella offers nothing else. */
export type HarnessModel = {
  id: string;
  displayName: string;
  isDefault: boolean;
  /** The efforts a turn may ask of the model, of those stella knows. */
  reasoningEfforts: readonly DesktopRunnerReasoningEffort[];
  inputModalities: readonly string[];
};

/** A plan limit the harness reports as exhausted, and when it resets. */
export type HarnessUsageLimit = { resetsAt: string };

export type HarnessProbe = {
  version: string;
  auth: HarnessAuth;
  models: readonly HarnessModel[];
  /** What this harness and adapter can do, as the runner reports it. */
  capabilities: readonly HarnessCapability[];
  /** The approval modes this computer can run the harness in. */
  approvalModes: readonly DesktopRunnerApprovalMode[];
  /**
   * Set when the harness reports its plan limit exhausted with a known
   * reset; `null` when it reports none or cannot say when it resets.
   */
  usageLimit: HarnessUsageLimit | null;
};

export class HarnessProbeError extends TaggedError("HarnessProbeError")<{
  reason: "harness_unavailable" | "protocol_violation";
  message: string;
}> {}

/**
 * A local coding-agent harness. `probe` initializes the harness and reads its
 * account and models without starting a session or sending a prompt, so it
 * is safe as a health check.
 */
export type HarnessAdapter = {
  readonly harness: AgentHarness;
  /** The input files a turn hands its model; any other stays a path. */
  readonly inputFileTypes: readonly HarnessInputFileType[];
  probe: () => Promise<Result<HarnessProbe, HarnessProbeError>>;
  startTurn: (
    input: HarnessTurnInput,
  ) => Promise<Result<HarnessTurn, HarnessStartError>>;
};
