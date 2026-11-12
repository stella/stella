import { panic, Result } from "better-result";
import { homedir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import {
  DESKTOP_RUNNER_APPROVAL_MODES,
  knownReasoningEfforts,
} from "@stll/api-contract/desktop-runner";
import { createDetached, type DetachedRejectionSink } from "@stll/errors";

import type { ProtocolLog } from "../../protocol-log";
import {
  type HarnessAdapter,
  type HarnessAuth,
  type HarnessCapability,
  type HarnessInputFile,
  type HarnessInputFileType,
  type HarnessLiveSession,
  type HarnessModel,
  type HarnessProbe,
  HarnessProbeError,
  HarnessStartError,
  type HarnessTurn,
  type HarnessTurnInput,
} from "../adapter";
import type { HarnessContinuation } from "../events";
import { packageCacheEnvironment } from "../package-cache";
import { redactingSkillPaths } from "../skill-redaction";
import { toolPathEnvironment } from "../tool-path";
import { buildTurnPrompt } from "../transcript-handoff";
import { settlesWithin } from "../turn-lifecycle";
import {
  type AppServerClient,
  type AppServerHandlers,
  type AppServerLaunch,
  startAppServer,
} from "./app-server-client";
import { CodexProcess } from "./background";
import {
  CODEX_CLIENT_INFO,
  CODEX_OPT_OUT_NOTIFICATIONS,
  GetAccountResponseSchema,
  InitializeResponseSchema,
  METHOD_NOT_FOUND,
  ModelListResponseSchema,
  TurnStartResponseSchema,
} from "./protocol";
import { openThread } from "./thread";
import { type CodexCapacityRetry, CodexTurnSession } from "./turn";

/**
 * Codex over `codex app-server` (JSON-RPC on stdio), one process per turn,
 * kept for the next turn while its background terminals run (`background.ts`).
 * The process runs with a stella-owned `CODEX_HOME`, so the user's own Codex
 * configuration, sessions and sign-in stay untouched, and a session started
 * here resumes from the rollout that home keeps between turns.
 *
 * Approach adapted from t3code (MIT, `CodexAdapterV2.ts`): one initialize per
 * process, account read before any session, resume by native thread id.
 */

/** `codex app-server`, with each configuration override as `-c <override>`. */
export const codexAppServerLaunch = (
  executable: string,
  configOverrides: readonly string[] = [],
): AppServerLaunch => ({
  executable,
  args: [
    "app-server",
    ...configOverrides.flatMap((override) => ["-c", override]),
  ],
});

export type CodexHarnessAdapterOptions = {
  /** The managed CLI; never resolved from `PATH`. */
  launch: AppServerLaunch;
  /** stella-owned Codex home directory, never the user's `~/.codex`. */
  codexHome: string;
  /** Base environment for the harness; `CODEX_HOME` is always overridden. */
  environment: Readonly<Record<string, string>>;
  /** Desktop version, reported to the harness as the client version. */
  clientVersion: string;
  /**
   * How long an interrupt or a shutdown waits before the process is killed,
   * and how long a killed process gets before SIGKILL.
   */
  gracePeriodMs: number;
  /** How long any request to the harness waits for its answer. */
  requestTimeoutMs: number;
  /** See `HarnessProcessDeadlines.startupRequestMs`. */
  startupRequestTimeoutMs?: number;
  /** Receives failures of background work, such as a process shutdown. */
  onBackgroundError: DetachedRejectionSink;
  /** Where the app server's protocol lines go, redacted. */
  protocolLog: ProtocolLog;
  /**
   * Called with each new process's id before it is asked anything; a
   * process it does not answer `true` for is ended unused.
   */
  onProcess?: (pid: number) => Promise<boolean>;
  /** `initialize`'s client name, when a credential was registered under one. */
  clientName?: string;
  /** How a turn ended by the model's capacity continues; defaults below. */
  capacityRetry?: CodexCapacityRetry;
};

/** As t3code (MIT) retries: five continuations, 2 s doubling to 30 s. */
const DEFAULT_CAPACITY_RETRY: CodexCapacityRetry = {
  maxAttempts: 5,
  baseDelayMs: 2000,
  maxDelayMs: 30_000,
  sleep: Bun.sleep,
};

const MAX_MODEL_PAGES = 20;
/** `<client name>/<version> (<platform>) ...`, as `initialize` reports it. */
const USER_AGENT_VERSION = /^[^/\s]+\/(\S+)/u;

/** What this adapter does with Codex. */
// Typed, not literal: every row could turn off, so each is a real check.
const CODEX_CAPABILITIES: Readonly<Record<HarnessCapability, boolean>> = {
  approvals: true,
  interrupt: true,
  resume: true,
  // The turn's images open `turn/start` as image items.
  image_input: true,
};

/** Codex takes images as input; a PDF stays a path the agent opens. */
const CODEX_INPUT_FILE_TYPES = [
  "image",
] as const satisfies readonly HarnessInputFileType[];

/** A `turn/start` input item, as the app-server's `UserInput` defines it. */
type TurnInputItem =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "image"; url: string };

