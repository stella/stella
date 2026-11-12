import { panic, Result } from "better-result";
import { homedir } from "node:os";
import path from "node:path";
import { Temporal } from "temporal-polyfill/full";
import * as v from "valibot";

import {
  DESKTOP_RUNNER_APPROVAL_MODES,
  type DesktopRunnerApprovalMode,
} from "@stll/api-contract/desktop-runner";
import { createDetached, type DetachedRejectionSink } from "@stll/errors";

import type { ProtocolLog } from "../../protocol-log";
import {
  type HarnessAdapter,
  type HarnessAuth,
  type HarnessCapability,
  type HarnessImageMediaType,
  type HarnessInputFile,
  type HarnessInputFileType,
  type HarnessModel,
  type HarnessProbe,
  HarnessProbeError,
  type HarnessRunPolicy,
  HarnessStartError,
  type HarnessTurn,
  type HarnessTurnInput,
  type HarnessUsageLimit,
} from "../adapter";
import {
  type HarnessContinuation,
  type HarnessSessionId,
  harnessSessionId,
} from "../events";
import { packageCacheEnvironment } from "../package-cache";
import { redactingSkillPaths } from "../skill-redaction";
import { toolPathEnvironment } from "../tool-path";
import { buildTurnPrompt } from "../transcript-handoff";
import { settlesWithin } from "../turn-lifecycle";
import {
  type ClaudeCliClient,
  type ClaudeCliHandlers,
  type ClaudeCliLaunch,
  startClaudeCli,
} from "./cli-client";
import { usageLimitResetsAt } from "./errors";
import {
  GetUsageResponseSchema,
  InitializeResponseSchema,
  McpSetServersResponseSchema,
} from "./protocol";
import {
  openSkillPlugin,
  removeSkillPlugin,
  SKILL_PLUGIN_NAME,
  type SkillPlugin,
  skillPluginPermissions,
} from "./skill-plugin";
import { ClaudeCodeTurnSession } from "./turn";

/**
 * Claude Code over its stream-json stdio mode, one CLI process per turn,
 * driven the way the Agent SDK drives it: an `initialize` control request,
 * the turn's user message, permission prompts as `can_use_tool` control
 * requests. The process runs with a stella-owned `CLAUDE_CONFIG_DIR`, so the
 * user's own Claude Code settings, sessions and sign-in stay untouched, and
 * a session started here resumes from the transcript that directory keeps.
 *
 * The turn runs on the subscription signed in to that directory, never on an
 * API key: variables that would switch the CLI to an API key, a third-party
 * provider or another endpoint are dropped from its environment, and a
 * sign-in that would bill an API key reads as signed out.
 *
 * Approach adapted from t3code (MIT, `ClaudeAdapterV2.ts` and
 * `ClaudeProvider.ts`): account and models from `initialize` without a
 * prompt, a stdio permission prompt tool, resume by native session id.
 */

export const claudeCodeLaunch = (executable: string): ClaudeCliLaunch => ({
  executable,
  args: [],
});

export type ClaudeCodeHarnessAdapterOptions = {
  /** The managed CLI; never resolved from `PATH`. */
  launch: ClaudeCliLaunch;
  /** stella-owned configuration directory, never the user's `~/.claude`. */
  claudeConfigDir: string;
  /** Base environment; credential and endpoint overrides are dropped. */
  environment: Readonly<Record<string, string>>;
  /**
   * How long an interrupt or a shutdown waits before the process is killed,
   * and how long a killed process gets before SIGKILL.
   */
  gracePeriodMs: number;
  /** How long any control request to the harness waits for its answer. */
  requestTimeoutMs: number;
  /** Receives failures of background work, such as a process shutdown. */
  onBackgroundError: DetachedRejectionSink;
  /** Where the CLI's protocol lines go, redacted. */
  protocolLog: ProtocolLog;
  /** The platform the CLI runs on, which decides whether it can sandbox. */
  platform: NodeJS.Platform;
};

/** What this adapter does with Claude Code. */
// Typed, not literal: every row could turn off, so each is a real check.
const CLAUDE_CODE_CAPABILITIES: Readonly<Record<HarnessCapability, boolean>> = {
  approvals: true,
  interrupt: true,
  resume: true,
  // The turn's images and PDFs open the user message as content blocks.
  image_input: true,
};

