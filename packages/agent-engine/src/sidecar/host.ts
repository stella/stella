import { EventType } from "@tanstack/ai";
import { panic, Result } from "better-result";
import path from "node:path";
import { Temporal } from "temporal-polyfill/full";
import * as v from "valibot";

import type { AgentHarness } from "@stll/api-contract/agent-harness";
import { desktopVersionSchema } from "@stll/api-contract/desktop-presence";
import type {
  DESKTOP_RUNNER_RUN_OUTCOMES,
  DesktopRunnerCheckpointEvent,
} from "@stll/api-contract/desktop-runner";
import { createDetached } from "@stll/errors";

import type {
  HarnessAdapter,
  HarnessContinuationRequest,
  HarnessInteractionResponse,
  HarnessLiveSession,
  HarnessProbe,
  HarnessStartError,
  HarnessTurn,
} from "../harness/adapter";
import {
  createChunkCoalescer,
  scheduleTimeout,
} from "../harness/chunk-coalescer";
import {
  claudeCodeLaunch,
  createClaudeCodeHarnessAdapter,
} from "../harness/claude-code/adapter";
import {
  codexAppServerLaunch,
  createCodexHarnessAdapter,
} from "../harness/codex/adapter";
import {
  bundledHarnessCompatibility,
  HARNESS_COMPATIBILITY_DISPOSITION,
  resolveHarnessCompatibility,
} from "../harness/compatibility";
import { createEventQueue } from "../harness/event-queue";
import {
  approvalMessage,
  HARNESS_FAILURE_OUTCOME,
  type HarnessEvent,
  type HarnessFailure,
  harnessSessionId,
} from "../harness/events";
import { readSkillFolderNetworkHosts } from "../harness/skill-network-hosts";
import { harnessEventsToChunks } from "../harness/stream-chunks";
import { harnessTranscriptSchema } from "../harness/transcript-handoff";
import type { ProtocolLog } from "../protocol-log";
import { copyAttachments } from "./attachments";
import {
  captureCheckpoint,
  checkpointChunk,
  restoreCheckpoint,
} from "./checkpoints";
import { readInputFiles } from "./input-files";
import { type McpProxy, startMcpProxy } from "./mcp-proxy";
import {
  outputReportChunk,
  type OutputSnapshot,
  runOutputUploader,
  shareOutputs,
  snapshotOutputs,
} from "./outputs";
import {
  SIDECAR_MAX_BACKGROUND_TASKS,
  type SidecarFolderRestore,
  type SidecarHarnessLaunchSettings,
  type SidecarHostMessage,
  type SidecarHostOutput,
  type SidecarProbeOutcome,
  type SidecarRejection,
  type SidecarRestoreOutcome,
  type SidecarRunStart,
} from "./protocol";

/**
 * The sidecar's command loop: any number of concurrent runs, one harness
 * process per run. Every accepted `run.start` ends with exactly one
 * `run.finished`, also when the harness never started, so the host's run
 * bookkeeping needs no second failure path. The holder (`holder.ts`) owns the
 * connection, the handshake and the numbering of what this loop sends.
 *
 * A run whose turn completed while work its agent started in the background
 * still runs leaves its harness process to the chat's folder (a live
 * session, `HarnessLiveSession`): the chat's next run continues in it when it
 * resumes that session with the same launch, and sees that work. Anything
 * else ends it first: another session or launch, a stop of the next run, a
 * restore of the folder, the idle limit, the holder stopping, or another API
 * origin. It also ends by itself once its background work does. While it
 * waits, `background.tasks` reports how much work it holds.
 */

/** The host messages that act on harnesses and runs. */
export type SidecarCommand = Exclude<
  SidecarHostMessage,
  { type: "hello" | "ack" | "resume" | "drain" | "shutdown" }
>;

type RunOutcome = (typeof DESKTOP_RUNNER_RUN_OUTCOMES)[number];

/** How long an interrupt or a shutdown waits before a harness is killed. */
const HARNESS_GRACE_MS = 5000;
/**
 * How long one request to a harness waits for its answer. Requests return
 * once the harness accepts them (a turn streams afterwards), so this only
 * catches a harness that stopped answering.
 */
const HARNESS_REQUEST_TIMEOUT_MS = 30_000;
/**
 * How long a startup request waits: the CLI's first launch, which a busy
 * computer or an antivirus scan slows, and connecting stella's MCP server,
 * which the CLI itself gives up to 30 seconds.
 */
const HARNESS_STARTUP_REQUEST_TIMEOUT_MS = 2 * 60_000;
const MAX_PROBED_MODELS = 100;
/**
 * How long a chat's harness process kept for its background work waits for
 * the chat's next turn before that work is ended: long enough for a server
 * or a watcher to outlast a break, bounded so none runs on unseen for days.
 */
const LIVE_SESSION_IDLE_MS = 4 * 60 * 60_000;

/**
 * What a harness process was started with that a later turn cannot change:
 * a turn continues in a kept process only when this is the same.
 */
const launchKey = (
  message: SidecarRunStart,
  networkHosts: readonly string[],
): string =>
  JSON.stringify([
    message.harness,
    message.executable,
    message.configDir,
    message.launch,
    message.workspaceDir,
    message.cacheDir,
    message.toolPath,
    message.skillFolders,
    networkHosts,
    message.model,
    message.reasoningEffort,
    message.instructions,
    message.policy,
    message.mcp.serverName,
  ]);

