import { panic, Result } from "better-result";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { Temporal } from "temporal-polyfill/full";
import * as v from "valibot";

import { knownReasoningEfforts } from "@stll/api-contract/desktop-runner";
import { createDetached, type DetachedRejectionSink } from "@stll/errors";

import type { ProtocolLog } from "../../protocol-log";
import {
  type HarnessAdapter,
  type HarnessCapability,
  type HarnessInputFileType,
  type HarnessModel,
  type HarnessProbe,
  HarnessProbeError,
  HarnessStartError,
  type HarnessTurn,
  type HarnessTurnInput,
} from "../adapter";
import { type HarnessContinuation, sessionHoldsHistory } from "../events";
import { packageCacheEnvironment } from "../package-cache";
import { redactingSkillPaths } from "../skill-redaction";
import { toolPathEnvironment } from "../tool-path";
import { buildTurnPrompt } from "../transcript-handoff";
import { settlesWithin } from "../turn-lifecycle";
import {
  type AcpClient,
  type AcpHandlers,
  type AcpLaunch,
  type AcpRequestError,
  startAcpAgent,
} from "./client";
import type { AcpAgentDefinition } from "./definition";
import {
  ACP_CLIENT_INFO,
  ACP_ERROR,
  ACP_PROTOCOL_VERSION,
  type AcpConfigOption,
  type AcpInitializeResponse,
  AcpInitializeResponseSchema,
  type AcpMcpServer,
  AcpNewSessionResponseSchema,
  AcpOpenedSessionResponseSchema,
  type AcpSessionState,
} from "./protocol";
import {
  isSessionBroken,
  makeProcessTempDir,
  markSessionBroken,
  probeKey,
  readCachedProbe,
  recordTempDirOwner,
  removeTempDir,
  sweepTempDirs,
  tempEnvironment,
  writeCachedProbe,
} from "./state-dir";
import { AcpTurnSession } from "./turn";

/**
 * A coding agent over the Agent Client Protocol (JSON-RPC on stdio), one
 * process per turn. What differs between agents is their definition
 * (`definition.ts`); the protocol is the same. The agent runs with a
 * stella-owned state directory, so the member's own configuration and
 * sign-in stay untouched, and a session it started resumes from what it
 * keeps there between turns.
 */

export type AcpHarnessAdapterOptions = {
  definition: AcpAgentDefinition;
  /** The managed agent; never resolved from `PATH`. */
  executable: string;
  /** stella-owned directory the agent keeps its state in. */
  configDir: string;
  /** Base environment for the agent. */
  environment: Readonly<Record<string, string>>;
  /** Desktop version, reported to the agent as the client version. */
  clientVersion: string;
  /**
   * How long an interrupt or a shutdown waits before the process is killed,
   * and how long a killed process gets before SIGKILL.
   */
  gracePeriodMs: number;
  /** How long any request to the agent waits for its answer. */
  requestTimeoutMs: number;
  /** How long a startup request waits instead; see `HarnessProcessDeadlines`. */
  startupRequestTimeoutMs?: number;
  onBackgroundError: DetachedRejectionSink;
  /** Where the agent's protocol lines go, redacted. */
  protocolLog: ProtocolLog;
  /**
   * Called with each new process's id before it is asked anything; a
   * process it does not answer `true` for is ended unused.
   */
  onProcess?: (pid: number) => Promise<boolean>;
  platform: NodeJS.Platform;
};

/** The input files a turn hands the model; a PDF stays a path it opens. */
const ACP_INPUT_FILE_TYPES = [
  "image",
] as const satisfies readonly HarnessInputFileType[];

/** Why a turn did not start; the desktop names the agent and offers sign-in. */
const SIGNED_OUT = "The agent is not signed in.";

/** Wraps the turn's instructions, sent ahead of every prompt. */
const instructionsBlock = (instructions: string) =>
  `<stella-instructions>\n${instructions}\n</stella-instructions>`;

const launchOf = (options: AcpHarnessAdapterOptions): AcpLaunch => ({
  executable: options.executable,
  args: options.definition.args(options.platform),
});

const validateOptions = (options: AcpHarnessAdapterOptions) => {
  if (!path.isAbsolute(options.executable)) {
    panic("ACP adapter: the agent executable must be an absolute path");
  }
  if (!path.isAbsolute(options.configDir)) {
    panic("ACP adapter: the agent's state directory must be an absolute path");
  }
};