/**
 * The turn's input: images first, then the text, which still names each
 * image's copy so the agent can open it.
 */
const turnInputItems = (
  files: readonly HarnessInputFile[],
  text: string,
): TurnInputItem[] => [
  ...files.flatMap((file): TurnInputItem[] =>
    file.type === "image"
      ? [{ type: "image", url: `data:${file.mediaType};base64,${file.base64}` }]
      : [],
  ),
  { type: "text", text, text_elements: [] },
];

const capabilities = (): HarnessCapability[] =>
  Object.entries(CODEX_CAPABILITIES).flatMap(([capability, supported]) =>
    supported && isCapability(capability) ? [capability] : [],
  );

const isCapability = (value: string): value is HarnessCapability =>
  Object.hasOwn(CODEX_CAPABILITIES, value);

const validateOptions = (options: CodexHarnessAdapterOptions) => {
  if (!path.isAbsolute(options.launch.executable)) {
    panic("Codex adapter: the harness executable must be an absolute path");
  }
  if (!path.isAbsolute(options.codexHome)) {
    panic("Codex adapter: CODEX_HOME must be an absolute path");
  }
  if (
    path.resolve(options.codexHome) ===
    path.resolve(path.join(homedir(), ".codex"))
  ) {
    panic(
      "Codex adapter: CODEX_HOME must be stella's, not the user's ~/.codex",
    );
  }
};

type Connection = { client: AppServerClient; version: string | null };
type ConnectFailure = {
  reason: "harness_unavailable" | "protocol_violation";
  message: string;
};

type ConnectOptions = {
  options: CodexHarnessAdapterOptions;
  cwd: string;
  handlers: AppServerHandlers;
  /** Set over the base environment for this process. */
  environment: Readonly<Record<string, string>>;
};