/** How the run's turn continues the chat's native session, if at all. */
const continuationOf = (
  message: SidecarRunStart,
  taken: LiveFolder | null,
): HarnessContinuationRequest => {
  if (taken !== null) {
    return { type: "live", session: taken.session };
  }
  return message.harnessSessionId === null
    ? { type: "fresh" }
    : {
        type: "resume",
        sessionId: harnessSessionId(message.harnessSessionId),
      };
};

export type HarnessLaunch = {
  harness: AgentHarness;
  executable: string;
  configDir: string;
  launch: SidecarHarnessLaunchSettings;
  clientVersion: string;
};

export type SidecarHostOptions = {
  /**
   * Hands one message to the holder. `false` when the message cannot be
   * written within the contract (`encodeSidecarMessage`); the holder kept and
   * sent nothing then.
   */
  send: (message: SidecarHostOutput) => boolean;
  /** One line in the holder's log. Never passed tokens, prompts or outputs. */
  log: (line: string) => void;
  /** Where each harness process's protocol lines go, redacted. */
  protocolLog: ProtocolLog;
  /** The harness's environment; `CODEX_HOME` and the like are set per run. */
  environment: Readonly<Record<string, string>>;
  /**
   * How long a harness process whose launch asked for a grant waits for the
   * desktop's `harness.process_granted` before the run or probe fails.
   */
  processGrantTimeoutMs: number;
};

/** The inherited environment with the launch's removals and settings applied. */
const launchEnvironment = (
  base: Readonly<Record<string, string>>,
  settings: SidecarHarnessLaunchSettings,
): Record<string, string> => {
  const removed = new Set(settings.removedEnvironment);
  return {
    ...Object.fromEntries(
      Object.entries(base).filter(([name]) => !removed.has(name)),
    ),
    ...settings.environment,
  };
};

/**
 * Why a run was asked to stop, if it was. A cancel outranks an interrupt, so
 * its `run.finished` reports `cancelled`; the host stopping cancels its runs.
 */
const RUN_STOP = {
  none: "none",
  interrupt: "interrupt",
  cancel: "cancel",
} as const;

type RunStop = (typeof RUN_STOP)[keyof typeof RUN_STOP];

type HeldRun = {
  /** The run's folder, resolved: no restore touches it while the run is held. */
  readonly workspaceDir: string;
  turn: HarnessTurn | null;
  /** Set before the turn starts too: a turn that opens later stops at once. */
  stop: RunStop;
  /** Ends the attachment copy that comes before the turn. */
  readonly stopCopying: AbortController;
  /**
   * Runner request id (a UUID) to the harness's own request id, for both
   * approvals and blocking questions.
   */
  requests: Map<string, string>;
  /** The run's `outputs/` folder when it started; `null` until it opened. */
  outputs: OutputSnapshot | null;
  /** Cut by a stop, so sharing a stopped run's files ends at once. */
  outputSharing: AbortController;
  /** Whether the folder was saved before the harness started; `null` until then. */
  checkpoint: DesktopRunnerCheckpointEvent | null;
  /**
   * The folder's kept harness process, taken at the start: the turn
   * continues in it, or it ends first. `null` once the adapter has it.
   */
  live: LiveFolder | null;
  /** The run's `launchKey`, once its harness is about to start. */
  launch: string | null;
};

/** A chat folder's harness process, kept for the chat's next turn. */
type LiveFolder = {
  readonly session: HarnessLiveSession;
  readonly launch: string;
  /** The folder, resolved. */
  readonly workspaceDir: string;
  /** The run whose turn left the work running; counts are reported for it. */
  readonly runId: string;
  /** The process's parked MCP endpoint, on the proxy it was parked on. */
  readonly endpoint: string;
  readonly proxy: McpProxy;
  /** Ends the session once the idle limit passes. */
  readonly idle: ReturnType<typeof setTimeout>;
};

/**
 * Whether the run was asked to stop. A call, not a field read, so a check
 * after an await is not narrowed away by an earlier one.
 */
const isStopped = (run: HeldRun) => run.stop !== RUN_STOP.none;

type Config = { appVersion: string; apiOrigin: string; proxy: McpProxy };

