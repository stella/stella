import type { ModelMessage } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { Temporal } from "temporal-polyfill/full";
import * as v from "valibot";

import type { AgentHarness } from "@stll/api-contract/agent-harness";
import { desktopVersionSchema } from "@stll/api-contract/desktop-presence";
import type { DESKTOP_RUNNER_RUN_OUTCOMES } from "@stll/api-contract/desktop-runner";
import { createDetached } from "@stll/errors";

import type {
  HarnessAdapter,
  HarnessProbe,
  HarnessStartError,
  HarnessTurn,
} from "../harness/adapter";
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
  HARNESS_FAILURE_OUTCOME,
  type HarnessEvent,
  type HarnessFailure,
  harnessSessionId,
} from "../harness/events";
import { harnessEventsToChunks } from "../harness/stream-chunks";
import { type McpProxy, startMcpProxy } from "./mcp-proxy";
import type {
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
const MAX_SUMMARY_CHARS = 4000;
const MAX_PROBED_MODELS = 100;

export type HarnessLaunch = {
  harness: AgentHarness;
  executable: string;
  configDir: string;
  clientVersion: string;
};

export type SidecarHostOptions = {
  /** Hands one message to the holder. */
  send: (message: SidecarHostOutput) => void;
  /** One line in the holder's log. Never passed tokens, prompts or outputs. */
  log: (line: string) => void;
  /** The harness's environment; `CODEX_HOME` and the like are set per run. */
  environment: Readonly<Record<string, string>>;
};

type HeldRun = {
  turn: HarnessTurn | null;
  cancelled: boolean;
  /** Set by `run.interrupt` or `run.cancel` before the turn started. */
  stopRequested: boolean;
  /** Runner request id (a UUID) to the harness's own request id. */
  approvals: Map<string, string>;
};

type Config = { appVersion: string; apiOrigin: string; proxy: McpProxy };

/** Adapters by harness; `null` until the harness has one. */
const ADAPTERS = {
  codex: (launch: HarnessLaunch, options: AdapterOptions) =>
    createCodexHarnessAdapter({
      launch: codexAppServerLaunch(launch.executable),
      codexHome: launch.configDir,
      environment: options.environment,
      clientVersion: launch.clientVersion,
      gracePeriodMs: HARNESS_GRACE_MS,
      onBackgroundError: options.onBackgroundError,
    }),
  "claude-code": null,
  opencode: null,
} as const satisfies Record<
  AgentHarness,
  ((launch: HarnessLaunch, options: AdapterOptions) => HarnessAdapter) | null
>;

type AdapterOptions = {
  environment: Readonly<Record<string, string>>;
  onBackgroundError: (error: unknown, context: string) => void;
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
};

const summaryOf = (reason: string | null, toolName: string) =>
  (reason ?? `Approval required to run ${toolName}`).slice(
    0,
    MAX_SUMMARY_CHARS,
  );

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
  return {
    type: "ready",
    version: probe.version,
    capabilities: [...probe.capabilities],
    models: probe.models.slice(0, MAX_PROBED_MODELS).map((model) => ({
      id: model.id,
      label: model.displayName === "" ? model.id : model.displayName,
      isDefault: model.isDefault,
    })),
  };
};

