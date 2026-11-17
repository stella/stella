import { Result } from "better-result";

import {
  type HarnessInteractionResponse,
  type HarnessLiveSession,
  HarnessRespondError,
  HarnessSteerError,
  type HarnessSteerInput,
  type HarnessTurn,
} from "./adapter";
import { createEventQueue } from "./event-queue";
import type { HarnessEvent } from "./events";

/** Fire-and-forget work whose rejection goes to the caller's error sink. */
export type Detached = (
  operation: unknown,
  context: `${string}.${string}`,
) => void;

/** How a harness process ended. */
export type HarnessExit = { exitCode: number | null; signal: string | null };

/** What a turn needs of the harness process that hosts it to stop it. */
type HarnessTurnProcess = {
  /** Settles when the process has exited, however that happened. */
  readonly exited: Promise<HarnessExit>;
  closeInput: () => void;
  kill: () => Promise<HarnessExit>;
};

/**
 * What a harness process runs in the background, for a turn's end. `keep` is
 * asked once the turn completed: the process as a live session when work its
 * agent started still runs, `null` to end it. `stopBackground` ends that work
 * through the harness's own protocol before the process is closed.
 */
export type HarnessTurnBackground<TClient> = {
  keep: (client: TClient) => Promise<HarnessLiveSession | null>;
  stopBackground: (client: TClient) => Promise<void>;
};

/**
 * End the harness's background tasks within `ms`. A stop that fails or
 * outlasts it lets the rest of the ending go on: the process closes and its
 * tree ends either way.
 */
export const stopBackgroundWithin = async (
  stop: () => Promise<void>,
  ms: number,
) => {
  await settlesWithin(Result.tryPromise(stop), ms);
};

/** Whether `promise` settles within `ms`. */
export const settlesWithin = async (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true), Bun.sleep(ms).then(() => false)]);

export const respondError = (
  reason: HarnessRespondError["reason"],
  message: string,
) => Result.err(new HarnessRespondError({ reason, message }));

/**
 * How long a turn waits after the harness says it is retrying the provider,
 * with nothing else happening, before it ends as stalled. Long, so a slow
 * provider that recovers is never cut off.
 */
const RETRY_STALL_MS = 10 * 60_000;

const isTerminal = (event: HarnessEvent) =>
  event.type === "turn.completed" ||
  event.type === "turn.interrupted" ||
  event.type === "turn.failed";

/**
 * The part of a harness turn that does not depend on the harness's protocol:
 * the event stream, the single terminal event that closes it, and the stop
 * sequence. The terminal event also ends the process: the harness's
 * background tasks first, then a clean exit (its session is saved), killed
 * after the grace period. A completed turn whose agent left work running in
 * the background keeps the process instead, when the adapter says so, for
 * the chat's next turn (`HarnessLiveSession`).
 */
export class HarnessTurnLifecycle<TClient extends HarnessTurnProcess> {
  private readonly queue = createEventQueue<HarnessEvent>();
  private readonly terminal = Promise.withResolvers<undefined>();
  private hasEnded = false;
  private isInterrupting = false;
  private attached: TClient | null = null;
  /** Every input the turn was steered with. */
  private readonly inputs = new Set<string>();
  /** Inputs whose `input.settled` is not out yet. */
  private readonly unsettled = new Set<string>();
  /** Armed by a retry; any other event before it fires is progress. */
  private retryStall: ReturnType<typeof setTimeout> | null = null;
  /** How the terminal event left the process: kept, or ended (`null`). */
  private settled: Promise<HarnessLiveSession | null> | null = null;
  /** A kept process was handed to `release`'s caller. */
  private handedOver = false;

  readonly gracePeriodMs: number;
  private readonly retryStallMs: number;
  private readonly detached: Detached;
  private readonly shutdownContext: `${string}.shutdown`;
  private readonly background: HarnessTurnBackground<TClient> | null;

  constructor(options: {
    gracePeriodMs: number;
    detached: Detached;
    /** Names the turn's shutdown in a detached failure, e.g. `codex-turn`. */
    name: string;
    /** See `RETRY_STALL_MS`. */
    retryStallMs?: number;
    /** What the harness runs in the background; nothing when unset. */
    background?: HarnessTurnBackground<TClient>;
  }) {
    this.gracePeriodMs = options.gracePeriodMs;
    this.retryStallMs = options.retryStallMs ?? RETRY_STALL_MS;
    this.detached = options.detached;
    this.shutdownContext = `${options.name}.shutdown`;
    this.background = options.background ?? null;
  }

  /** The harness process, once it is attached. */
  get client(): TClient | null {
    return this.attached;
  }

  /** The terminal event was emitted, or the turn never started. */
  get ended(): boolean {
    return this.hasEnded;
  }

  /** The user stopped the turn; whatever the harness reports next ends it. */
  get interrupting(): boolean {
    return this.isInterrupting;
  }

  attach(client: TClient) {
    this.attached = client;
  }

  /** The turn never started; nothing more is emitted. */
  abandon() {
    this.hasEnded = true;
    this.queue.close();
  }

  turn(session: {
    respond: (
      response: HarnessInteractionResponse,
    ) => Result<void, HarnessRespondError>;
    /**
     * Hand the running turn the message. Called once per input, before the
     * terminal event; the session settles it through `settleInput`, and the
     * terminal event settles it `rejected` if the session has not.
     */
    steer: (input: HarnessSteerInput) => void;
    interrupt: () => Promise<void>;
  }): HarnessTurn {
    return {
      events: this.queue.items,
      respond: async (response) =>
        await Promise.resolve(session.respond(response)),
      steer: async (input) =>
        await Promise.resolve(this.steer(input, session.steer)),
      interrupt: async () => session.interrupt(),
      release: async () => this.release(),
      dispose: async () => this.dispose(),
    };
  }