/** Adapters by harness; `null` until the harness has one. */
const ADAPTERS = {
  codex: (launch: HarnessLaunch, options: AdapterOptions) =>
    createCodexHarnessAdapter({
      launch: codexAppServerLaunch(
        launch.executable,
        launch.launch.configOverrides,
      ),
      codexHome: launch.configDir,
      environment: launchEnvironment(options.environment, launch.launch),
      clientVersion: launch.clientVersion,
      gracePeriodMs: HARNESS_GRACE_MS,
      requestTimeoutMs: HARNESS_REQUEST_TIMEOUT_MS,
      startupRequestTimeoutMs: HARNESS_STARTUP_REQUEST_TIMEOUT_MS,
      onBackgroundError: options.onBackgroundError,
      protocolLog: options.protocolLog,
      ...(options.onProcess === null ? {} : { onProcess: options.onProcess }),
      ...(launch.launch.clientName === null
        ? {}
        : { clientName: launch.launch.clientName }),
    }),
  "claude-code": (launch: HarnessLaunch, options: AdapterOptions) => {
    // Claude Code takes no configuration overrides or client name, and
    // nothing on the desktop authorizes its processes.
    if (
      launch.launch.configOverrides.length > 0 ||
      launch.launch.clientName !== null ||
      launch.launch.processGrant
    ) {
      panic("Claude Code adapter: launch settings it cannot apply");
    }
    return createClaudeCodeHarnessAdapter({
      launch: claudeCodeLaunch(launch.executable),
      claudeConfigDir: launch.configDir,
      environment: launchEnvironment(options.environment, launch.launch),
      gracePeriodMs: HARNESS_GRACE_MS,
      requestTimeoutMs: HARNESS_REQUEST_TIMEOUT_MS,
      startupRequestTimeoutMs: HARNESS_STARTUP_REQUEST_TIMEOUT_MS,
      onBackgroundError: options.onBackgroundError,
      protocolLog: options.protocolLog,
      platform: process.platform,
    });
  },
  opencode: null,
} as const satisfies Record<
  AgentHarness,
  ((launch: HarnessLaunch, options: AdapterOptions) => HarnessAdapter) | null
>;

type AdapterOptions = {
  environment: Readonly<Record<string, string>>;
  onBackgroundError: (error: unknown, context: string) => void;
  protocolLog: ProtocolLog;
  /** Waits for the desktop's grant of a new harness process; `null` without one. */
  onProcess: ((pid: number) => Promise<boolean>) | null;
};

const START_FAILURE: Record<
  HarnessStartError["reason"],
  (message: string) => HarnessFailure
> = {
  auth_required: (message) => ({ type: "auth_required", message }),
  harness_unavailable: (message) => ({
    type: "harness_exited",
    message,
    exitCode: null,
    signal: null,
  }),
  invalid_transcript: (message) => ({ type: "protocol_violation", message }),
  protocol_violation: (message) => ({ type: "protocol_violation", message }),
  start_rejected: (message) => ({
    type: "provider_error",
    message,
    code: "start_rejected",
  }),
  sandbox_unavailable: (message) => ({ type: "sandbox_unavailable", message }),
};

type ProbeOutcomeOptions = {
  harness: AgentHarness;
  probe: HarnessProbe;
  /** The desktop release the policy is resolved for. */
  appVersion: string;
};

/**
 * What the runner learns from a probe. A version the bundled compatibility
 * policy refuses is reported as unsupported before anything else, so the
 * desktop never launches, and the server never routes to, a harness this
 * release cannot drive.
 */
const probeOutcome = ({
  harness,
  probe,
  appVersion,
}: ProbeOutcomeOptions): SidecarProbeOutcome => {
  if (!v.is(desktopVersionSchema, probe.version)) {
    return {
      type: "failed",
      reason: "protocol_violation",
      message: "The harness reported a version that is not semantic.",
    };
  }
  const compatibility = resolveHarnessCompatibility({
    manifest: bundledHarnessCompatibility(),
    harness,
    harnessVersion: probe.version,
    desktopVersion: appVersion,
  });
  if (HARNESS_COMPATIBILITY_DISPOSITION[compatibility.status] === "refuse") {
    return {
      type: "unsupported",
      version: probe.version,
      recommendedVersion: compatibility.recommendedVersion,
    };
  }
  if (probe.auth.type === "signed_out") {
    return { type: "needs_login", version: probe.version };
  }
  if (probe.usageLimit !== null) {
    return {
      type: "limit_until",
      version: probe.version,
      resetsAt: probe.usageLimit.resetsAt,
    };
  }
  return {
    type: "ready",
    version: probe.version,
    capabilities: [...probe.capabilities],
    approvalModes: [...probe.approvalModes],
    models: probe.models.slice(0, MAX_PROBED_MODELS).map((model) => ({
      id: model.id,
      label: model.displayName === "" ? model.id : model.displayName,
      isDefault: model.isDefault,
      reasoningEfforts: [...model.reasoningEfforts],
    })),
  };
};

/** The event stream for a run that ends before its harness starts. */
const stoppedBeforeStart = (): AsyncIterable<HarnessEvent> => {
  const queue = createEventQueue<HarnessEvent>();
  queue.push({ type: "turn.interrupted" });
  queue.close();
  return queue.items;
};

const failedBeforeStart = (
  failure: HarnessFailure,
): AsyncIterable<HarnessEvent> => {
  const queue = createEventQueue<HarnessEvent>();
  queue.push({ type: "turn.failed", failure });
  queue.close();
  return queue.items;
};

export class SidecarHost {
  private readonly options: SidecarHostOptions;
  private config: Config | null = null;
  private readonly runs = new Map<string, HeldRun>();
  private readonly finished = new Set<Promise<void>>();
  /** Harness processes waiting for the desktop's grant, by run or probe id. */
  private readonly grants = new Map<string, (granted: boolean) => void>();
  /**
   * Run folders being restored, resolved, with the run whose checkpoint each
   * goes back to and how it ends: no run starts in one meanwhile, and the
   * same restore asked again waits for that one.
   */
  private readonly restoring = new Map<
    string,
    { runId: string; ended: Promise<SidecarRestoreOutcome> }
  >();
  /** Kept harness processes by their chat's folder, resolved. */
  private readonly live = new Map<string, LiveFolder>();
  /** Kept processes being ended, by folder, until each is gone. */
  private readonly endingLive = new Map<string, Promise<void>>();
  private stopping = false;
  private readonly detached: ReturnType<typeof createDetached>;