/** The inherited environment without the variables the agent must not see. */
const agentEnvironment = (
  options: AcpHarnessAdapterOptions,
  extra: Readonly<Record<string, string>>,
): Record<string, string> => {
  // Windows reads variable names without regard to case.
  const key = (name: string) =>
    options.platform === "win32" ? name.toUpperCase() : name;
  const removed = new Set(options.definition.removedEnvironment.map(key));
  return {
    ...Object.fromEntries(
      Object.entries(options.environment).filter(
        ([name]) => !removed.has(key(name)),
      ),
    ),
    ...extra,
    ...options.definition.environment({
      configDir: options.configDir,
      executable: options.executable,
      platform: options.platform,
    }),
  };
};

type Connection = { client: AcpClient; agent: AcpInitializeResponse };
type ConnectFailure = {
  reason: "harness_unavailable" | "protocol_violation";
  message: string;
};

/** Spawn the agent and complete `initialize`. */
const connect = async ({
  options,
  cwd,
  handlers,
  environment,
}: {
  options: AcpHarnessAdapterOptions;
  cwd: string;
  handlers: AcpHandlers;
  environment: Readonly<Record<string, string>>;
}): Promise<Result<Connection, ConnectFailure>> => {
  const detached = createDetached(options.onBackgroundError);
  const tempDir = options.definition.ownTempDir
    ? makeProcessTempDir(options.configDir)
    : null;
  const started = startAcpAgent({
    launch: launchOf(options),
    protocolLog: options.protocolLog,
    detached,
    deadlines: {
      requestMs: options.requestTimeoutMs,
      startupRequestMs: options.startupRequestTimeoutMs,
      terminateMs: options.gracePeriodMs,
    },
    cwd,
    env: agentEnvironment(options, {
      ...environment,
      ...(tempDir === null ? {} : tempEnvironment(tempDir, options.platform)),
    }),
    handlers,
  });
  if (Result.isError(started)) {
    if (tempDir !== null) {
      removeTempDir(tempDir);
    }
    return Result.err({
      reason: "harness_unavailable",
      message: `${options.definition.displayName} could not be started.`,
    });
  }
  const client = started.value;
  if (tempDir !== null) {
    recordTempDirOwner(tempDir, client.pid);
    detached(
      (async () => {
        await client.exited;
        removeTempDir(tempDir);
      })(),
      "acp-agent.temp",
    );
  }
  const authorized =
    options.onProcess === undefined
      ? Result.ok(true)
      : await Result.tryPromise(async () => options.onProcess?.(client.pid));
  if (Result.isError(authorized) || authorized.value !== true) {
    await client.kill();
    return Result.err({
      reason: "harness_unavailable",
      message: "The desktop did not authorize the agent process.",
    });
  }
  const initialized = await client.request("initialize", {
    protocolVersion: ACP_PROTOCOL_VERSION,
    // stella reads and writes files and runs commands only through the
    // agent's own tools, which ask for permission.
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { ...ACP_CLIENT_INFO, version: options.clientVersion },
  });
  const parsed = Result.isOk(initialized)
    ? v.safeParse(AcpInitializeResponseSchema, initialized.value)
    : null;
  if (parsed === null || !parsed.success) {
    await client.kill();
    return Result.err(
      Result.isError(initialized)
        ? { reason: "harness_unavailable", message: initialized.error.message }
        : {
            reason: "protocol_violation",
            message: "The agent answered initialize with an unexpected shape.",
          },
    );
  }
  if (parsed.output.protocolVersion !== ACP_PROTOCOL_VERSION) {
    await client.kill();
    return Result.err({
      reason: "protocol_violation",
      message: `The agent speaks protocol version ${String(parsed.output.protocolVersion)}, not ${String(ACP_PROTOCOL_VERSION)}.`,
    });
  }
  return Result.ok({ client, agent: parsed.output });
};

const close = async (client: AcpClient, gracePeriodMs: number) => {
  client.closeInput();
  if (!(await settlesWithin(client.exited, gracePeriodMs))) {
    await client.kill();
  }
};

/**
 * For an agent whose sign-in is stored in its state directory: have it read
 * that sign-in. `signed_out` when there is none, or the agent refused it.
 */