/** Claude reads images and PDFs as model input. */
const CLAUDE_CODE_INPUT_FILE_TYPES = [
  "image",
  "pdf",
] as const satisfies readonly HarnessInputFileType[];

/** A user content block of the CLI's stream-json input, as the API takes it. */
type UserContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: HarnessImageMediaType;
        data: string;
      };
    }
  | {
      type: "document";
      source: { type: "base64"; media_type: "application/pdf"; data: string };
    };

const inputFileBlock = (file: HarnessInputFile): UserContentBlock => {
  switch (file.type) {
    case "image":
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: file.mediaType,
          data: file.base64,
        },
      };
    case "pdf":
      return {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: file.base64,
        },
      };
    default:
      file satisfies never;
      return panic("Claude Code adapter: unknown input file");
  }
};

/**
 * The turn's user message. Files come first, as the API advises, and the
 * text after them still names each file's copy, so the agent can open it.
 */
const userContent = (
  files: readonly HarnessInputFile[],
  text: string,
): UserContentBlock[] => [...files.map(inputFileBlock), { type: "text", text }];

const capabilities = (): HarnessCapability[] =>
  Object.entries(CLAUDE_CODE_CAPABILITIES).flatMap(([capability, supported]) =>
    supported && isCapability(capability) ? [capability] : [],
  );

const isCapability = (value: string): value is HarnessCapability =>
  Object.hasOwn(CLAUDE_CODE_CAPABILITIES, value);

/**
 * The CLI's permission mode per approval mode. In `plan`, nothing that
 * changes files runs without asking: the agent reads and researches, then
 * calls `ExitPlanMode` with its plan, which is asked about like any call. In
 * `acceptEdits`, edits inside the working directory go ahead and anything
 * else, including a path outside it, is asked about through the permission
 * prompt; in `auto`, the CLI's own review approves what it judges safe and
 * asks about the rest. Full auto adds the CLI's OS sandbox to `acceptEdits`
 * (see `sandboxSettings`). A mode that skips permission checks is never
 * used: it would also approve a command's request to leave the sandbox.
 */
const PERMISSION_MODE = {
  plan: "plan",
  ask: "acceptEdits",
  auto: "auto",
  full_auto: "acceptEdits",
} as const satisfies Record<HarnessRunPolicy["approvals"], string>;
/**
 * The CLI's network is open. Outside full auto its sandbox is off; in full
 * auto the sandbox's proxy asks about each new host, and the turn lets
 * through only the hosts the run's skills declare (`networkHosts`) and asks
 * the member about any other.
 */
const NETWORK_ARGS = {
  open: [],
} as const satisfies Record<HarnessRunPolicy["network"], readonly string[]>;

/**
 * Where the CLI's OS sandbox runs: macOS (Seatbelt). The pinned release's
 * Windows sandbox is not generally available, so full auto is not offered
 * there.
 */
const SANDBOX_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["darwin"]);

/**
 * Full auto's sandbox, passed with `--settings`. Bash commands run inside the
 * OS sandbox, which confines writes to the working directory, the sandbox's
 * own temp directory (its `TMPDIR`) and the package cache, and they run
 * without asking. A skill folder is never writable, even one inside that temp
 * directory. A command that asks to run outside the sandbox is asked about
 * like any other action, never approved on its own. When the sandbox cannot
 * start the CLI refuses to start instead of running commands unconfined.
 */
const sandboxSettings = (
  cacheDir: string,
  skillFolders: readonly string[],
) => ({
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: true,
    filesystem: {
      allowWrite: [cacheDir],
      ...(skillFolders.length > 0 ? { denyWrite: skillFolders } : {}),
    },
  },
});

/**
 * The CLI mode a plan-level turn continues in once its plan is approved:
 * Ask's. The CLI on its own would return to `default`, which also asks about
 * edits; the mode the thread used before Plan is not known here, and Ask is
 * the mode every harness supports.
 */
const APPROVED_PLAN_MODE = PERMISSION_MODE.ask;