  constructor(options: SidecarHostOptions) {
    this.options = options;
    this.detached = createDetached((_error, context) => {
      options.log(`background work failed: ${context}`);
    });
  }

  /**
   * Take the connected desktop's version and API origin. The MCP proxy
   * forwards to one origin, so another one is refused while runs use the
   * proxy; with no run held, the proxy restarts on the new origin.
   */
  configure(appVersion: string, apiOrigin: string): boolean {
    const config = this.config;
    if (config?.apiOrigin === apiOrigin) {
      config.appVersion = appVersion;
      return true;
    }
    if (config !== null && this.runs.size > 0) {
      return false;
    }
    if (config !== null) {
      // Kept processes belong to the other origin's chats.
      for (const entry of [...this.live.values()]) {
        this.track(this.endLive(entry));
      }
      this.detached(config.proxy.stop(), "sidecar.proxy.stop");
    }
    this.config = {
      appVersion,
      apiOrigin,
      proxy: startMcpProxy({ apiOrigin }),
    };
    return true;
  }

  /** Whether the run is still going: its `run.finished` is not sent yet. */
  holds(runId: string) {
    return this.runs.has(runId);
  }

  /** How many runs are still going. */
  get running() {
    return this.runs.size;
  }

  /** Report every kept process's background work again, to a new desktop. */
  reportBackground() {
    for (const entry of this.live.values()) {
      this.reportTasks(entry.runId, entry.session.backgroundTasks);
    }
  }

  /** Handle one command; the holder passes them only after `configure`. */
  handle(message: SidecarCommand) {
    const config =
      this.config ?? panic("The holder passed a command before configure");
    switch (message.type) {
      case "harness.probe":
        this.track(this.probe(message, config));
        return;
      case "run.start":
        this.start(message, config);
        return;
      case "run.approval":
        this.withRun(message, (run) => {
          this.respond(run, message.requestId, (requestId) => ({
            type: "approval",
            requestId,
            decision: message.decision,
          }));
        });
        return;
      case "run.answer":
        this.withRun(message, (run) => {
          this.respond(run, message.requestId, (requestId) => ({
            type: "answers",
            requestId,
            answers: message.answers,
          }));
        });
        return;
      case "run.interrupt":
        this.withRun(message, (run) => {
          this.stop(run, RUN_STOP.interrupt);
        });
        return;
      case "run.cancel":
        this.cancel(message.runId);
        return;
      case "harness.process_granted":
        // A grant nobody waits for answers a report sent again on resume.
        this.grants.get(message.id)?.(true);
        return;
      case "folder.restore":
        this.track(this.restoreFolder(message));
        return;
      case "run.token":
        this.withRun(message, () => {
          if (
            !config.proxy.refresh(
              message.runId,
              message.token,
              message.expiresAt,
            )
          ) {
            this.options.log("ignored an MCP token older than the held one");
          }
        });
        return;
      default:
        message satisfies never;
        panic("Unhandled sidecar command");
    }
  }

  /** Cancel a run; its `run.finished` reports `cancelled`. */
  cancel(runId: string) {
    this.withRun({ type: "run.cancel", runId }, (run) => {
      this.stop(run, RUN_STOP.cancel);
    });
  }

  /** A line the host wrote that the holder refused. */
  reject(
    reason: SidecarRejection,
    messageType: string | null,
    runId: string | null,
  ) {
    this.options.log(`rejected a host line: ${reason}`);
    this.options.send({ type: "rejected", reason, messageType, runId });
  }

  /**
   * Stop every run and every kept process, wait for each to finish, and
   * close the proxy.
   */
  async shutdown() {
    this.stopping = true;
    for (const refuse of [...this.grants.values()]) {
      refuse(false);
    }
    for (const run of this.runs.values()) {
      this.stop(run, RUN_STOP.cancel);
    }
    for (const entry of [...this.live.values()]) {
      this.track(this.endLive(entry));
    }
    await Promise.allSettled([...this.finished]);
    await this.config?.proxy.stop();
  }

  private track(work: Promise<void>) {
    const tracked = work.finally(() => {
      this.finished.delete(tracked);
    });
    this.finished.add(tracked);
  }

  private withRun(
    message: { type: string; runId: string },
    act: (run: HeldRun) => void,
  ) {
    const run = this.runs.get(message.runId);
    if (run === undefined) {
      this.reject("unknown_run", message.type, message.runId);
      return;
    }
    act(run);
  }

