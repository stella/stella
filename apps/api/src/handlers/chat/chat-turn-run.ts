import { RUN_CANCEL_REASON, toServerSentEventsResponse } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { panic, Result } from "better-result";

import { CHAT_TURN_ID_HEADER } from "@stll/api-contract";

import type { SafeDb } from "@/api/db/safe-db";
import { persistFailedChatTurn } from "@/api/handlers/chat/chat-message-persistence";
import { readChatTurnExecutionStanding } from "@/api/handlers/chat/chat-turn-persistence";
import type { ChatTurnExecution } from "@/api/handlers/chat/chat-turn-persistence";
import type { ChatTurnFailureCode } from "@/api/handlers/chat/chat-turn-state";
import type { PersistableChatMessage } from "@/api/handlers/chat/types";
import { captureError, detached } from "@/api/lib/analytics/capture";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { withSseHeartbeat } from "@/api/lib/sse";
import { abortControllerFromSignal } from "@/api/lib/tanstack-ai-generate";

// A turn's run: the part of a turn that starts at provider dispatch and ends
// with the turn's stored outcome. The request that claimed the turn hands it
// over once, and from then on the run is the turn's only owner. Nothing it
// holds belongs to that request: it keeps its own clock, learns of a stop
// through this process or its heartbeat, and stores its outcome exactly once,
// whether or not anyone still reads its response.

/**
 * How often a producing run looks at its turn row: the latency bound of a
 * stop recorded on another instance. A stop reaching this instance aborts at
 * once.
 */
const CHAT_TURN_HEARTBEAT_MS = 5000;

const HEARTBEAT_FAILED_SINK = failureSink({
  event: "chat.turn.stop_poll_failed",
  expected: [],
});