/** The CLI's refusal when the sandbox it was told to require cannot start. */
const SANDBOX_REFUSAL = "Sandbox required but unavailable";

const approvalModes = (
  platform: NodeJS.Platform,
): DesktopRunnerApprovalMode[] =>
  DESKTOP_RUNNER_APPROVAL_MODES.filter(
    (mode) => mode !== "full_auto" || SANDBOX_PLATFORMS.has(platform),
  );

/**
 * The turn's `--settings`, which load even with `--setting-sources ""`: the
 * sandbox in full auto and the rules for its skill folders.
 */
const settingsArgs = (
  input: HarnessTurnInput,
  skills: SkillPlugin | null,
  platform: NodeJS.Platform,
) => {
  const settings = {
    ...(input.policy.approvals === "full_auto"
      ? sandboxSettings(
          input.cacheDir,
          (skills?.folders ?? []).map(({ path: folder }) => folder),
        )
      : {}),
    ...(skills === null
      ? {}
      : { permissions: skillPluginPermissions(skills, platform) }),
  };
  return Object.keys(settings).length === 0
    ? []
    : ["--settings", JSON.stringify(settings)];
};

/**
 * Variables dropped from the CLI's environment: an API key, auth token,
 * third-party provider switch or endpoint would move billing off the
 * subscription or send the turn elsewhere, and a parent Claude Code session's
 * markers would change how the CLI behaves.
 */
const STRIPPED_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_"] as const;
const STRIPPED_ENV_NAMES: ReadonlySet<string> = new Set([
  "CLAUDECODE",
  "AWS_BEARER_TOKEN_BEDROCK",
]);

/** Set for every CLI process stella starts. */
const FIXED_ENV = {
  // The managed release is replaced by the desktop, never by the CLI.
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  // Connectors from the claude.ai account are not part of a stella turn.
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
} as const;

const PROTOCOL_ARGS = [
  "--output-format",
  "stream-json",
  "--verbose",
  "--input-format",
  "stream-json",
  // Permission prompts arrive as `can_use_tool` control requests.
  "--permission-prompt-tool",
  "stdio",
  // No settings, memory files, hooks or plugins from the workspace or a
  // home directory: a document folder cannot reconfigure the harness.
  "--setting-sources",
  "",
  // Only the MCP servers stella registers.
  "--strict-mcp-config",
] as const;

/**
 * The CLI's row for its recommended model. It is not a model: it names,
 * through `resolvedModel`, which listed model is the default.
 */
const DEFAULT_MODEL_ROW = "default";
/** A name in an allow rule and a tool prefix; kept to plain characters. */
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/u;
/** Missing-session refusals, in the CLI's wording. */
const SESSION_MISSING = /no conversation found/iu;

const validateOptions = (options: ClaudeCodeHarnessAdapterOptions) => {
  if (!path.isAbsolute(options.launch.executable)) {
    panic(
      "Claude Code adapter: the harness executable must be an absolute path",
    );
  }
  if (!path.isAbsolute(options.claudeConfigDir)) {
    panic("Claude Code adapter: CLAUDE_CONFIG_DIR must be an absolute path");
  }
  if (
    path.resolve(options.claudeConfigDir) ===
    path.resolve(path.join(homedir(), ".claude"))
  ) {
    panic(
      "Claude Code adapter: CLAUDE_CONFIG_DIR must be stella's, not the user's ~/.claude",
    );
  }
};

const isStripped = (name: string) =>
  STRIPPED_ENV_NAMES.has(name) ||
  STRIPPED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));

const childEnvironment = (
  options: ClaudeCodeHarnessAdapterOptions,
  environment: Readonly<Record<string, string>>,
) => ({
  ...Object.fromEntries(
    Object.entries(options.environment).filter(([name]) => !isStripped(name)),
  ),
  ...environment,
  ...FIXED_ENV,
  CLAUDE_CONFIG_DIR: options.claudeConfigDir,
});

type Initialized = v.InferOutput<typeof InitializeResponseSchema>;
type Connection = { client: ClaudeCliClient; init: Initialized };
type ConnectFailure = {
  /**
   * `start_rejected`: the CLI started and reported why it cannot run;
   * `sandbox_unavailable`: the reason was the sandbox it was told to require.
   */
  reason:
    | "harness_unavailable"
    | "protocol_violation"
    | "start_rejected"
    | "sandbox_unavailable";
  message: string;
};

