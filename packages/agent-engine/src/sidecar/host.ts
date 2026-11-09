import { panic, Result } from "better-result";
import { Temporal } from "temporal-polyfill/full";
import * as v from "valibot";

import type { AgentHarness } from "@stll/api-contract/agent-harness";
import { desktopVersionSchema } from "@stll/api-contract/desktop-presence";
import type { DESKTOP_RUNNER_RUN_OUTCOMES } from "@stll/api-contract/desktop-runner";
import { createDetached } from "@stll/errors";

import type {
  HarnessAdapter,
  HarnessInteractionResponse,
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
import { harnessEventsToChunks } from "../harness/stream-chunks";
import { harnessTranscriptSchema } from "../harness/transcript-handoff";
import { copyAttachments } from "./attachments";
import { readInputFiles } from "./input-files";
import { type McpProxy, startMcpProxy } from "./mcp-proxy";
import {
  outputReportChunk,
  type OutputSnapshot,
  runOutputUploader,
  shareOutputs,
  snapshotOutputs,
} from "./outputs";
import type {
  SidecarHarnessLaunchSettings,
  SidecarHostMessage,
  SidecarHostOutput,
  SidecarProbeOutcome,
  SidecarRejection,
  SidecarRunStart,
} from "./protocol";

/**
 * The sidecar's command loop: any number of concurrent runs, one harness
 * process per run. Every accepted `run.start` ends with exactly one
 * `run.finished`, also when the harness never started, so the host's run
 * bookkeeping needs no second failure path. The holder (`holder.ts`) owns the
 * connection, the handshake and the numbering of what this loop sends.
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
const MAX_SUMMARY_CHARS = 4000;
const MAX_PROBED_MODELS = 100;

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
};

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
      onBackgroundError: options.onBackgroundError,
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
      onBackgroundError: options.onBackgroundError,
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

  /** Stop every run, wait for each to finish, and close the proxy. */
  async shutdown() {
    this.stopping = true;
    for (const refuse of [...this.grants.values()]) {
      refuse(false);
    }
    for (const run of this.runs.values()) {
      this.stop(run, RUN_STOP.cancel);
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
      turn: null,
      // A run that starts while the host stops is cancelled like the held ones.
      stop: this.stopping ? RUN_STOP.cancel : RUN_STOP.none,
      stopCopying: new AbortController(),
      requests: new Map(),
      outputs: null,
      outputSharing: new AbortController(),
    };
    this.runs.set(message.runId, run);
    this.track(
      this.execute(message, config, run).finally(() => {
        config.proxy.unregister(message.runId);
        this.runs.delete(message.runId);
      }),
    );
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
    const binding = config.proxy.register({
      runId: message.runId,
      serverName: message.mcp.serverName,
      upstreamUrl: message.mcp.url,
      token: message.mcp.token,
      expiresAt: message.mcp.expiresAt,
    });
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
    const started = await adapter.value.startTurn({
      runId: message.runId,
      threadId: message.threadId,
      workspaceDir: message.workspaceDir,
      cacheDir: message.cacheDir,
      skillFolders: message.skillFolders,
      toolPath: message.toolPath,
      model: message.model,
      instructions: message.instructions,
      policy: message.policy,
      mcp: binding.value,
      transcript: transcript.output,
      inputFiles: input.files,
      continuation:
        message.harnessSessionId === null
          ? { type: "fresh" }
          : {
              type: "resume",
              sessionId: harnessSessionId(message.harnessSessionId),
            },
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
              summary: approvalMessage(event.request).slice(
                0,
                MAX_SUMMARY_CHARS,
              ),
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
    }
    coalescer.flush();
    await run.turn?.dispose();
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