/** The turn a run produces for, and what storing its failure needs. */
type ChatTurnRunOwner = {
  execution: ChatTurnExecution;
  owningAssistantMessage: PersistableChatMessage | undefined;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

/** Connector clients the run's tools talk through. */
type ChatTurnRunConnectors = { close: () => Promise<void> };

/** What cuts a run's producer short. */
type ChatTurnRunControl = {
  /** The run's own abort: its deadline, a stop, or its response closing. */
  abortController: AbortController;
  /** The deadline alone, which tells a timeout from the other causes. */
  deadlineSignal: AbortSignal;
};

type ChatTurnRunOptions = {
  /** Closed by the run when it never produces; a producing run's agent
   *  loop closes them when it ends. */
  connectors: ChatTurnRunConnectors | undefined;
  /** The run's own deadline. It takes no signal, so nothing tied to the
   *  claiming request can end it. */
  deadlineMs: number;
  heartbeatMs?: number | undefined;
  owner: ChatTurnRunOwner;
};

type ChatTurnRunState =
  | { status: "handed-over" }
  | { status: "producing"; stopHeartbeat: () => void }
  | { status: "settled" };

/** The runs this process produces, by execution id. */
const producingRuns = new Map<string, ChatTurnRun>();

export class ChatTurnRun {
  /** What cuts the run's producer short. */
  readonly control: ChatTurnRunControl;
  private readonly options: ChatTurnRunOptions;
  private readonly settledResolvers = Promise.withResolvers<undefined>();
  private state: ChatTurnRunState = { status: "handed-over" };

  constructor(options: ChatTurnRunOptions) {
    this.options = options;
    const deadlineSignal = AbortSignal.timeout(options.deadlineMs);
    this.control = {
      abortController: abortControllerFromSignal(deadlineSignal),
      deadlineSignal,
    };
  }

  get execution(): ChatTurnExecution {
    return this.options.owner.execution;
  }

  /** Resolves once the run's outcome is stored. */
  get settled(): Promise<undefined> {
    return this.settledResolvers.promise;
  }

  /**
   * Start producing `output`, built against `control`, and serve it. The
   * response is the run's one transport: closing it aborts the run, which is
   * how a closed connection still ends the turn.
   */
  produce(output: AsyncIterable<StreamChunk>): Response {
    if (this.state.status !== "handed-over") {
      return panic(`A chat turn run cannot produce once ${this.state.status}`);
    }
    producingRuns.set(this.execution.executionId, this);
    this.state = { status: "producing", stopHeartbeat: this.startHeartbeat() };
    return withSseHeartbeat(
      toServerSentEventsResponse(output, {
        abortController: this.control.abortController,
        headers: { [CHAT_TURN_ID_HEADER]: this.execution.id },
      }),
    );
  }

  /** Store the run's outcome through `persist`. A run settles once. */
  async settle(persist: () => Promise<void>): Promise<void> {
    if (this.state.status !== "producing") {
      return panic(`A chat turn run cannot settle once ${this.state.status}`);
    }
    try {
      await persist();
    } finally {
      this.release();
    }
  }

  /**
   * Store the turn as failed: the run cannot produce, or cannot store what it
   * produced. A run that never produced closes its connectors and is done.
   * Never throws: a failure it cannot store is reported, and the turn's lease
   * then ends it.
   */
  async fail(code: ChatTurnFailureCode, retryable: boolean): Promise<void> {
    const { status } = this.state;
    if (status === "settled") {
      return panic("A settled chat turn run cannot fail");
    }
    const { owner } = this.options;
    const failure = await persistFailedChatTurn({
      code,
      execution: owner.execution,
      owningAssistantMessage: owner.owningAssistantMessage,
      recordAuditEvent: owner.recordAuditEvent,
      retryable,
      safeDb: owner.safeDb,
      threadId: owner.threadId,
      userId: owner.userId,
      workspaceId: owner.workspaceId,
    });
    if (Result.isError(failure)) {
      captureError(failure.error, { threadId: owner.threadId });
    }
    if (status !== "handed-over") {
      return;
    }
    const { connectors } = this.options;
    if (connectors !== undefined) {
      const closed = await Result.tryPromise(
        async () => await connectors.close(),
      );
      if (Result.isError(closed)) {
        captureError(closed.error, { threadId: owner.threadId });
      }
    }
    this.release();
  }

  /** Stop the run as the user's cancel; resolves once its outcome is stored. */
  stop(): Promise<undefined> {
    this.abortForStop();
    return this.settled;
  }

  /**
   * Upstream's explicit-cancel reason, not a `DOMException`: the run then
   * reads as the user's cancel, never as a closed connection.
   */
  private abortForStop(): void {
    const { abortController } = this.control;
    if (!abortController.signal.aborted) {
      abortController.abort(RUN_CANCEL_REASON);
    }
  }

  /** Look at the turn row on an interval until the run is cut short. */
  private startHeartbeat(): () => void {
    const { owner } = this.options;
    const beat = async () => {
      const standing = await readChatTurnExecutionStanding({
        execution: owner.execution,
        safeDb: owner.safeDb,
      });
      // A failed read is transient: the lease still holds, and the next beat
      // asks again.
      if (Result.isError(standing)) {
        observeFailure(standing.error, { sink: HEARTBEAT_FAILED_SINK });
        return;
      }
      if (standing.value === "stop-requested") {
        this.abortForStop();
      }
    };
    let beating = false;
    const interval = setInterval(() => {
      if (beating) {
        return;
      }
      beating = true;
      detached(
        beat().finally(() => {
          beating = false;
        }),
        "chat-turn-run.heartbeat",
      );
    }, this.options.heartbeatMs ?? CHAT_TURN_HEARTBEAT_MS);
    interval.unref();
    const stop = () => {
      clearInterval(interval);
    };
    this.control.abortController.signal.addEventListener("abort", stop, {
      once: true,
    });
    return stop;
  }

  private release(): void {
    if (this.state.status === "producing") {
      this.state.stopHeartbeat();
    }
    this.state = { status: "settled" };
    producingRuns.delete(this.execution.executionId);
    this.settledResolvers.resolve(undefined);
  }
}

/**
 * Stop the run `executionId` names if this process produces it. Resolves once
 * the run has stored its outcome; null when another process owns the run.
 */
export const stopLocalChatTurnRun = (
  executionId: string,
): Promise<undefined> | null => producingRuns.get(executionId)?.stop() ?? null;