type ConnectOptions = {
  options: ClaudeCodeHarnessAdapterOptions;
  cwd: string;
  args: readonly string[];
  /** Set over the base environment for this process. */
  environment: Readonly<Record<string, string>>;
  handlers: ClaudeCliHandlers;
  /** Extra `initialize` fields, such as the turn's instructions. */
  initialize: Record<string, unknown>;
};

/** Spawn the CLI and complete `initialize`, which sends no prompt. */
const connect = async ({
  options,
  cwd,
  args,
  environment,
  handlers,
  initialize,
}: ConnectOptions): Promise<Result<Connection, ConnectFailure>> => {
  // A CLI that cannot start the session (a missing resume target, say)
  // writes a result with its errors before it answers `initialize`.
  const startup: { initialized: boolean; refusal: string | null } = {
    initialized: false,
    refusal: null,
  };
  const started = startClaudeCli({
    launch: options.launch,
    protocolLog: options.protocolLog,
    args,
    detached: createDetached(options.onBackgroundError),
    deadlines: {
      requestMs: options.requestTimeoutMs,
      terminateMs: options.gracePeriodMs,
    },
    cwd,
    env: childEnvironment(options, environment),
    handlers: {
      ...handlers,
      message: (type, raw) => {
        if (!startup.initialized && type === "result") {
          const errors = v.safeParse(
            v.object({ errors: v.array(v.string()) }),
            raw,
          );
          startup.refusal = errors.success
            ? errors.output.errors.join("\n")
            : "The harness could not start the session.";
        }
        handlers.message(type, raw);
      },
    },
  });
  if (Result.isError(started)) {
    return Result.err({
      reason: "harness_unavailable",
      message: "The harness could not be started.",
    });
  }
  const client = started.value;
  const initialized = await client.request("initialize", initialize);
  startup.initialized = true;
  const parsed = Result.isOk(initialized)
    ? v.safeParse(InitializeResponseSchema, initialized.value)
    : null;
  if (parsed?.success === true) {
    return Result.ok({ client, init: parsed.output });
  }
  await client.kill();
  if (startup.refusal !== null) {
    return Result.err({
      reason: startup.refusal.startsWith(SANDBOX_REFUSAL)
        ? "sandbox_unavailable"
        : "start_rejected",
      message: startup.refusal,
    });
  }
  return Result.err(
    Result.isError(initialized)
      ? { reason: "harness_unavailable", message: initialized.error.message }
      : {
          reason: "protocol_violation",
          message: "The harness answered initialize with an unexpected shape.",
        },
  );
};

/**
 * Only a subscription sign-in runs a turn. An API key in use (one created by
 * a Console sign-in, say) would bill the API, so it reads as signed out.
 */
const authOf = ({ account }: Initialized): HarnessAuth => {
  const apiKey =
    account.apiKeySource !== undefined && account.apiKeySource !== "none";
  if (
    apiKey ||
    account.tokenSource === undefined ||
    account.tokenSource === "none"
  ) {
    return { type: "signed_out" };
  }
  return {
    type: "signed_in",
    method: account.tokenSource,
    plan: account.subscriptionType ?? null,
  };
};

/**
 * The CLI lists no input modalities per model, so none beyond text is claimed
 * for one; the adapter's `image_input` says what a turn hands every model.
 */
const TEXT_ONLY = ["text"] as const;

type ListedModel = Initialized["models"][number];

const resolvesTo = (model: ListedModel) => model.resolvedModel ?? model.value;

/**
 * Each real model once. The default row marks the first listed model it
 * resolves to; when it resolves to a model the CLI does not list, that model
 * is reported under its own id.
 */
