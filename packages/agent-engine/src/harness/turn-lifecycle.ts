import { Result } from "better-result";

import {
  type HarnessInteractionResponse,
  HarnessRespondError,
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
export const RETRY_STALL_MS = 10 * 60_000;

const isTerminal = (event: HarnessEvent) =>
  event.type === "turn.completed" ||
  event.type === "turn.interrupted" ||
  event.type === "turn.failed";

/**
 * The part of a harness turn that does not depend on the harness's protocol:
 * the event stream, the single terminal event that closes it, and the stop
 * sequence. A process hosts exactly one turn, so the terminal event also asks
 * the process to exit cleanly (its session is saved) and kills it after the
 * grace period.
 */
export class HarnessTurnLifecycle<TClient extends HarnessTurnProcess> {
  private readonly queue = createEventQueue<HarnessEvent>();
  private readonly terminal = Promise.withResolvers<undefined>();
  private hasEnded = false;
  private isInterrupting = false;
  private attached: TClient | null = null;
  /** Armed by a retry; any other event before it fires is progress. */
  private retryStall: ReturnType<typeof setTimeout> | null = null;

  readonly gracePeriodMs: number;
  private readonly retryStallMs: number;
  private readonly detached: Detached;
  private readonly shutdownContext: `${string}.shutdown`;

  constructor(options: {
    gracePeriodMs: number;
    detached: Detached;
    /** Names the turn's shutdown in a detached failure, e.g. `codex-turn`. */
    name: string;
    /** See `RETRY_STALL_MS`. */
    retryStallMs?: number;
  }) {
    this.gracePeriodMs = options.gracePeriodMs;
    this.retryStallMs = options.retryStallMs ?? RETRY_STALL_MS;
    this.detached = options.detached;
    this.shutdownContext = `${options.name}.shutdown`;
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
    interrupt: () => Promise<void>;
  }): HarnessTurn {
    return {
      events: this.queue.items,
      respond: async (response) =>
        await Promise.resolve(session.respond(response)),
      interrupt: async () => session.interrupt(),
      dispose: async () => this.dispose(),
    };
  }

  emit(event: HarnessEvent) {
    if (this.hasEnded) {
      return;
    }
    this.watchRetries(event);
    this.queue.push(event);
    if (isTerminal(event)) {
      this.hasEnded = true;
      this.queue.close();
      this.terminal.resolve(undefined);
      this.detached(this.shutdown(), this.shutdownContext);
    }
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

  private async dispose() {
    if (!this.hasEnded) {
      this.isInterrupting = true;
      this.emit({ type: "turn.interrupted" });
    }
    await this.shutdown();
  }

  /** Ask the process to exit cleanly so its session is saved, then kill it. */
  private async shutdown() {
    const client = this.attached;
    if (client === null) {
      return;
    }
    client.closeInput();
    if (!(await settlesWithin(client.exited, this.gracePeriodMs))) {
      await client.kill();
    }
  }
}