const authenticate = async (
  client: AcpClient,
  options: AcpHarnessAdapterOptions,
): Promise<Result<"signed_in" | "signed_out", AcpRequestError>> => {
  const stored = options.definition.storedSignIn;
  if (stored === null) {
    return Result.ok("signed_in");
  }
  if (!stored.signedIn(options.configDir)) {
    return Result.ok("signed_out");
  }
  const answered = await client.request("authenticate", {
    methodId: stored.methodId,
  });
  if (Result.isOk(answered)) {
    return Result.ok("signed_in");
  }
  // An agent that cannot use the stored sign-in asks for a new one; with
  // no browser to open it answers an internal error.
  return answered.error.reason === "rejected" &&
    (answered.error.code === ACP_ERROR.authRequired ||
      answered.error.code === ACP_ERROR.internalError)
    ? Result.ok("signed_out")
    : Result.err(answered.error);
};

/** stella's MCP servers for a session, over HTTP; the token stays on stdio. */
const mcpServers = (input: HarnessTurnInput): AcpMcpServer[] =>
  [input.mcp, ...(input.browser === null ? [] : [input.browser])].map(
    (binding): AcpMcpServer => ({
      type: "http",
      name: binding.serverName,
      url: binding.url,
      headers: [{ name: "Authorization", value: `Bearer ${binding.token}` }],
    }),
  );

const speaksHttpMcp = (agent: AcpInitializeResponse) =>
  agent.agentCapabilities?.mcpCapabilities?.http === true;

const canResume = (agent: AcpInitializeResponse) =>
  agent.agentCapabilities?.sessionCapabilities?.resume !== undefined &&
  agent.agentCapabilities.sessionCapabilities.resume !== null;

const canLoad = (agent: AcpInitializeResponse) =>
  agent.agentCapabilities?.loadSession === true;

/** How the agent reopens a session: `resume` replays nothing, `load` all. */
const reopenMethod = (agent: AcpInitializeResponse) => {
  if (canResume(agent)) {
    return "session/resume";
  }
  return canLoad(agent) ? "session/load" : null;
};

const steers = (agent: AcpInitializeResponse, definition: AcpAgentDefinition) =>
  agent.agentInfo !== null &&
  agent.agentInfo !== undefined &&
  definition.steers(agent.agentInfo.version);

const takesImages = (agent: AcpInitializeResponse) =>
  agent.agentCapabilities?.promptCapabilities?.image === true;

const capabilities = (
  agent: AcpInitializeResponse,
  definition: AcpAgentDefinition,
): HarnessCapability[] => [
  "approvals",
  "interrupt",
  ...(steers(agent, definition) ? (["steer"] as const) : []),
  ...(canResume(agent) || canLoad(agent) ? (["resume"] as const) : []),
  ...(takesImages(agent) ? (["image_input"] as const) : []),
];

/** A select setting's values, flat, groups included. */
const selectValues = (option: AcpConfigOption) =>
  (option.options ?? []).flatMap((entry) =>
    "value" in entry ? [entry] : entry.options,
  );

const configOf = (state: AcpSessionState, category: string) =>
  state?.configOptions?.find((option) => option.category === category) ?? null;

/** The models a session offers: its model list, else its model setting. */
const sessionModels = (
  state: AcpSessionState,
  agent: AcpInitializeResponse,
): HarnessModel[] => {
  const inputModalities = takesImages(agent) ? ["text", "image"] : ["text"];
  const thought = configOf(state, "thought_level");
  const efforts = knownReasoningEfforts(
    thought === null ? [] : selectValues(thought).map(({ value }) => value),
  );
  const listed = state?.models;
  if (listed !== null && listed !== undefined) {
    return listed.availableModels.map((model) => ({
      id: model.modelId,
      displayName: model.name,
      isDefault: model.modelId === listed.currentModelId,
      // The thought levels an agent reports are the current model's.
      reasoningEfforts: model.modelId === listed.currentModelId ? efforts : [],
      inputModalities,
    }));
  }
  const setting = configOf(state, "model");
  if (setting === null) {
    return [];
  }
  return selectValues(setting).map((model) => ({
    id: model.value,
    displayName: model.name,
    isDefault: model.value === setting.currentValue,
    reasoningEfforts: model.value === setting.currentValue ? efforts : [],
    inputModalities,
  }));
};