/** The event stream for a run that ends before its harness starts. */
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
          this.approve(run, message.requestId, message.decision);
        });
        return;
      case "run.interrupt":
        this.withRun(message, (run) => {
          this.stop(run);
        });
        return;
      case "run.cancel":
        this.cancel(message.runId);
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
      run.cancelled = true;
      this.stop(run);
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
    for (const run of this.runs.values()) {
      run.cancelled = true;
      this.stop(run);
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

  private adapter(
    launch: HarnessLaunch,
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
        }),
      catch: () => ({ message: "The harness launch options were refused." }),
    });
  }

  private async probe(
    message: Extract<SidecarHostMessage, { type: "harness.probe" }>,
    config: Config,
  ) {
    const adapter = this.adapter({
      ...message,
      clientVersion: config.appVersion,
    });
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
    this.options.send({
      type: "harness.probed",
      requestId: message.requestId,
      harness: message.harness,
      outcome,
    });
  }

  private start(message: SidecarRunStart, config: Config) {
    if (this.runs.has(message.runId)) {
      this.reject("duplicate_run", message.type, message.runId);
      return;
    }
    const run: HeldRun = {
      turn: null,
      cancelled: false,
      stopRequested: this.stopping,
      approvals: new Map(),
    };
    this.runs.set(message.runId, run);
    this.track(
      this.execute(message, config, run).finally(() => {
        config.proxy.unregister(message.runId);
        this.runs.delete(message.runId);
      }),
    );
  }

  private stop(run: HeldRun) {
    run.stopRequested = true;
    if (run.turn !== null) {
      this.detached(run.turn.interrupt(), "sidecar.interrupt");
    }
  }

  private approve(
    run: HeldRun,
    requestId: string,
    decision: "approve" | "approve_for_session" | "deny",
  ) {
    const native = run.approvals.get(requestId);
    if (native === undefined || run.turn === null) {
      this.options.log("an approval named a request the run does not hold");
      return;
    }
    const turn = run.turn;
    const answer = async () => {
      const answered = await turn.respond({
        type: "approval",
        requestId: native,
        decision,
      });
      if (Result.isError(answered)) {
        this.options.log(
          `the harness refused an approval: ${answered.error.reason}`,
        );
      }
    };
    this.detached(answer(), "sidecar.approval");
  }

  /** Open the turn, or the reason it could not open as a failure event. */
  private async open(
    message: SidecarRunStart,
    config: Config,
  ): Promise<Result<HarnessTurn, HarnessFailure>> {
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
    const adapter = this.adapter({
      ...message,
      clientVersion: config.appVersion,
    });
    if (Result.isError(adapter)) {
      return Result.err({
        type: "harness_exited",
        message: adapter.error.message,
        exitCode: null,
        signal: null,
      });
    }
    const started = await adapter.value.startTurn({
      runId: message.runId,
      threadId: message.threadId,
      workspaceDir: message.workspaceDir,
      model: message.model,
      instructions: message.instructions,
      policy: message.policy,
      mcp: binding.value,
      // SAFETY: the wire checks each message's role only, as the runner
      // socket does; `buildTurnPrompt` reads the content and refuses a
      // transcript it cannot read as `invalid_transcript`.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY above
      transcript: message.messages as unknown as ModelMessage[],
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
    const opened = await this.open(message, config);
    const outcome: { value: RunOutcome; sessionId: string | null } = {
      value: "failed",
      sessionId: null,
    };
    const send = this.options.send;
    const runId = message.runId;
    const relabel = (nativeId: string) => {
      const requestId = crypto.randomUUID();
      run.approvals.set(requestId, nativeId);
      return requestId;
    };
    const runnerIdOf = (nativeId: string) => {
      for (const [requestId, native] of run.approvals) {
        if (native === nativeId) {
          return requestId;
        }
      }
      return nativeId;
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
              summary: summaryOf(
                event.request.reason,
                event.request.toolCall.name,
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
            yield event;
            break;
          case "turn.interrupted":
            outcome.value = run.cancelled ? "cancelled" : "interrupted";
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
      if (run.stopRequested) {
        this.detached(opened.value.interrupt(), "sidecar.interrupt");
      }
      events = opened.value.events;
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
    for await (const chunk of chunks) {
      // A plain copy: TanStack declares chunks as interfaces, which carry
      // no index signature.
      send({ type: "run.event", runId, chunk: { ...chunk } });
    }
    await run.turn?.dispose();
    send({
      type: "run.finished",
      runId,
      outcome: outcome.value,
      harnessSessionId: outcome.sessionId,
    });
  }
}