  /**
   * Report a harness process to the desktop and wait for its grant; `false`
   * once the wait times out or the holder stops.
   */
  private async awaitGrant(id: string, pid: number): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => {
      this.options.log("the desktop did not authorize a harness process");
      settle(false);
    }, this.options.processGrantTimeoutMs);
    const settle = (granted: boolean) => {
      clearTimeout(timer);
      this.grants.delete(id);
      resolve(granted);
    };
    this.grants.set(id, settle);
    // A report the contract cannot carry is never granted: fail at once.
    if (!this.options.send({ type: "harness.process", id, pid })) {
      settle(false);
    }
    return promise;
  }

  /** The adapter for a run or probe; `id` names it in a process grant. */
  private adapter(
    launch: HarnessLaunch,
    id: string,
  ): Result<HarnessAdapter, { message: string }> {
    const create = ADAPTERS[launch.harness];
    if (create === null) {
      return Result.err({ message: "This harness has no local adapter yet." });
    }
    // The adapter panics on options it refuses, such as the user's own home.
    return Result.try({
      try: () =>
        create(launch, {
          environment: this.options.environment,
          onBackgroundError: (_error, context) => {
            this.options.log(`harness background work failed: ${context}`);
          },
          protocolLog: this.options.protocolLog,
          onProcess: launch.launch.processGrant
            ? async (pid) => this.awaitGrant(id, pid)
            : null,
        }),
      catch: () => ({ message: "The harness launch options were refused." }),
    });
  }

  private async probe(
    message: Extract<SidecarHostMessage, { type: "harness.probe" }>,
    config: Config,
  ) {
    const adapter = this.adapter(
      { ...message, clientVersion: config.appVersion },
      message.requestId,
    );
    const outcome: SidecarProbeOutcome = await (async () => {
      if (Result.isError(adapter)) {
        return {
          type: "failed",
          reason: "unsupported",
          message: adapter.error.message,
        } as const;
      }
      const probed = await adapter.value.probe();
      return Result.isOk(probed)
        ? probeOutcome({
            harness: message.harness,
            probe: probed.value,
            appVersion: config.appVersion,
          })
        : ({
            type: "failed",
            reason: probed.error.reason,
            message: probed.error.message,
          } as const);
    })();
    const probed = (reported: SidecarProbeOutcome) =>
      this.options.send({
        type: "harness.probed",
        requestId: message.requestId,
        harness: message.harness,
        outcome: reported,
      });
    // A report the contract cannot carry still answers the probe.
    if (!probed(outcome)) {
      probed({
        type: "failed",
        reason: "protocol_violation",
        message: "The harness reported more than the sidecar can relay.",
      });
    }
  }

  private start(message: SidecarRunStart, config: Config) {
    if (this.runs.has(message.runId)) {
      this.reject("duplicate_run", message.type, message.runId);
      return;
    }
    const run: HeldRun = {
      workspaceDir: path.resolve(message.workspaceDir),
      turn: null,
      // A run that starts while the host stops is cancelled like the held ones.
      stop: this.stopping ? RUN_STOP.cancel : RUN_STOP.none,
      stopCopying: new AbortController(),
      requests: new Map(),
      outputs: null,
      outputSharing: new AbortController(),
      checkpoint: null,
      live: null,
      launch: null,
    };
    // Taken now, so no other start or restore finds it: the run continues
    // in it or ends it before its own harness starts.
    const kept = this.live.get(run.workspaceDir);
    if (kept !== undefined) {
      this.forgetLive(kept);
      run.live = kept;
    }
    this.runs.set(message.runId, run);
    this.track(
      this.execute(message, config, run).finally(() => {
        config.proxy.unregister(message.runId);
        this.runs.delete(message.runId);
      }),
    );
  }

  /**
   * Put a run's folder back as its checkpoint saved it, unless a run uses the
   * folder or a restore to another run's checkpoint does. Both are checked
   * and the folder claimed before the first await, so a `run.start` handled
   * after this one finds the folder taken. The same restore asked again while
   * it runs, as after the desktop's connection dropped, is answered when that
   * one ends; asked after, the run is already undone and answers `restored`.
   * Tracked: the holder does not exit halfway through.
   */
  private async restoreFolder(message: SidecarFolderRestore) {
    const workspaceDir = path.resolve(message.workspaceDir);
    const answer = (outcome: SidecarRestoreOutcome) => {
      this.options.log(`a folder restore ended: ${outcome}`);
      this.options.send({
        type: "folder.restored",
        requestId: message.requestId,
        outcome,
      });
    };
    const going = this.restoring.get(workspaceDir);
    if (going?.runId === message.runId) {
      answer(await going.ended);
      return;
    }
    const busy =
      this.stopping ||
      going !== undefined ||
      [...this.runs.values()].some((run) => run.workspaceDir === workspaceDir);
    if (busy) {
      answer("folder_busy");
      return;
    }
    const ended = (async () => {
      // Undoing the turn ends the work it left running in the folder.
      const kept = this.live.get(workspaceDir);
      if (kept !== undefined) {
        await this.endLive(kept);
      }
      const restored = await restoreCheckpoint({
        workspaceDir,
        runId: message.runId,
        log: this.options.log,
      });
      if (restored.detail !== null) {
        this.options.log(`a folder restore: ${restored.detail}`);
      }
      return restored.outcome;
    })();
    this.restoring.set(workspaceDir, { runId: message.runId, ended });
    try {
      answer(await ended);
    } finally {
      this.restoring.delete(workspaceDir);
    }
  }

  /**
   * Keep the process a completed turn left work running in, for the chat's
   * next turn; registered before the run's `run.finished`, so that turn's
   * start finds it. A launch a later turn cannot continue (one whose process
   * holds a credential grant only for this run), a stopping host or an
   * endpoint that cannot be parked ends it instead.
   */
  private async keepLive({
    message,
    config,
    run,
    session,
  }: {
    message: SidecarRunStart;
    config: Config;
    run: HeldRun;
    session: HarnessLiveSession;
  }) {
    const endpoint =
      this.stopping ||
      run.launch === null ||
      message.launch.processGrant ||
      this.live.has(run.workspaceDir) ||
      // Its work ended meanwhile, and the session with it.
      session.backgroundTasks === 0
        ? null
        : config.proxy.park(message.runId);
    if (endpoint === null) {
      await session.end();
      return;
    }
    const workspaceDir = run.workspaceDir;
    const entry: LiveFolder = {
      session,
      launch: run.launch ?? panic("A kept process without its launch"),
      workspaceDir,
      runId: message.runId,
      endpoint,
      proxy: config.proxy,
      idle: setTimeout(() => {
        this.options.log("ended a chat's background work at the idle limit");
        this.track(this.endLive(entry));
      }, LIVE_SESSION_IDLE_MS),
    };
    this.live.set(workspaceDir, entry);
    this.options.log("kept a harness process for its background work");
    session.watch((count) => {
      if (this.live.get(workspaceDir) !== entry) {
        return;
      }
      if (count > 0) {
        this.reportTasks(entry.runId, count);
        return;
      }
      // The work ended, and the session with it; reported as 0.
      this.forgetLive(entry);
      entry.proxy.drop(entry.endpoint);
    });
    this.reportTasks(entry.runId, session.backgroundTasks);
  }

  /** Take a kept process out of the folder's keeping; reported as 0. */
  private forgetLive(entry: LiveFolder) {
    clearTimeout(entry.idle);
    if (this.live.get(entry.workspaceDir) === entry) {
      this.live.delete(entry.workspaceDir);
      this.reportTasks(entry.runId, 0);
    }
  }

  /**
   * End a kept process and the work it holds. Until it is gone, a run in its
   * folder waits (`open`), so no new harness writes there beside it.
   */
  private async endLive(entry: LiveFolder) {
    this.forgetLive(entry);
    const ending = (async () => {
      await entry.session.end();
      entry.proxy.drop(entry.endpoint);
    })();
    this.endingLive.set(entry.workspaceDir, ending);
    try {
      await ending;
    } finally {
      if (this.endingLive.get(entry.workspaceDir) === ending) {
        this.endingLive.delete(entry.workspaceDir);
      }
    }
  }

  private reportTasks(runId: string, count: number) {
    this.options.send({
      type: "background.tasks",
      runId,
      count: Math.min(count, SIDECAR_MAX_BACKGROUND_TASKS),
    });
  }

  private stop(run: HeldRun, reason: RunStop) {
    run.stop =
      run.stop === RUN_STOP.cancel || reason === RUN_STOP.cancel
        ? RUN_STOP.cancel
        : RUN_STOP.interrupt;
    run.stopCopying.abort();
    run.outputSharing.abort();
    if (run.turn !== null) {
      this.detached(run.turn.interrupt(), "sidecar.interrupt");
    }
  }

  /**
   * Hand an approval decision or question answers to the harness. The answer
   * itself is never logged: it may hold a secret the question asked for.
   */
  private respond(
    run: HeldRun,
    requestId: string,
    response: (nativeId: string) => HarnessInteractionResponse,
  ) {
    const native = run.requests.get(requestId);
    if (native === undefined || run.turn === null) {
      this.options.log("a response named a request the run does not hold");
      return;
    }
    const turn = run.turn;
    const answer = async () => {
      const answered = await turn.respond(response(native));
      if (Result.isError(answered)) {
        this.options.log(
          `the harness refused a response: ${answered.error.reason}`,
        );
      }
    };
    this.detached(answer(), "sidecar.respond");
  }

  /** Open the turn, or the reason it could not open as a failure event. */
  private async open(
    message: SidecarRunStart,
    config: Config,
    run: HeldRun,
  ): Promise<Result<HarnessTurn, HarnessFailure>> {
    if (this.restoring.has(run.workspaceDir)) {
      this.options.log("refused a run whose folder is being restored");
      return Result.err({
        type: "harness_exited",
        message: "The chat's folder is being restored on this computer.",
        exitCode: null,
        signal: null,
      });
    }
    // The wire checks each message's role only, as the runner socket does;
    // the turn reads more, so the rest is checked before anything starts.
    const transcript = v.safeParse(harnessTranscriptSchema, message.messages);
    if (!transcript.success) {
      this.options.log("refused a run whose transcript cannot be read");
      return Result.err({
        type: "protocol_violation",
        message: "The run's transcript has a message stella cannot read.",
      });
    }
    // A kept process of this folder still ending (another origin's, the idle
    // limit's) goes first: no new harness writes there beside it.
    await this.endingLive.get(run.workspaceDir);
    const declared = await readSkillFolderNetworkHosts(message.skillFolders);
    for (const skill of declared.unreadable) {
      this.options.log(
        `a skill's network hosts could not be read and add none: ${skill}`,
      );
    }
    run.launch = launchKey(message, declared.hosts);
    const live = run.live;
    if (
      live !== null &&
      !(
        live.session.harness === message.harness &&
        live.launch === run.launch &&
        live.session.sessionId === message.harnessSessionId &&
        live.proxy === config.proxy
      )
    ) {
      // Another session or launch: the work the kept process holds is not
      // this turn's to see, so it ends before this turn's harness starts.
      run.live = null;
      this.options.log("ended a chat's kept harness process for a new launch");
      await this.endLive(live);
    }
    const endpoint = {
      runId: message.runId,
      serverName: message.mcp.serverName,
      upstreamUrl: message.mcp.url,
      token: message.mcp.token,
      expiresAt: message.mcp.expiresAt,
    };
    const binding =
      run.live === null
        ? config.proxy.register(endpoint)
        : config.proxy.adopt(run.live.endpoint, endpoint);
    if (Result.isError(binding)) {
      this.options.log(`refused a run's MCP endpoint: ${binding.error.reason}`);
      return Result.err({
        type: "protocol_violation",
        message: binding.error.message,
      });
    }
    const adapter = this.adapter(
      { ...message, clientVersion: config.appVersion },
      message.runId,
    );
    if (Result.isError(adapter)) {
      return Result.err({
        type: "harness_exited",
        message: adapter.error.message,
        exitCode: null,
        signal: null,
      });
    }
    const copied = await copyAttachments(
      message.attachments,
      message.workspaceDir,
      { signal: run.stopCopying.signal },
    );
    if (run.stop !== RUN_STOP.none) {
      // Stopped during the copy: no harness starts for a run nobody wants now.
      return Result.err({
        type: "harness_exited",
        message: "The run was stopped before it started.",
        exitCode: null,
        signal: null,
      });
    }
    if (Result.isError(copied)) {
      this.options.log(`a run's attachment failed: ${copied.error.message}`);
      return Result.err({
        type: "harness_exited",
        message: "An attached file could not be copied to this computer.",
        exitCode: null,
        signal: null,
      });
    }
    // After the copies and before the harness: the folder as the member left
    // it, attachments included, so the turn's changes can be undone.
    run.checkpoint = await captureCheckpoint({
      workspaceDir: run.workspaceDir,
      runId: message.runId,
      memberFiles: copied.value,
      protectedPaths: [
        message.configDir,
        message.cacheDir,
        ...message.skillFolders.map((folder) => folder.path),
      ],
      signal: run.stopCopying.signal,
      log: this.options.log,
    });
    if (run.checkpoint.status === "unavailable") {
      this.options.log(
        `a run's folder was not saved: ${run.checkpoint.reason}`,
      );
    }
    // The capture can take a while: a stop during it ends the run here.
    if (isStopped(run)) {
      return Result.err({
        type: "harness_exited",
        message: "The run was stopped before it started.",
        exitCode: null,
        signal: null,
      });
    }
    // Read after the copies and before the harness: what is there now was not
    // written by this turn.
    run.outputs = await snapshotOutputs(message.workspaceDir);
    // From the copies just made: a file is never fetched twice.
    const input = await readInputFiles({
      attachments: message.attachments,
      workspaceDir: message.workspaceDir,
      request: transcript.output.at(-1),
      accepts: adapter.value.inputFileTypes,
    });
    for (const reason of input.skipped) {
      this.options.log(`an attached file stays a path only: ${reason}`);
    }
    // A stop during the reads above ends the run here, before any harness
    // turn; a kept process stays on the run for `execute` to end.
    if (isStopped(run)) {
      return Result.err({
        type: "harness_exited",
        message: "The run was stopped before it started.",
        exitCode: null,
        signal: null,
      });
    }
    // From here the adapter owns the kept process: it continues the turn in
    // it, or ends it.
    const taken = run.live;
    run.live = null;
    const started = await adapter.value.startTurn({
      runId: message.runId,
      threadId: message.threadId,
      workspaceDir: message.workspaceDir,
      cacheDir: message.cacheDir,
      skillFolders: message.skillFolders,
      networkHosts: declared.hosts,
      toolPath: message.toolPath,
      model: message.model,
      reasoningEffort: message.reasoningEffort,
      instructions: message.instructions,
      policy: message.policy,
      mcp: binding.value,
      transcript: transcript.output,
      inputFiles: input.files,
      continuation: continuationOf(message, taken),
    });
    return Result.isOk(started)
      ? Result.ok(started.value)
      : Result.err(START_FAILURE[started.error.reason](started.error.message));
  }

  private async execute(
    message: SidecarRunStart,
    config: Config,
    run: HeldRun,
  ) {
    const opened = await this.open(message, config, run);
    // A run that ended before its harness started does not continue in the
    // folder's kept process, so that process ends: a stop ends everything.
    const untaken = run.live;
    if (untaken !== null) {
      run.live = null;
      await this.endLive(untaken);
    }
    const outcome: { value: RunOutcome; sessionId: string | null } = {
      value: "failed",
      sessionId: null,
    };
    const runId = message.runId;
    /**
     * Set once one of the run's messages could not be written. The desktop
     * would miss part of the run, so the run stops, writes nothing more and
     * finishes `failed`.
     */
    const delivery = { broken: false };
    const send = (runMessage: SidecarHostOutput) => {
      if (delivery.broken || this.options.send(runMessage)) {
        return;
      }
      delivery.broken = true;
      this.options.log(
        `a run's ${runMessage.type} message could not be written; stopping the run`,
      );
      this.stop(run, RUN_STOP.interrupt);
    };
    const relabel = (nativeId: string) => {
      const requestId = crypto.randomUUID();
      run.requests.set(requestId, nativeId);
      return requestId;
    };
    const runnerIdOf = (nativeId: string) => {
      for (const [requestId, native] of run.requests) {
        if (native === nativeId) {
          return requestId;
        }
      }
      return nativeId;
    };

    /**
     * Hand the member what the turn wrote to its `outputs/` folder, reported
     * ahead of the finish that ends the chat turn. A failure stays with the
     * files it concerns: the run has done its work whatever happens here.
     */
    const shareRunOutputs = async () => {
      if (run.outputs === null) {
        return;
      }
      const reports = shareOutputs({
        workspaceDir: message.workspaceDir,
        before: run.outputs,
        upload: runOutputUploader({
          apiOrigin: config.apiOrigin,
          runId,
          token: () => config.proxy.tokenOf(runId),
        }),
        signal: run.outputSharing.signal,
      });
      const shared = await Result.tryPromise(async () => {
        for await (const report of reports) {
          const timestamp = Temporal.Now.instant().epochMilliseconds;
          send({
            type: "run.event",
            runId,
            chunk: { ...outputReportChunk(report, timestamp) },
          });
        }
      });
      if (Result.isError(shared)) {
        this.options.log("sharing a run's output files stopped early");
      }
    };

    /**
     * The adapter's events with harness request ids replaced by runner UUIDs.
     * An approval request is announced after the chunks of its event: the
     * mapper asks for the next event only once those are written.
     *
     * @yields Each adapter event, relabelled where it names a request.
     */
    async function* relayed(
      events: AsyncIterable<HarnessEvent>,
    ): AsyncGenerator<HarnessEvent> {
      for await (const event of events) {
        switch (event.type) {
          case "session.started":
            outcome.sessionId = event.sessionId;
            yield event;
            break;
          case "approval.requested": {
            const requestId = relabel(event.request.requestId);
            yield { ...event, request: { ...event.request, requestId } };
            send({
              type: "run.approval_request",
              runId,
              requestId,
              kind: event.request.kind,
              summary: approvalMessage(event.request),
            });
            break;
          }
          case "question.requested": {
            const requestId = relabel(event.request.requestId);
            yield { ...event, request: { ...event.request, requestId } };
            break;
          }
          case "interaction.resolved":
            yield { ...event, requestId: runnerIdOf(event.requestId) };
            break;
          case "turn.completed":
            outcome.value = "completed";
            await shareRunOutputs();
            yield event;
            break;
          case "turn.interrupted":
            outcome.value =
              run.stop === RUN_STOP.cancel ? "cancelled" : "interrupted";
            yield event;
            break;
          case "turn.failed":
            outcome.value = HARNESS_FAILURE_OUTCOME[event.failure.type];
            yield event;
            break;
          case "text.delta":
          case "text.completed":
          case "reasoning.completed":
          case "tool.started":
          case "tool.completed":
          case "retrying":
            yield event;
            break;
          default:
            event satisfies never;
            panic("Unhandled harness event");
        }
      }
    }

    let events: AsyncIterable<HarnessEvent>;
    if (Result.isOk(opened)) {
      run.turn = opened.value;
      if (run.stop !== RUN_STOP.none) {
        this.detached(opened.value.interrupt(), "sidecar.interrupt");
      }
      events = opened.value.events;
    } else if (run.stop !== RUN_STOP.none) {
      events = stoppedBeforeStart();
    } else {
      events = failedBeforeStart(opened.error);
    }
    const chunks = harnessEventsToChunks(relayed(events), {
      harness: message.harness,
      model: message.model,
      runId,
      threadId: message.threadId,
      workspaceDir: message.workspaceDir,
      generateId: () => crypto.randomUUID(),
      now: () => Temporal.Now.instant().epochMilliseconds,
    });
    // Streamed deltas merge before they are sent: each run event is one
    // stored message, and a run may store only so many.
    const coalescer = createChunkCoalescer({
      emit: (chunk) => {
        // A plain copy: TanStack declares chunks as interfaces, which carry
        // no index signature.
        send({ type: "run.event", runId, chunk: { ...chunk } });
      },
      schedule: scheduleTimeout,
    });
    for await (const chunk of chunks) {
      coalescer.push(chunk);
      // Once, right after the run's start: whether its changes can be undone.
      if (chunk.type === EventType.RUN_STARTED && run.checkpoint !== null) {
        coalescer.push(
          checkpointChunk(
            run.checkpoint,
            Temporal.Now.instant().epochMilliseconds,
          ),
        );
        run.checkpoint = null;
      }
    }
    coalescer.flush();
    const kept = (await run.turn?.release()) ?? null;
    if (kept !== null && (delivery.broken || isStopped(run))) {
      // The run fails, or was stopped after its turn completed (while its
      // files were shared, say): nothing it started stays behind.
      await kept.end();
    } else if (kept !== null) {
      await this.keepLive({ message, config, run, session: kept });
    }
    const finished = {
      type: "run.finished",
      runId,
      outcome: delivery.broken ? "failed" : outcome.value,
      harnessSessionId: outcome.sessionId,
    } as const;
    // Every accepted run ends with one `run.finished`: a native session id
    // the contract cannot carry fails the run instead of losing its end.
    if (!this.options.send(finished)) {
      this.options.send({
        ...finished,
        outcome: "failed",
        harnessSessionId: null,
      });
    }
  }
}