/** A probe session's folder, made and removed by the probe. */
const probeFolder = (configDir: string) =>
  Result.try(() => {
    mkdirSync(configDir, { recursive: true });
    return mkdtempSync(path.join(configDir, "probe-"));
  });

const removeProbeFolder = (dir: string) =>
  Result.isOk(
    Result.try(() => {
      rmSync(dir, { recursive: true, force: true });
    }),
  );

const probeAgent = async (
  options: AcpHarnessAdapterOptions,
): Promise<Result<HarnessProbe, HarnessProbeError>> => {
  const holder: { client: AcpClient | null } = { client: null };
  const folder = probeFolder(options.configDir);
  if (Result.isError(folder)) {
    return Result.err(
      new HarnessProbeError({
        reason: "harness_unavailable",
        message: "The agent's state directory cannot be written.",
      }),
    );
  }
  const cwd = folder.value;
  const connected = await connect({
    options,
    cwd,
    environment: {},
    handlers: {
      notification: () => undefined,
      request: (id, method) => {
        holder.client?.respondError(
          id,
          ACP_ERROR.methodNotFound,
          `stella does not answer ${method}.`,
        );
      },
      violation: () => undefined,
      exit: () => undefined,
    },
  });
  if (Result.isError(connected)) {
    removeProbeFolder(cwd);
    return Result.err(new HarnessProbeError(connected.error));
  }
  const { client, agent } = connected.value;
  holder.client = client;
  const probeSession: { id: string | null } = { id: null };
  const result = await (async (): Promise<
    Result<HarnessProbe, HarnessProbeError>
  > => {
    const version = agent.agentInfo?.version ?? null;
    if (version === null) {
      return Result.err(
        new HarnessProbeError({
          reason: "protocol_violation",
          message: "The agent did not report its version.",
        }),
      );
    }
    if (!speaksHttpMcp(agent)) {
      return Result.err(
        new HarnessProbeError({
          reason: "harness_unavailable",
          message: `${options.definition.displayName} cannot reach stella's tools: it takes no MCP servers over HTTP.`,
        }),
      );
    }
    const signedIn = await authenticate(client, options);
    if (Result.isError(signedIn)) {
      return Result.err(
        new HarnessProbeError({
          reason: "harness_unavailable",
          message: signedIn.error.message,
        }),
      );
    }
    const signedOut: HarnessProbe = {
      version,
      auth: { type: "signed_out" },
      models: [],
      capabilities: capabilities(agent, options.definition),
      approvalModes: [...options.definition.approvalModes],
      usageLimit: null,
    };
    if (signedIn.value === "signed_out") {
      return Result.ok(signedOut);
    }
    // Its models are a session's: one is opened and never prompted.
    const opened = await client.request("session/new", {
      cwd,
      mcpServers: [],
    });
    if (Result.isError(opened)) {
      return opened.error.code === ACP_ERROR.authRequired
        ? Result.ok(signedOut)
        : Result.err(
            new HarnessProbeError({
              reason: "harness_unavailable",
              message: opened.error.message,
            }),
          );
    }
    const session = v.safeParse(AcpNewSessionResponseSchema, opened.value);
    if (!session.success) {
      return Result.err(
        new HarnessProbeError({
          reason: "protocol_violation",
          message: "The agent answered session/new with an unexpected shape.",
        }),
      );
    }
    probeSession.id = session.output.sessionId;
    return Result.ok({
      ...signedOut,
      auth: { type: "signed_in", method: "agent", plan: null },
      models: sessionModels(session.output, agent),
    } satisfies HarnessProbe);
  })();
  await close(client, options.gracePeriodMs);
  removeProbeFolder(cwd);
  if (probeSession.id !== null) {
    options.definition.discardSession?.(options.configDir, probeSession.id);
  }
  return result;
};

/**
 * The agent's account, models and abilities. An agent slow to launch
 * answers from the last probe while its executable and stored sign-in are
 * unchanged.
 */