const modelsOf = ({ models }: Initialized): HarnessModel[] => {
  const marker = models.find(({ value }) => value === DEFAULT_MODEL_ROW);
  const defaultModel = marker?.resolvedModel ?? null;
  const listed = models.filter(({ value }) => value !== DEFAULT_MODEL_ROW);
  const rows =
    marker === undefined ||
    defaultModel === null ||
    listed.some((model) => resolvesTo(model) === defaultModel)
      ? listed
      : [...listed, { ...marker, value: defaultModel, displayName: "" }];
  const defaultIndex = rows.findIndex(
    (model) => resolvesTo(model) === defaultModel,
  );
  return rows.map((model, index) => ({
    id: model.value,
    displayName: model.displayName,
    isDefault: index === defaultIndex,
    reasoningEfforts: model.supportedEffortLevels ?? [],
    inputModalities: TEXT_ONLY,
  }));
};

/** `get_usage` is experimental upstream; a failed read reports no limit. */
const readUsageLimit = async (
  client: ClaudeCliClient,
): Promise<HarnessUsageLimit | null> => {
  const usage = await client.request("get_usage", { skip_behaviors: true });
  const parsed = Result.isOk(usage)
    ? v.safeParse(GetUsageResponseSchema, usage.value)
    : null;
  if (parsed === null || !parsed.success) {
    return null;
  }
  const { rate_limits_available: available, rate_limits: windows } =
    parsed.output;
  const resetsAt = available
    ? usageLimitResetsAt(windows, Temporal.Now.instant())
    : null;
  return resetsAt === null ? null : { resetsAt };
};

const close = async (client: ClaudeCliClient, gracePeriodMs: number) => {
  client.closeInput();
  if (!(await settlesWithin(client.exited, gracePeriodMs))) {
    await client.kill();
  }
};

const refusingHandlers = (holder: {
  client: ClaudeCliClient | null;
}): ClaudeCliHandlers => ({
  message: () => undefined,
  controlRequest: (requestId, subtype) => {
    holder.client?.respondError(
      requestId,
      `Stella does not answer ${subtype}.`,
    );
  },
  controlCancel: () => undefined,
  violation: () => undefined,
  exit: () => undefined,
});

/** Account, models and plan limit as the harness reports them, no prompt. */
const probe = async (
  options: ClaudeCodeHarnessAdapterOptions,
): Promise<Result<HarnessProbe, HarnessProbeError>> => {
  const holder: { client: ClaudeCliClient | null } = { client: null };
  const connected = await connect({
    options,
    cwd: options.claudeConfigDir,
    args: [...PROTOCOL_ARGS, "--no-session-persistence"],
    environment: {},
    handlers: refusingHandlers(holder),
    initialize: {},
  });
  if (Result.isError(connected)) {
    return Result.err(
      new HarnessProbeError({
        reason:
          connected.error.reason === "protocol_violation"
            ? "protocol_violation"
            : "harness_unavailable",
        message: connected.error.message,
      }),
    );
  }
  const { client, init } = connected.value;
  holder.client = client;
  const version = init.claude_code_version ?? null;
  const auth = authOf(init);
  const result: Result<HarnessProbe, HarnessProbeError> =
    version === null
      ? Result.err(
          new HarnessProbeError({
            reason: "protocol_violation",
            message: "The harness did not report its version.",
          }),
        )
      : Result.ok({
          version,
          auth,
          models: auth.type === "signed_out" ? [] : modelsOf(init),
          capabilities: capabilities(),
          approvalModes: approvalModes(options.platform),
          usageLimit:
            auth.type === "signed_out" ? null : await readUsageLimit(client),
        });
  await close(client, options.gracePeriodMs);
  return result;
};

type SessionTarget =
  | { type: "fresh"; sessionId: HarnessSessionId }
  | { type: "resume"; sessionId: HarnessSessionId };

const turnArgs = (
  options: ClaudeCodeHarnessAdapterOptions,
  input: HarnessTurnInput,
  target: SessionTarget,
  skills: SkillPlugin | null,
) => [
  ...PROTOCOL_ARGS,
  "--include-partial-messages",
  "--permission-mode",
  PERMISSION_MODE[input.policy.approvals],
  ...settingsArgs(input, skills, options.platform),
  ...(skills === null ? [] : ["--plugin-dir", skills.dir]),
  ...NETWORK_ARGS[input.policy.network],
  // The stella MCP server enforces its own approvals for writes.
  "--allowedTools",
  `mcp__${input.mcp.serverName}`,
  target.type === "fresh" ? "--session-id" : "--resume",
  target.sessionId,
  "--model",
  input.model,
];