/** Spawn the server and complete the handshake; `initialize` is once only. */
const connect = async ({
  options,
  cwd,
  handlers,
  environment,
}: ConnectOptions): Promise<Result<Connection, ConnectFailure>> => {
  const started = startAppServer({
    launch: options.launch,
    protocolLog: options.protocolLog,
    detached: createDetached(options.onBackgroundError),
    deadlines: {
      requestMs: options.requestTimeoutMs,
      startupRequestMs: options.startupRequestTimeoutMs,
      terminateMs: options.gracePeriodMs,
    },
    cwd,
    env: {
      ...options.environment,
      ...environment,
      CODEX_HOME: options.codexHome,
    },
    handlers,
  });
  if (Result.isError(started)) {
    return Result.err({
      reason: "harness_unavailable",
      message: "The harness could not be started.",
    });
  }
  const client = started.value;
  if (
    options.onProcess !== undefined &&
    !(await options.onProcess(client.pid))
  ) {
    await client.kill();
    return Result.err({
      reason: "harness_unavailable",
      message: "The desktop did not authorize the harness process.",
    });
  }
  const initialized = await client.request("initialize", {
    clientInfo: {
      name: options.clientName ?? CODEX_CLIENT_INFO.name,
      title: CODEX_CLIENT_INFO.title,
      version: options.clientVersion,
    },
    capabilities: {
      // Questions and their async delivery are experimental protocol fields.
      experimentalApi: true,
      requestAttestation: false,
      optOutNotificationMethods: [...CODEX_OPT_OUT_NOTIFICATIONS],
    },
  });
  const parsed = Result.isOk(initialized)
    ? v.safeParse(InitializeResponseSchema, initialized.value)
    : null;
  if (parsed === null || !parsed.success) {
    await client.kill();
    return Result.err(
      Result.isError(initialized)
        ? { reason: "harness_unavailable", message: initialized.error.message }
        : {
            reason: "protocol_violation",
            message:
              "The harness answered initialize with an unexpected shape.",
          },
    );
  }
  client.notify("initialized");
  return Result.ok({
    client,
    version: USER_AGENT_VERSION.exec(parsed.output.userAgent)?.[1] ?? null,
  });
};

const readAccount = async (
  client: AppServerClient,
): Promise<HarnessAuth | null> => {
  const account = await client.request("account/read", {});
  const parsed = Result.isOk(account)
    ? v.safeParse(GetAccountResponseSchema, account.value)
    : null;
  if (parsed === null || !parsed.success) {
    return null;
  }
  const native = parsed.output.account;
  if (native === null) {
    return parsed.output.requiresOpenaiAuth
      ? { type: "signed_out" }
      : { type: "signed_in", method: "none", plan: null };
  }
  return {
    type: "signed_in",
    method: native.type,
    plan: native.planType ?? null,
  };
};

const listModels = async (
  client: AppServerClient,
): Promise<HarnessModel[] | null> => {
  const models: HarnessModel[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    const listed = await client.request(
      "model/list",
      cursor === null ? {} : { cursor },
    );
    const parsed = Result.isOk(listed)
      ? v.safeParse(ModelListResponseSchema, listed.value)
      : null;
    if (parsed === null || !parsed.success) {
      return null;
    }
    for (const model of parsed.output.data) {
      if (!model.hidden) {
        models.push({
          id: model.id,
          displayName: model.displayName,
          isDefault: model.isDefault,
          reasoningEfforts: knownReasoningEfforts(
            model.supportedReasoningEfforts.map(
              ({ reasoningEffort }) => reasoningEffort,
            ),
          ),
          inputModalities: model.inputModalities,
        });
      }
    }
    cursor = parsed.output.nextCursor;
    if (cursor === null) {
      return models;
    }
  }
  return models;
};

/**
 * The turn's input files, if the model lists images as input. A model that
 * does not, or a listing that fails, keeps them the paths the prompt names.
 */
const filesTheModelReads = async (
  client: AppServerClient,
  input: HarnessTurnInput,
): Promise<readonly HarnessInputFile[]> => {
  if (!input.inputFiles.some(({ type }) => type === "image")) {
    return [];
  }
  const models = await listModels(client);
  const model = models?.find(({ id }) => id === input.model);
  return model?.inputModalities.includes("image") === true
    ? input.inputFiles
    : [];
};

const close = async (client: AppServerClient, gracePeriodMs: number) => {
  client.closeInput();
  if (!(await settlesWithin(client.exited, gracePeriodMs))) {
    await client.kill();
  }
};