const probe = async (
  options: AcpHarnessAdapterOptions,
): Promise<Result<HarnessProbe, HarnessProbeError>> => {
  const nowMs = Temporal.Now.instant().epochMilliseconds;
  sweepTempDirs(options.configDir, nowMs);
  const { probeCacheMs, storedSignIn } = options.definition;
  const key =
    probeCacheMs > 0
      ? probeKey(
          options.executable,
          storedSignIn === null
            ? null
            : storedSignIn.signedIn(options.configDir),
        )
      : null;
  if (key !== null) {
    const cached = readCachedProbe({
      configDir: options.configDir,
      key,
      maxAgeMs: probeCacheMs,
      nowMs,
    });
    if (cached !== null) {
      return Result.ok(cached);
    }
  }
  const probed = await probeAgent(options);
  if (key !== null && Result.isOk(probed)) {
    writeCachedProbe({
      configDir: options.configDir,
      key,
      nowMs,
      probe: probed.value,
    });
  }
  return probed;
};

type OpenedSession = {
  sessionId: string;
  state: AcpSessionState;
  continuation: HarnessContinuation;
};

const newSession = async (
  client: AcpClient,
  input: HarnessTurnInput,
  continuation: HarnessContinuation,
): Promise<Result<OpenedSession, HarnessStartError>> => {
  const opened = await client.request("session/new", {
    cwd: input.workspaceDir,
    mcpServers: mcpServers(input),
  });
  if (Result.isError(opened)) {
    return Result.err(
      new HarnessStartError(
        opened.error.code === ACP_ERROR.authRequired
          ? { reason: "auth_required", message: SIGNED_OUT }
          : { reason: "start_rejected", message: opened.error.message },
      ),
    );
  }
  const parsed = v.safeParse(AcpNewSessionResponseSchema, opened.value);
  if (!parsed.success) {
    return Result.err(
      new HarnessStartError({
        reason: "protocol_violation",
        message: "The agent answered session/new with an unexpected shape.",
      }),
    );
  }
  return Result.ok({
    sessionId: parsed.output.sessionId,
    state: parsed.output,
    continuation,
  });
};

/**
 * The session the turn continues: resumed where the agent can (`resume`
 * replays nothing; `load` replays the history, which the turn drops), else
 * a new one that gets the transcript.
 */
const openSession = async ({
  client,
  agent,
  input,
  session,
  configDir,
}: {
  client: AcpClient;
  agent: AcpInitializeResponse;
  input: HarnessTurnInput;
  session: AcpTurnSession;
  configDir: string;
}): Promise<Result<OpenedSession, HarnessStartError>> => {
  const { continuation } = input;
  if (continuation.type === "fresh" || continuation.type === "live") {
    return newSession(client, input, { type: "fresh" });
  }
  const unavailable = (
    reason: "session_not_found" | "resume_rejected",
    message: string,
  ): HarnessContinuation => ({ type: "resume_unavailable", reason, message });
  if (continuation.type === "fork") {
    return newSession(
      client,
      input,
      unavailable("resume_rejected", "The agent cannot fork a session."),
    );
  }
  const method = reopenMethod(agent);
  if (method === null) {
    return newSession(
      client,
      input,
      unavailable("resume_rejected", "The agent cannot resume a session."),
    );
  }
  const sessionId: string = continuation.sessionId;
  if (isSessionBroken(configDir, sessionId)) {
    return newSession(
      client,
      input,
      unavailable(
        "resume_rejected",
        "The agent can no longer continue its saved session.",
      ),
    );
  }
  if (method === "session/load") {
    session.loading(sessionId);
  }
  const reopened = await client.request(method, {
    sessionId,
    cwd: input.workspaceDir,
    mcpServers: mcpServers(input),
  });
  session.loaded();
  if (Result.isError(reopened)) {
    if (reopened.error.reason !== "rejected") {
      return Result.err(
        new HarnessStartError({
          reason: "harness_unavailable",
          message: reopened.error.message,
        }),
      );
    }
    if (reopened.error.code === ACP_ERROR.authRequired) {
      return Result.err(
        new HarnessStartError({
          reason: "auth_required",
          message: SIGNED_OUT,
        }),
      );
    }
    return newSession(
      client,
      input,
      unavailable(
        reopened.error.code === ACP_ERROR.resourceNotFound ||
          reopened.error.code === ACP_ERROR.invalidParams
          ? "session_not_found"
          : "resume_rejected",
        reopened.error.message,
      ),
    );
  }
  const state = v.safeParse(AcpOpenedSessionResponseSchema, reopened.value);
  if (!state.success) {
    return Result.err(
      new HarnessStartError({
        reason: "protocol_violation",
        message: `The agent answered ${method} with an unexpected shape.`,
      }),
    );
  }
  return Result.ok({
    sessionId,
    state: state.output,
    continuation: { type: "resumed" },
  });
};