type OpenedSession = {
  session: ClaudeCodeTurnSession;
  client: ClaudeCliClient;
};
type OpenFailure =
  | { type: "connect"; failure: ConnectFailure }
  | { type: "start"; error: HarnessStartError };

/** Start the CLI for the target session and register the stella server. */
const openSession = async (
  options: ClaudeCodeHarnessAdapterOptions,
  input: HarnessTurnInput,
  target: SessionTarget,
  skills: SkillPlugin | null,
): Promise<Result<OpenedSession, OpenFailure>> => {
  const session = new ClaudeCodeTurnSession({
    gracePeriodMs: options.gracePeriodMs,
    detached: createDetached(options.onBackgroundError),
    stellaServer: input.mcp.serverName,
    // Outside full auto the sandbox is off and every command is asked about.
    sandboxNetworkHosts: new Set(
      input.policy.approvals === "full_auto" ? input.networkHosts : [],
    ),
    approvedPlanMode:
      input.policy.approvals === "plan" ? APPROVED_PLAN_MODE : null,
  });
  const connected = await connect({
    options,
    cwd: input.workspaceDir,
    args: turnArgs(options, input, target, skills),
    environment: {
      ...packageCacheEnvironment(input.cacheDir),
      ...toolPathEnvironment(options.environment, input.toolPath),
    },
    handlers: session.handlers,
    // Instructions travel over stdio, never on the command line.
    initialize: { appendSystemPrompt: input.instructions },
  });
  if (Result.isError(connected)) {
    session.abandon();
    return Result.err({ type: "connect", failure: connected.error });
  }
  const { client, init } = connected.value;
  session.attach(client);
  const fail = async (
    error: HarnessStartError,
  ): Promise<Result<OpenedSession, OpenFailure>> => {
    session.abandon();
    await client.kill();
    return Result.err({ type: "start", error });
  };
  if (authOf(init).type === "signed_out") {
    return fail(
      new HarnessStartError({
        reason: "auth_required",
        message: "The harness is not signed in to a Claude subscription.",
      }),
    );
  }
  // Only stella's server is registered; the run's secret travels over
  // stdio, never on the command line or in a file.
  const registered = await client.request("mcp_set_servers", {
    servers: {
      [input.mcp.serverName]: {
        type: "http",
        url: input.mcp.url,
        headers: { Authorization: `Bearer ${input.mcp.token}` },
      },
    },
  });
  const parsed = Result.isOk(registered)
    ? v.safeParse(McpSetServersResponseSchema, registered.value)
    : null;
  if (
    parsed === null ||
    !parsed.success ||
    !parsed.output.added.includes(input.mcp.serverName) ||
    parsed.output.errors[input.mcp.serverName] !== undefined
  ) {
    return fail(
      new HarnessStartError({
        reason: "start_rejected",
        message: "The harness could not connect to the stella MCP server.",
      }),
    );
  }
  return Result.ok({ session, client });
};

const startError = (failure: OpenFailure): HarnessStartError =>
  failure.type === "start"
    ? failure.error
    : new HarnessStartError(failure.failure);