/** Account and models as the harness reports them, without a session. */
const probe = async (
  options: CodexHarnessAdapterOptions,
): Promise<Result<HarnessProbe, HarnessProbeError>> => {
  const holder: { client: AppServerClient | null } = { client: null };
  const connected = await connect({
    options,
    cwd: options.codexHome,
    environment: {},
    handlers: {
      notification: () => undefined,
      request: (id, method) => {
        holder.client?.respondError(
          id,
          METHOD_NOT_FOUND,
          `Stella does not answer ${method}.`,
        );
      },
      violation: () => undefined,
      exit: () => undefined,
    },
  });
  if (Result.isError(connected)) {
    return Result.err(new HarnessProbeError(connected.error));
  }
  const { client, version } = connected.value;
  holder.client = client;
  const result = await (async (): Promise<
    Result<HarnessProbe, HarnessProbeError>
  > => {
    const auth = await readAccount(client);
    if (version === null || auth === null) {
      return Result.err(
        new HarnessProbeError({
          reason: "protocol_violation",
          message: "The harness did not report its version and account.",
        }),
      );
    }
    const models = auth.type === "signed_out" ? [] : await listModels(client);
    if (models === null) {
      return Result.err(
        new HarnessProbeError({
          reason: "protocol_violation",
          message: "The harness did not list its models.",
        }),
      );
    }
    return Result.ok({
      version,
      auth,
      models,
      capabilities: capabilities(),
      // Every level: `CODEX_LEVEL` in thread.ts maps each, and Codex sandboxes
      // every command at every level.
      approvalModes: [...DESKTOP_RUNNER_APPROVAL_MODES],
      // The probe does not read rate limits; a limited turn reports them.
      usageLimit: null,
    });
  })();
  await close(client, options.gracePeriodMs);
  return result;
};

const turnSession = (
  options: CodexHarnessAdapterOptions,
  input: HarnessTurnInput,
  appServer: CodexProcess,
) => {
  const session = new CodexTurnSession({
    gracePeriodMs: options.gracePeriodMs,
    detached: createDetached(options.onBackgroundError),
    stellaServer: input.mcp.serverName,
    capacityRetry: options.capacityRetry ?? DEFAULT_CAPACITY_RETRY,
    background: appServer.turnBackground,
  });
  appServer.route(session.handlers);
  return session;
};

/** The turn's prompt, its images and `turn/start` on the open thread. */
const beginTurn = async ({
  client,
  input,
  session,
  threadId,
  prompt,
  continuation,
}: {
  client: AppServerClient;
  input: HarnessTurnInput;
  session: CodexTurnSession;
  threadId: string;
  prompt: string;
  continuation: HarnessContinuation;
}): Promise<Result<HarnessTurn, HarnessStartError>> => {
  const files = await filesTheModelReads(client, input);
  const started = await client.request("turn/start", {
    threadId,
    input: turnInputItems(files, prompt),
    // Codex keeps it for later turns of the process, so a capacity
    // continuation runs at it too; omitted, the harness's own setting holds.
    ...(input.reasoningEffort === null
      ? {}
      : { effort: input.reasoningEffort }),
  });
  const parsed = Result.isOk(started)
    ? v.safeParse(TurnStartResponseSchema, started.value)
    : null;
  if (parsed === null || !parsed.success) {
    return Result.err(
      new HarnessStartError({
        reason: "start_rejected",
        message: Result.isError(started)
          ? started.error.message
          : "The harness answered turn/start with an unexpected shape.",
      }),
    );
  }
  session.begin({
    threadId,
    turnId: parsed.output.turn.id,
    startedAt: parsed.output.turn.startedAt ?? null,
    continuation,
  });
  return Result.ok(
    redactingSkillPaths(session.turn(), {
      folders: input.skillFolders,
      plugin: null,
    }),
  );
};

/**
 * The next turn in the process a completed turn kept for its background
 * terminals: the thread is loaded there with them, so the turn starts on it
 * without resuming. A session that ended meanwhile is resumed from its
 * rollout like any other.
 */