  private steer(
    input: HarnessSteerInput,
    hand: (input: HarnessSteerInput) => void,
  ): Result<void, HarnessSteerError> {
    if (this.hasEnded) {
      return Result.err(
        new HarnessSteerError({
          reason: "turn_ended",
          message: "The turn has already ended.",
        }),
      );
    }
    // An input handed over again (a desktop that restarted before it
    // recorded the first) keeps the one outcome it has or will have.
    if (this.inputs.has(input.inputId)) {
      return Result.ok();
    }
    this.inputs.add(input.inputId);
    this.unsettled.add(input.inputId);
    // A stop is on its way: whatever the harness does next ends the turn.
    if (this.isInterrupting) {
      this.settleInput(input.inputId, "rejected");
      return Result.ok();
    }
    hand(input);
    return Result.ok();
  }

  /**
   * Report what became of a steering message, once; a later report for the
   * same input, or one for an input never handed over, is dropped.
   */
  settleInput(inputId: string, status: "accepted" | "rejected") {
    if (this.hasEnded || !this.unsettled.delete(inputId)) {
      return;
    }
    this.queue.push({ type: "input.settled", inputId, status });
  }

  emit(event: HarnessEvent) {
    if (this.hasEnded) {
      return;
    }
    if (isTerminal(event)) {
      // Every input the turn was handed is settled before the turn ends.
      for (const inputId of [...this.unsettled]) {
        this.settleInput(inputId, "rejected");
      }
    }
    this.watchRetries(event);
    this.queue.push(event);
    if (isTerminal(event)) {
      this.hasEnded = true;
      this.queue.close();
      this.terminal.resolve(undefined);
      const settled = this.settle(event);
      this.settled = settled;
      this.detached(settled, this.shutdownContext);
    }
  }

  /**
   * Keep the process when the turn completed with work still running in the
   * background and the adapter keeps it; end it otherwise.
   */
  private async settle(
    event: HarnessEvent,
  ): Promise<HarnessLiveSession | null> {
    const client = this.attached;
    if (client === null) {
      return null;
    }
    const background = this.background;
    if (
      background !== null &&
      event.type === "turn.completed" &&
      !this.isInterrupting
    ) {
      // A keep that fails leaves nothing kept: the process ends as usual.
      const kept = await Result.tryPromise(async () => background.keep(client));
      if (Result.isOk(kept) && kept.value !== null) {
        return kept.value;
      }
    }
    await this.shutdown();
    return null;
  }

  /**
   * A retry with nothing after it for `retryStallMs` ends the turn as
   * stalled; anything else the harness does in between is progress.
   */
  private watchRetries(event: HarnessEvent) {
    if (event.type === "retrying") {
      this.retryStall ??= setTimeout(() => {
        this.retryStall = null;
        this.emit({
          type: "turn.failed",
          failure: {
            type: "retry_stalled",
            message: "The harness kept retrying the provider without progress.",
          },
        });
      }, this.retryStallMs);
      return;
    }
    if (this.retryStall !== null) {
      clearTimeout(this.retryStall);
      this.retryStall = null;
    }
  }

  violation(message: string) {
    this.emit({
      type: "turn.failed",
      failure: { type: "protocol_violation", message },
    });
  }

  exited({ exitCode, signal }: HarnessExit) {
    if (this.isInterrupting) {
      this.emit({ type: "turn.interrupted" });
      return;
    }
    this.emit({
      type: "turn.failed",
      failure: {
        type: "harness_exited",
        message: "The harness stopped before the turn finished.",
        exitCode,
        signal,
      },
    });
  }

  /**
   * Ask the harness to stop the turn through `request`, which reports whether
   * the harness accepted the request. A refused or unconfirmed interrupt ends
   * the turn here; the shutdown that follows the terminal event kills the
   * harness.
   */
  async interrupt(request: (client: TClient) => Promise<boolean>) {
    const client = this.attached;
    if (this.hasEnded || this.isInterrupting || client === null) {
      return;
    }
    this.isInterrupting = true;
    if (
      !(await request(client)) ||
      !(await settlesWithin(this.terminal.promise, this.gracePeriodMs))
    ) {
      this.emit({ type: "turn.interrupted" });
    }
  }

  /** How the turn left the process; a turn still going is interrupted. */
  private async settledProcess() {
    if (!this.hasEnded) {
      this.isInterrupting = true;
      this.emit({ type: "turn.interrupted" });
    }
    return (await this.settled) ?? null;
  }

  private async release() {
    const kept = await this.settledProcess();
    if (kept === null || this.handedOver) {
      return null;
    }
    this.handedOver = true;
    return kept;
  }

  private async dispose() {
    const kept = await this.settledProcess();
    if (kept !== null && !this.handedOver) {
      this.handedOver = true;
      await kept.end();
    }
  }

  /**
   * End the harness's background tasks, then ask the process to exit cleanly
   * so its session is saved, then kill it.
   */
  private async shutdown() {
    const client = this.attached;
    if (client === null) {
      return;
    }
    const background = this.background;
    if (background !== null) {
      await stopBackgroundWithin(
        async () => background.stopBackground(client),
        this.gracePeriodMs,
      );
    }
    client.closeInput();
    if (!(await settlesWithin(client.exited, this.gracePeriodMs))) {
      await client.kill();
    }
  }
}