/** The turn's mode, model and effort, where the session offers them. */
/** The session's settings after a change, when the agent reported them. */
const ConfigOptionsAnswerSchema = v.object({
  configOptions: v.array(v.unknown()),
});

const rejectedStart = (message: string) =>
  Result.err(new HarnessStartError({ reason: "start_rejected", message }));

/**
 * The turn's mode, model and effort, where the session offers them. A
 * setting is changed through the session's settings (`config_option`), or
 * the older mode and model methods where the agent lists only those.
 */
const configure = async (
  client: AcpClient,
  options: AcpHarnessAdapterOptions,
  input: HarnessTurnInput,
  opened: OpenedSession,
): Promise<Result<void, HarnessStartError>> => {
  const { sessionId } = opened;
  const session = { state: opened.state };
  const setOption = async (configId: string, value: string) => {
    const set = await client.request("session/set_config_option", {
      sessionId,
      configId,
      value,
    });
    if (Result.isOk(set)) {
      // A change may change what else is offered (a model's efforts).
      const answered = v.safeParse(ConfigOptionsAnswerSchema, set.value);
      const state = answered.success
        ? v.safeParse(AcpOpenedSessionResponseSchema, {
            configOptions: answered.output.configOptions,
          })
        : null;
      if (
        state?.success === true &&
        state.output !== null &&
        state.output !== undefined
      ) {
        session.state = {
          ...session.state,
          configOptions: state.output.configOptions,
        };
      }
    }
    return set;
  };

  const { approvals } = input.policy;
  const modeId =
    approvals === "full_auto"
      ? undefined
      : options.definition.sessionModes[approvals];
  const modeSetting = configOf(session.state, "mode");
  const modes = session.state?.modes ?? null;
  if (modeId !== undefined && modeSetting !== null) {
    if (
      modeSetting.currentValue !== modeId &&
      selectValues(modeSetting).some(({ value }) => value === modeId)
    ) {
      const set = await setOption(modeSetting.id, modeId);
      if (Result.isError(set)) {
        return rejectedStart(set.error.message);
      }
    }
  } else if (
    modeId !== undefined &&
    modes !== null &&
    modes.currentModeId !== modeId &&
    modes.availableModes.some(({ id }) => id === modeId)
  ) {
    const set = await client.request("session/set_mode", { sessionId, modeId });
    if (Result.isError(set)) {
      return rejectedStart(set.error.message);
    }
  }

  const modelSetting = configOf(session.state, "model");
  const listed = session.state?.models ?? null;
  if (modelSetting !== null) {
    if (modelSetting.currentValue !== input.model) {
      const set = await setOption(modelSetting.id, input.model);
      if (Result.isError(set)) {
        return rejectedStart(set.error.message);
      }
    }
  } else if (listed !== null && listed.currentModelId !== input.model) {
    const set = await client.request("session/set_model", {
      sessionId,
      modelId: input.model,
    });
    if (Result.isError(set)) {
      return rejectedStart(set.error.message);
    }
  }

  const thought = configOf(session.state, "thought_level");
  if (
    input.reasoningEffort !== null &&
    thought !== null &&
    thought.currentValue !== input.reasoningEffort &&
    selectValues(thought).some(({ value }) => value === input.reasoningEffort)
  ) {
    const set = await setOption(thought.id, input.reasoningEffort);
    if (Result.isError(set)) {
      return rejectedStart(set.error.message);
    }
  }
  return Result.ok();
};

/** The prompt's content blocks: instructions, images, then the request. */
const promptBlocks = (
  agent: AcpInitializeResponse,
  input: HarnessTurnInput,
  prompt: string,
) => [
  { type: "text", text: instructionsBlock(input.instructions) },
  ...(takesImages(agent)
    ? input.inputFiles.flatMap((file) =>
        file.type === "image"
          ? [{ type: "image", mimeType: file.mediaType, data: file.base64 }]
          : [],
      )
    : []),
  { type: "text", text: prompt },
];

