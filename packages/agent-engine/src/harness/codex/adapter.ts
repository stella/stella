import { panic, Result } from "better-result";
import { homedir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { createDetached, type DetachedRejectionSink } from "@stll/errors";

import {
  type HarnessAdapter,
  type HarnessAuth,
  type HarnessCapability,
  type HarnessModel,
  type HarnessProbe,
  HarnessProbeError,
  HarnessStartError,
  type HarnessTurn,
  type HarnessTurnInput,
} from "../adapter";
import { buildTurnPrompt } from "../transcript-handoff";
import {
  type AppServerClient,
  type AppServerHandlers,
  type AppServerLaunch,
  startAppServer,
} from "./app-server-client";
import {
  CODEX_OPT_OUT_NOTIFICATIONS,
  GetAccountResponseSchema,
  InitializeResponseSchema,
  METHOD_NOT_FOUND,
  ModelListResponseSchema,
  TurnStartResponseSchema,
} from "./protocol";
import { openThread } from "./thread";
import { CodexTurnSession } from "./turn";

/**
 * Codex over `codex app-server` (JSON-RPC on stdio), one process per turn.
 * The process runs with a stella-owned `CODEX_HOME`, so the user's own Codex
 * configuration, sessions and sign-in stay untouched, and a session started
 * here resumes from the rollout that home keeps between turns.
 *
 * Approach adapted from t3code (MIT, `CodexAdapterV2.ts`): one initialize per
 * process, account read before any session, resume by native thread id.
 */

export const codexAppServerLaunch = (executable: string): AppServerLaunch => ({
  executable,
  args: ["app-server"],
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
  /** How long an interrupt or a shutdown waits before the process is killed. */
  gracePeriodMs: number;
  /** Receives failures of background work, such as a process shutdown. */
  onBackgroundError: DetachedRejectionSink;
};

const CLIENT_NAME = "stella";
const MAX_MODEL_PAGES = 20;
/** `<client name>/<version> (<platform>) ...`, as `initialize` reports it. */
const USER_AGENT_VERSION = /^[^/\s]+\/(\S+)/u;

/**
 * What this adapter does with Codex. Image input stays off until turns send
 * attachments: the prompt is text only.
 */
const CODEX_CAPABILITIES = {
  approvals: true,
  interrupt: true,
  resume: true,
  image_input: false,
} as const satisfies Record<HarnessCapability, boolean>;

const capabilities = (): HarnessCapability[] =>
  Object.entries(CODEX_CAPABILITIES).flatMap(([capability, supported]) =>
    supported && isCapability(capability) ? [capability] : [],
  );

const isCapability = (value: string): value is HarnessCapability =>
  Object.hasOwn(CODEX_CAPABILITIES, value);

const settlesWithin = async (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true), Bun.sleep(ms).then(() => false)]);

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
};

/** Spawn the server and complete the handshake; `initialize` is once only. */
const connect = async ({
  options,
  cwd,
  handlers,
}: ConnectOptions): Promise<Result<Connection, ConnectFailure>> => {
  const started = Result.try(() =>
    startAppServer({
      launch: options.launch,
      detached: createDetached(options.onBackgroundError),
      cwd,
      env: { ...options.environment, CODEX_HOME: options.codexHome },
      handlers,
    }),
  );
  if (Result.isError(started)) {
    return Result.err({
      reason: "harness_unavailable",
      message: "The harness could not be started.",
    });
  }
  const client = started.value;
  const initialized = await client.request("initialize", {
    clientInfo: {
      name: CLIENT_NAME,
      title: "stella",
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
          reasoningEfforts: model.supportedReasoningEfforts.map(
            ({ reasoningEffort }) => reasoningEffort,
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
    return Result.ok({ version, auth, models, capabilities: capabilities() });
  })();
  await close(client, options.gracePeriodMs);
  return result;
};

const startTurn = async (
  options: CodexHarnessAdapterOptions,
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
    panic("Codex adapter: the workspace directory must be an absolute path");
  }
  const session = new CodexTurnSession({
    gracePeriodMs: options.gracePeriodMs,
    detached: createDetached(options.onBackgroundError),
    stellaServer: input.mcp.serverName,
  });
  const connected = await connect({
    options,
    cwd: input.workspaceDir,
    handlers: session.handlers,
  });
  if (Result.isError(connected)) {
    session.abandon();
    return Result.err(new HarnessStartError(connected.error));
  }
  const { client } = connected.value;
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
  const prompt =
    continuation.type === "resumed"
      ? buildTurnPrompt({ transcript: input.transcript, mode: "resumed" })
      : standalone;
  if (Result.isError(prompt)) {
    return fail(prompt.error);
  }
  const started = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: prompt.value, text_elements: [] }],
  });
  const parsed = Result.isOk(started)
    ? v.safeParse(TurnStartResponseSchema, started.value)
    : null;
  if (parsed === null || !parsed.success) {
    return fail(
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
  return Result.ok(session.turn());
};

export const createCodexHarnessAdapter = (
  options: CodexHarnessAdapterOptions,
): HarnessAdapter => {
  validateOptions(options);
  return {
    harness: "codex",
    probe: async () => probe(options),
    startTurn: async (input) => startTurn(options, input),
  };
};