const openTurn = async (
  options: ClaudeCodeHarnessAdapterOptions,
  input: HarnessTurnInput,
  skills: SkillPlugin | null,
  standalone: string,
): Promise<Result<HarnessTurn, HarnessStartError>> => {
  const fresh = (): SessionTarget => ({
    type: "fresh",
    sessionId: harnessSessionId(crypto.randomUUID()),
  });
  let target: SessionTarget =
    input.continuation.type === "resume"
      ? { type: "resume", sessionId: input.continuation.sessionId }
      : fresh();
  let continuation: HarnessContinuation =
    target.type === "resume" ? { type: "resumed" } : { type: "fresh" };
  let opened = await openSession(options, input, target, skills);
  if (
    Result.isError(opened) &&
    target.type === "resume" &&
    opened.error.type === "connect" &&
    opened.error.failure.reason === "start_rejected"
  ) {
    const { message } = opened.error.failure;
    target = fresh();
    continuation = {
      type: "resume_unavailable",
      reason: SESSION_MISSING.test(message)
        ? "session_not_found"
        : "resume_rejected",
      message,
    };
    opened = await openSession(options, input, target, skills);
  }
  if (Result.isError(opened)) {
    return Result.err(startError(opened.error));
  }
  const { session, client } = opened.value;
  const prompt =
    continuation.type === "resumed"
      ? buildTurnPrompt({ transcript: input.transcript, mode: "resumed" })
      : Result.ok(standalone);
  if (Result.isError(prompt)) {
    session.abandon();
    await client.kill();
    return prompt;
  }
  session.begin({ sessionId: target.sessionId, continuation });
  client.send({
    type: "user",
    message: {
      role: "user",
      content: userContent(input.inputFiles, prompt.value),
    },
    parent_tool_use_id: null,
    session_id: target.sessionId,
  });
  return Result.ok(session.turn());
};

const removePlugin = async (
  options: ClaudeCodeHarnessAdapterOptions,
  skills: SkillPlugin,
) => {
  const removed = await removeSkillPlugin(skills.dir);
  if (Result.isError(removed)) {
    options.onBackgroundError(removed.error, "skillPlugin.remove");
  }
};

/** The turn's `dispose` also removes its plugin, once the CLI has stopped. */
const releasingSkills = (
  options: ClaudeCodeHarnessAdapterOptions,
  turn: HarnessTurn,
  skills: SkillPlugin,
): HarnessTurn => ({
  events: turn.events,
  respond: turn.respond,
  interrupt: turn.interrupt,
  dispose: async () => {
    await turn.dispose();
    await removePlugin(options, skills);
  },
});

const startTurn = async (
  options: ClaudeCodeHarnessAdapterOptions,
  input: HarnessTurnInput,
): Promise<Result<HarnessTurn, HarnessStartError>> => {
  const standalone = buildTurnPrompt({
    transcript: input.transcript,
    mode: "standalone",
  });
  if (Result.isError(standalone)) {
    return standalone;
  }
  if (!path.isAbsolute(input.workspaceDir)) {
    panic(
      "Claude Code adapter: the workspace directory must be an absolute path",
    );
  }
  if (!MCP_SERVER_NAME.test(input.mcp.serverName)) {
    panic("Claude Code adapter: the MCP server name must be plain");
  }
  if (!path.isAbsolute(input.cacheDir)) {
    panic("Claude Code adapter: the cache directory must be an absolute path");
  }
  // Full auto never runs without the sandbox, so where the CLI has none the
  // turn fails before the CLI starts.
  if (!approvalModes(options.platform).includes(input.policy.approvals)) {
    return Result.err(
      new HarnessStartError({
        reason: "sandbox_unavailable",
        message: "This computer cannot run the harness in its sandbox.",
      }),
    );
  }
  const skills = await openSkillPlugin({
    configDir: options.claudeConfigDir,
    folders: input.skillFolders,
    platform: options.platform,
    onBackgroundError: options.onBackgroundError,
  });
  if (Result.isError(skills)) {
    return Result.err(
      new HarnessStartError({
        reason: "start_rejected",
        message: skills.error.message,
      }),
    );
  }
  const opened = await openTurn(options, input, skills.value, standalone.value);
  if (Result.isError(opened)) {
    if (skills.value !== null) {
      await removePlugin(options, skills.value);
    }
    return opened;
  }
  const turn = redactingSkillPaths(opened.value, {
    folders: input.skillFolders,
    plugin:
      skills.value === null
        ? null
        : { dir: skills.value.dir, name: SKILL_PLUGIN_NAME },
  });
  return Result.ok(
    skills.value === null ? turn : releasingSkills(options, turn, skills.value),
  );
};

export const createClaudeCodeHarnessAdapter = (
  options: ClaudeCodeHarnessAdapterOptions,
): HarnessAdapter => {
  validateOptions(options);
  return {
    harness: "claude-code",
    inputFileTypes: CLAUDE_CODE_INPUT_FILE_TYPES,
    probe: async () => probe(options),
    startTurn: async (input) => startTurn(options, input),
  };
};