const startTurn = async (
  options: AcpHarnessAdapterOptions,
  input: HarnessTurnInput,
): Promise<Result<HarnessTurn, HarnessStartError>> => {
  const approvals = input.policy.approvals;
  if (
    approvals === "full_auto" ||
    !options.definition.approvalModes.includes(approvals)
  ) {
    return Result.err(
      new HarnessStartError({
        reason: "start_rejected",
        message: `${options.definition.displayName} does not run in this approval mode.`,
      }),
    );
  }
  const stored = options.definition.storedSignIn;
  if (stored !== null && !stored.signedIn(options.configDir)) {
    return Result.err(
      new HarnessStartError({ reason: "auth_required", message: SIGNED_OUT }),
    );
  }
  if (input.continuation.type === "live") {
    // This adapter never keeps a process between turns.
    await input.continuation.session.end();
  }
  const standalone = buildTurnPrompt({
    transcript: input.transcript,
    mode: "standalone",
  });
  if (Result.isError(standalone)) {
    return standalone;
  }
  if (!path.isAbsolute(input.workspaceDir)) {
    panic("ACP adapter: the workspace directory must be an absolute path");
  }
  const sessionHolder: { id: string | null } = { id: null };
  const session = new AcpTurnSession({
    gracePeriodMs: options.gracePeriodMs,
    detached: createDetached(options.onBackgroundError),
    displayName: options.definition.displayName,
    mcpNames: {
      stella: input.mcp.serverName,
      others: input.browser === null ? [] : [input.browser.serverName],
    },
    policy: input.policy,
    workspaceDir: input.workspaceDir,
    unreadablePaths: input.unreadablePaths,
    onPromptError: (message) => {
      if (
        options.definition.brokenSession(message) &&
        sessionHolder.id !== null
      ) {
        markSessionBroken(options.configDir, sessionHolder.id);
      }
    },
  });
  const connected = await connect({
    options,
    cwd: input.workspaceDir,
    environment: {
      ...packageCacheEnvironment(input.cacheDir),
      ...toolPathEnvironment(options.environment, input.toolPath),
    },
    handlers: session.handlers,
  });
  if (Result.isError(connected)) {
    session.abandon();
    return Result.err(new HarnessStartError(connected.error));
  }
  const { client, agent } = connected.value;
  session.attach(client);
  const fail = async (error: HarnessStartError) => {
    session.abandon();
    await client.kill();
    return Result.err(error);
  };
  if (!speaksHttpMcp(agent)) {
    return fail(
      new HarnessStartError({
        reason: "harness_unavailable",
        message: `${options.definition.displayName} cannot reach stella's tools.`,
      }),
    );
  }
  const signedIn = await authenticate(client, options);
  if (Result.isError(signedIn) || signedIn.value === "signed_out") {
    return fail(
      new HarnessStartError(
        Result.isError(signedIn)
          ? { reason: "harness_unavailable", message: signedIn.error.message }
          : { reason: "auth_required", message: SIGNED_OUT },
      ),
    );
  }
  const opened = await openSession({
    client,
    agent,
    input,
    session,
    configDir: options.configDir,
  });
  if (Result.isError(opened)) {
    return fail(opened.error);
  }
  const configured = await configure(client, options, input, opened.value);
  if (Result.isError(configured)) {
    return fail(configured.error);
  }
  const { sessionId, continuation } = opened.value;
  const prompt = sessionHoldsHistory(continuation)
    ? buildTurnPrompt({ transcript: input.transcript, mode: "resumed" })
    : standalone;
  if (Result.isError(prompt)) {
    return fail(prompt.error);
  }
  sessionHolder.id = sessionId;
  session.steers(steers(agent, options.definition));
  session.begin(sessionId, continuation);
  session.prompted(
    client.request("session/prompt", {
      sessionId,
      prompt: promptBlocks(agent, input, prompt.value),
    }),
  );
  return Result.ok(
    redactingSkillPaths(session.turn(), {
      folders: input.skillFolders,
      plugin: null,
    }),
  );
};

export const createAcpHarnessAdapter = (
  options: AcpHarnessAdapterOptions,
): HarnessAdapter => {
  validateOptions(options);
  return {
    harness: options.definition.harness,
    inputFileTypes: ACP_INPUT_FILE_TYPES,
    probe: async () => probe(options),
    startTurn: async (input) => startTurn(options, input),
  };
};