const continueTurn = async (
  options: CodexHarnessAdapterOptions,
  input: HarnessTurnInput,
  live: HarnessLiveSession,
): Promise<Result<HarnessTurn, HarnessStartError>> => {
  const appServer = CodexProcess.of(live);
  const threadId = appServer?.threadId ?? null;
  if (appServer === undefined || threadId === null || !appServer.take(live)) {
    await live.end();
    return startTurn(options, {
      ...input,
      continuation: { type: "resume", sessionId: live.sessionId },
    });
  }
  const client = appServer.client;
  const session = turnSession(options, input, appServer);
  session.attach(client);
  const prompt = buildTurnPrompt({
    transcript: input.transcript,
    mode: "resumed",
  });
  const fail = async (error: HarnessStartError) => {
    session.abandon();
    await settlesWithin(appServer.stop(client), options.gracePeriodMs);
    await client.kill();
    return Result.err(error);
  };
  if (Result.isError(prompt)) {
    return fail(prompt.error);
  }
  const begun = await beginTurn({
    client,
    input,
    session,
    threadId,
    prompt: prompt.value,
    continuation: { type: "resumed" },
  });
  return Result.isError(begun) ? fail(begun.error) : begun;
};

const startTurn = async (
  options: CodexHarnessAdapterOptions,
  input: HarnessTurnInput,
): Promise<Result<HarnessTurn, HarnessStartError>> => {
  if (input.continuation.type === "live") {
    return continueTurn(options, input, input.continuation.session);
  }
  const standalone = buildTurnPrompt({
    transcript: input.transcript,
    mode: "standalone",
  });
  if (Result.isError(standalone)) {
    return standalone;
  }
  if (!path.isAbsolute(input.workspaceDir)) {
    panic("Codex adapter: the workspace directory must be an absolute path");
  }
  const appServer = new CodexProcess({
    gracePeriodMs: options.gracePeriodMs,
    detached: createDetached(options.onBackgroundError),
  });
  const session = turnSession(options, input, appServer);
  const connected = await connect({
    options,
    cwd: input.workspaceDir,
    environment: {
      ...packageCacheEnvironment(input.cacheDir),
      ...toolPathEnvironment(options.environment, input.toolPath),
    },
    handlers: appServer.handlers,
  });
  if (Result.isError(connected)) {
    session.abandon();
    return Result.err(new HarnessStartError(connected.error));
  }
  const { client } = connected.value;
  appServer.attach(client);
  session.attach(client);
  const fail = async (error: HarnessStartError) => {
    session.abandon();
    await client.kill();
    return Result.err(error);
  };

  const auth = await readAccount(client);
  if (auth === null || auth.type === "signed_out") {
    return fail(
      new HarnessStartError(
        auth === null
          ? {
              reason: "protocol_violation",
              message: "The harness did not report its account.",
            }
          : {
              reason: "auth_required",
              message: "The harness is not signed in.",
            },
      ),
    );
  }
  const opened = await openThread(client, input);
  if (Result.isError(opened)) {
    return fail(opened.error);
  }
  const { threadId, continuation } = opened.value;
  appServer.threadId = threadId;
  const prompt =
    continuation.type === "resumed"
      ? buildTurnPrompt({ transcript: input.transcript, mode: "resumed" })
      : standalone;
  if (Result.isError(prompt)) {
    return fail(prompt.error);
  }
  const begun = await beginTurn({
    client,
    input,
    session,
    threadId,
    prompt: prompt.value,
    continuation,
  });
  return Result.isError(begun) ? fail(begun.error) : begun;
};

export const createCodexHarnessAdapter = (
  options: CodexHarnessAdapterOptions,
): HarnessAdapter => {
  validateOptions(options);
  return {
    harness: "codex",
    inputFileTypes: CODEX_INPUT_FILE_TYPES,
    probe: async () => probe(options),
    startTurn: async (input) => startTurn(options, input),
  };
};
