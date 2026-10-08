import { RUN_CANCEL_REASON, toServerSentEventsResponse } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { panic, Result, TaggedError } from "better-result";

import type { AIProvider } from "@stll/ai-catalog";
import type { ChatSendMode } from "@stll/anonymize-chat";
import { CHAT_TURN_ID_HEADER } from "@stll/api-contract";

import type { SafeDb } from "@/api/db/safe-db";
import { getAwaitingUserInteractions } from "@/api/handlers/chat/chat-message-parts";
import {
  persistFailedChatTurn,
  persistTerminalAssistantTurn,
} from "@/api/handlers/chat/chat-message-persistence";
import type { PersistMessageProps } from "@/api/handlers/chat/chat-message-persistence";
import {
  AI_ERROR_FAILURE_CODE,
  isChatTurnNotOwned,
  readChatTurnExecutionStanding,
  renewChatTurnExecutionLease,
} from "@/api/handlers/chat/chat-turn-persistence";
import type { ChatTurnExecution } from "@/api/handlers/chat/chat-turn-persistence";
import type { ChatTurnFailureCode } from "@/api/handlers/chat/chat-turn-state";
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import type {
  ChatTurnOutcome,
  PersistableChatMessage,
} from "@/api/handlers/chat/types";
import { detached } from "@/api/lib/analytics/capture";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { emitChatTurnSettlementMetric } from "@/api/lib/observability/request-metrics";
import type { ExecutionAdmission } from "@/api/lib/rate-limit/execution-admission";
import { withSseHeartbeat } from "@/api/lib/sse";
import { abortControllerFromSignal } from "@/api/lib/tanstack-ai-generate";
import { withTimeout } from "@/api/lib/with-timeout";

// Delivery is ephemeral; a stalled viewer must not hold a running turn's lease.
const CHAT_TURN_DELIVERY_BUFFER_BYTES = 1024 * 1024;
const DELIVERY_FAILED_SINK = failureSink({
  event: "chat.turn.delivery_failed",
  expected: [],
});

class ChatTurnDeliveryOverflow extends TaggedError("ChatTurnDeliveryOverflow")<{
  message: string;
}> {}

/** Drain the SDK transport independently of the viewer, with a byte ceiling.
 *  An overflowing connection fails explicitly; the owned producer still
 *  settles its durable turn, which the page can reload. */
const eagerlyDeliverTurn = (response: Response): Response => {
  const upstream = response.body;
  if (upstream === null) {
    return panic("A chat turn response has no stream");
  }
  let delivery: "open" | "cancelled" | "overflowed" = "open";
  const source: {
    current:
      | { status: "closed" }
      | {
          status: "reading";
          reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "cancel">;
        };
  } = { current: { status: "closed" } };
  const body = new ReadableStream<Uint8Array>(
    {
      start: (controller) => {
        const drain = async () => {
          const reader = upstream.getReader();
          try {
            source.current = { status: "reading", reader };
            const drained = await Result.tryPromise(async () => {
              while (delivery !== "cancelled") {
                const next = await reader.read();
                if (next.done) {
                  if (delivery === "open") {
                    controller.close();
                  }
                  return;
                }
                if (delivery !== "open") {
                  continue;
                }
                if (!(next.value instanceof Uint8Array)) {
                  panic("A chat response stream emitted a non-byte chunk");
                }
                if (next.value.byteLength > (controller.desiredSize ?? 0)) {
                  delivery = "overflowed";
                  controller.error(
                    new ChatTurnDeliveryOverflow({
                      message:
                        "Chat delivery exceeded its buffer; reload the stored turn",
                    }),
                  );
                  continue;
                }
                controller.enqueue(next.value);
              }
            });
            if (Result.isError(drained)) {
              const { error } = drained;
              if (delivery === "open") {
                controller.error(error);
              } else {
                observeFailure(error, { sink: DELIVERY_FAILED_SINK });
              }
            }
          } finally {
            reader.releaseLock();
            source.current = { status: "closed" };
          }
        };
        detached(drain(), "chat-turn-run.delivery");
      },
      cancel: async (reason) => {
        delivery = "cancelled";
        if (source.current.status === "reading") {
          await source.current.reader.cancel(reason);
        }
      },
    },
    new ByteLengthQueuingStrategy({
      highWaterMark: CHAT_TURN_DELIVERY_BUFFER_BYTES,
    }),
  );
  return new Response(body, response);
};

// A turn's run: the part of a turn that starts at provider dispatch and ends
// with the turn's stored outcome. The request that claimed the turn hands it
// over once, and from then on the run is the turn's only owner. Nothing it
// holds belongs to that request: it keeps its own clock, holds its lease by a
// heartbeat, learns of a stop through this process or that heartbeat, and
// stores its outcome exactly once, whether or not anyone still reads its
// response.

type ChatTurnRunHeartbeat = {
  /**
   * How often the run looks at its turn row: the latency bound of a stop
   * recorded on another instance. A stop reaching this instance aborts at
   * once.
   */
  intervalMs: number;
  /** Every how many beats the run renews its lease instead of only reading. */
  renewEvery: number;
};

/**
 * Renewing every 20 s keeps the lease (`CHAT_TURN_RUN_LEASE_MS`, 60 s) alive
 * across two failed renewals before a live owner could lose it.
 */
const CHAT_TURN_RUN_HEARTBEAT = {
  intervalMs: 5000,
  renewEvery: 4,
} as const satisfies ChatTurnRunHeartbeat;

/**
 * The abort reason of a run that no longer owns its turn: its lease was lost,
 * or its process is shutting down. It ends the turn as `owner-lost`.
 */
export const CHAT_TURN_OWNER_LOST_REASON = "stella.chat-turn.owner-lost";

const HEARTBEAT_FAILED_SINK = failureSink({
  event: "chat.turn.stop_poll_failed",
  expected: [],
});
const SETTLEMENT_FAILED_SINK = failureSink({
  event: "chat.turn.failure_settlement_failed",
  expected: [],
});
const CONNECTOR_CLOSE_FAILED_SINK = failureSink({
  event: "chat.turn.connector_close_failed",
  expected: [],
});

/** The boundary a turn's provider input crosses, by the mode it was sent in. */
export const CHAT_TURN_BOUNDARY_MODE = {
  anonymized: "anonymized",
  rawOverride: "raw",
} as const satisfies Record<ChatSendMode, ChatThirdPartyBoundary["type"]>;

/** What a turn's settlement is counted under. */
export type ChatTurnObservation = {
  mode: ChatThirdPartyBoundary["type"];
  /** `none` until the turn's model is resolved. */
  provider: AIProvider | "none";
};

/**
 * Count one turn this process settled, by outcome, boundary mode and
 * provider. A turn another owner or the reaper settled is never counted here.
 */
export const countChatTurnSettlement = (
  observation: ChatTurnObservation,
  outcome: ChatTurnOutcome["type"],
  failureCode: ChatTurnFailureCode | null,
): void => {
  emitChatTurnSettlementMetric({
    failureCode,
    mode: observation.mode,
    outcome,
    provider: observation.provider,
  });
};

/**
 * What a run's persistence left on the turn row: the outcome it stored, which
 * a stop that won the race may have turned into `cancelled`, or nothing,
 * because another execution or the reaper settled the turn first. Only a
 * stored outcome is counted, so the count matches the durable row.
 */
export type ChatTurnStoredSettlement =
  | { type: "stored"; outcome: ChatTurnOutcome }
  | { type: "not-owned" };

/** The turn a run produces for, and what storing its failure needs. */
type ChatTurnRunOwner = {
  indexThread: PersistMessageProps["indexThread"];
  execution: ChatTurnExecution;
  owningAssistantMessage: PersistableChatMessage | undefined;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

/** Connector clients the run's tools talk through. */
type ChatTurnRunConnectors = { close: () => void | Promise<void> };

/** What cuts a run's producer short. */
type ChatTurnRunControl = {
  /** The run's own abort: its deadline, a stop, or its response closing. */
  abortController: AbortController;
  /** The SDK provider also stops on admission loss without ending the transport. */
  providerAbortController: AbortController;
  /** The deadline alone, which tells a timeout from the other causes. */
  deadlineSignal: AbortSignal;
  /** Execution admission cancellation; durable ownership keeps its own fence. */
  admissionSignal?: AbortSignal;
};

type ChatTurnRunOptions = {
  admission?: ExecutionAdmission | undefined;
  /** Pending interaction before accepting this continuation. */
  checkpoint?: PersistableChatMessage | undefined;
  /** Closed by the run when it never produces; a producing run's agent
   *  loop closes them when it ends. */
  connectors: ChatTurnRunConnectors | undefined;
  /** The run's own deadline. It takes no signal, so nothing tied to the
   *  claiming request can end it. */
  deadlineMs: number;
  /** Same cleanup deadline in production; injectable clock for settlement tests. */
  waitForUpstream?: typeof withTimeout | undefined;
  heartbeat?: ChatTurnRunHeartbeat | undefined;
  /** The boundary mode the run's settlement is counted under. */
  mode: ChatTurnObservation["mode"];
  owner: ChatTurnRunOwner;
  /** Who tracks the run; the process by default. */
  ownership?: ChatTurnOwnership | undefined;
};

/** A run's heartbeat: stopped at once, idle once its last beat is over. */
type ChatTurnRunHeartbeatHandle = {
  /** Resolves once no beat is reading the turn any more. */
  idle: () => Promise<void>;
  /** No beat starts from now on. */
  stop: () => void;
};

type ChatTurnRunState =
  | { status: "handed-over" }
  | { status: "producing"; heartbeat: ChatTurnRunHeartbeatHandle }
  | { status: "settled" };

/**
 * Whether the run's turn has its outcome stored: the run's own, its failure,
 * or the outcome of whoever settled the turn after taking it over. Only an
 * unstored turn is left to the reaper.
 */
type ChatTurnRunEnd = "stored" | "unstored";

type ChatTurnClaim = { execution: ChatTurnExecution; safeDb: SafeDb };

/**
 * What a process owns of chat turns: the runs handed a turn and not yet over,
 * by execution id, the turns a send has claimed but not yet handed to a run,
 * and the work a turn left running once it ended (its follow-ups). The
 * process has one (`processChatTurnOwnership`); a test gives its runs their
 * own.
 */
export class ChatTurnOwnership {
  private readonly liveRuns = new Map<string, ChatTurnRun>();
  private readonly claims = new Set<ChatTurnClaim>();
  private readonly followUps = new Set<Promise<unknown>>();
  private relinquishing = false;
  private changed = Promise.withResolvers<undefined>();

  /** The live run `executionId` names, if this owner has one. */
  run(executionId: string): ChatTurnRun | undefined {
    return this.liveRuns.get(executionId);
  }

  /** Track `run`; while relinquishing, it is cut short at once. */
  adopt(run: ChatTurnRun): void {
    this.liveRuns.set(run.execution.executionId, run);
    this.noteChange();
    if (this.relinquishing) {
      detached(run.relinquish(), "chat-turn-run.relinquish-late-run");
    }
  }

  /** Stop tracking `run`, which is over. */
  release(run: ChatTurnRun): void {
    if (this.liveRuns.delete(run.execution.executionId)) {
      this.noteChange();
    }
  }

  /**
   * Track `work`, which runs past the end of the turn that started it: a
   * process giving up its turns waits for it before its database goes away.
   * Returns `work` for the caller to detach under its own label.
   */
  async followUp<T>(work: Promise<T>): Promise<T> {
    const tracked: Promise<unknown> = Promise.allSettled([work]).finally(() => {
      this.followUps.delete(tracked);
    });
    this.followUps.add(tracked);
    return await work;
  }

  /**
   * Record a turn a send has claimed and still prepares, so relinquishing
   * finds it. Call the returned function once the send no longer holds it.
   */
  holdClaim(claim: ChatTurnClaim): () => void {
    this.claims.add(claim);
    return () => {
      if (this.claims.delete(claim)) {
        this.noteChange();
      }
    };
  }

  /**
   * Give up every turn owned here, for a process that is stopping. Each run
   * is cut short and stores what it has as `owner-lost`, so none waits out
   * its lease; a run handed a turn from now on is cut short at once. A turn a
   * send still prepares gets the short run lease, so if the process ends
   * before the send hands it over, the reaper finds it within that lease.
   * Resolves once nothing is owned any more, the turns' follow-ups included,
   * saying whether every run stored its outcome; the caller bounds the wait.
   */
  async relinquish(): Promise<ChatTurnRunEnd> {
    this.relinquishing = true;
    try {
      return await this.relinquishOwned();
    } finally {
      this.relinquishing = false;
    }
  }

  private async relinquishOwned(): Promise<ChatTurnRunEnd> {
    const ends = new Map<ChatTurnRun, Promise<ChatTurnRunEnd>>();
    const shortened = new Set<ChatTurnClaim>();
    while (this.liveRuns.size > 0 || this.claims.size > 0) {
      const { promise: changed } = this.changed;
      for (const claim of this.claims) {
        if (!shortened.has(claim)) {
          shortened.add(claim);
          detached(
            this.followUp(shortenClaimLease(claim)),
            "chat-turn-run.relinquish-claim",
          );
        }
      }
      const current: Promise<ChatTurnRunEnd>[] = [];
      for (const run of this.liveRuns.values()) {
        const runEnd = ends.get(run) ?? run.relinquish();
        ends.set(run, runEnd);
        current.push(runEnd);
      }
      // A live run's end is still pending (a run leaves `liveRuns` before its
      // end resolves), so this waits for a run to end or for a change.
      await Promise.race([...current, changed]);
    }
    const settled = await Promise.all(ends.values());
    // A run's follow-ups start before it ends; a follow-up may start another.
    while (this.followUps.size > 0) {
      await Promise.all(this.followUps);
    }
    return settled.includes("unstored") ? "unstored" : "stored";
  }

  private noteChange(): void {
    this.changed.resolve(undefined);
    this.changed = Promise.withResolvers<undefined>();
  }
}

/** Give a claimed turn the short run lease; a failure leaves the long one. */
const shortenClaimLease = async (claim: ChatTurnClaim): Promise<void> => {
  const renewed = await renewChatTurnExecutionLease(claim);
  if (Result.isError(renewed)) {
    observeFailure(renewed.error, { sink: HEARTBEAT_FAILED_SINK });
  }
};

/** What this process owns of chat turns. */
export const processChatTurnOwnership = new ChatTurnOwnership();

export class ChatTurnRun {
  /** What cuts the run's producer short. */
  readonly control: ChatTurnRunControl;
  private readonly options: ChatTurnRunOptions;
  private readonly ownership: ChatTurnOwnership;
  private readonly settledResolvers = Promise.withResolvers<ChatTurnRunEnd>();
  private state: ChatTurnRunState = { status: "handed-over" };
  private stored = false;
  private continuationProduction: "not-started" | "started" = "not-started";
  private upstream:
    | { status: "not-started" }
    | { status: "producing"; closed: Promise<undefined> }
    | { status: "closed" } = { status: "not-started" };
  /** A cut requested before the run produced; applied once it does. */
  private pendingAbort: string | undefined;
  private provider: ChatTurnObservation["provider"] = "none";

  constructor(options: ChatTurnRunOptions) {
    this.options = options;
    const deadlineSignal = AbortSignal.timeout(options.deadlineMs);
    const abortController = abortControllerFromSignal(deadlineSignal);
    this.control = {
      abortController,
      providerAbortController:
        options.admission === undefined
          ? abortController
          : abortControllerFromSignal(
              AbortSignal.any([
                abortController.signal,
                options.admission.signal,
              ]),
            ),
      deadlineSignal,
      ...(options.admission === undefined
        ? {}
        : { admissionSignal: options.admission.signal }),
    };
    this.ownership = options.ownership ?? processChatTurnOwnership;
    this.ownership.adopt(this);
  }

  get execution(): ChatTurnExecution {
    return this.options.owner.execution;
  }

  /** Name the provider the run's model resolved to, for its settlement count. */
  attributeProvider(provider: AIProvider): void {
    this.provider = provider;
  }

  private countSettlement(
    outcome: ChatTurnOutcome["type"],
    failureCode: ChatTurnFailureCode | null,
  ): void {
    countChatTurnSettlement(
      { mode: this.options.mode, provider: this.provider },
      outcome,
      failureCode,
    );
  }

  /** Resolves once the run is over, saying whether it stored an outcome. */
  get settled(): Promise<ChatTurnRunEnd> {
    return this.settledResolvers.promise;
  }

  /** A continuation cannot execute once its admission has been lost. */
  startContinuationProduction(): boolean {
    if (this.control.admissionSignal?.aborted) {
      return false;
    }
    this.continuationProduction = "started";
    return true;
  }

  /** Only an untouched continuation can return to its original user checkpoint. */
  get restorableCheckpoint(): PersistableChatMessage | undefined {
    if (
      this.continuationProduction !== "not-started" ||
      !this.control.admissionSignal?.aborted ||
      this.control.abortController.signal.reason === RUN_CANCEL_REASON ||
      this.control.abortController.signal.reason === CHAT_TURN_OWNER_LOST_REASON
    ) {
      return undefined;
    }
    const { checkpoint } = this.options;
    return checkpoint !== undefined &&
      getAwaitingUserInteractions(checkpoint).length > 0
      ? checkpoint
      : undefined;
  }

  private async restoreCheckpoint(checkpoint: PersistableChatMessage) {
    const interaction = getAwaitingUserInteractions(checkpoint).at(0);
    if (interaction === undefined) {
      return panic("A restorable chat checkpoint must await user input");
    }
    const { owner } = this.options;
    return await persistTerminalAssistantTurn({
      indexThread: owner.indexThread,
      execution: owner.execution,
      outcome: { type: "awaiting-user", interaction },
      owningAssistantMessage: checkpoint,
      recordAuditEvent: owner.recordAuditEvent,
      safeDb: owner.safeDb,
      threadId: owner.threadId,
      userId: owner.userId,
      workspaceId: owner.workspaceId,
    });
  }

  // Closing the owned output also closes the nested SDK iterator. Its async
  // finalizers (metering and MCP disposal) belong to the admission lifetime.
  private trackUpstream(
    output: AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    const closed = Promise.withResolvers<undefined>();
    this.upstream = { status: "producing", closed: closed.promise };
    const ended = () => {
      this.upstream = { status: "closed" };
      closed.resolve(undefined);
    };
    return (async function* () {
      try {
        yield* output;
      } finally {
        ended();
      }
    })();
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
    this.state = { status: "producing", heartbeat: this.startHeartbeat() };
    // Building the response starts its pump, which pulls the stream first.
    const response = eagerlyDeliverTurn(
      withSseHeartbeat(
        toServerSentEventsResponse(
          this.options.admission === undefined
            ? output
            : this.trackUpstream(output),
          {
            abortController: this.control.abortController,
            headers: { [CHAT_TURN_ID_HEADER]: this.execution.id },
          },
        ),
      ),
    );
    if (this.pendingAbort !== undefined) {
      this.abort(this.pendingAbort);
    }
    return response;
  }

  /**
   * Store the run's outcome through `persist`, which reports what the turn row
   * now holds. A run settles once, and counts the outcome `persist` stored,
   * never the one it proposed, and nothing when another owner settled the turn.
   * A `persist` that cannot store fails the run itself before it throws, and
   * that failure, once stored, is what is counted.
   */
  async settle(
    persist: () => Promise<ChatTurnStoredSettlement>,
  ): Promise<void> {
    if (this.state.status !== "producing") {
      return panic(`A chat turn run cannot settle once ${this.state.status}`);
    }
    // Settling ends the run's hold on the turn: from here a beat would find
    // the turn no longer running and cut the response's last chunks.
    this.state.heartbeat.stop();
    try {
      const checkpoint = this.restorableCheckpoint;
      if (checkpoint === undefined) {
        const settlement = await persist();
        this.stored = true;
        if (settlement.type === "stored") {
          const { outcome } = settlement;
          this.countSettlement(
            outcome.type,
            outcome.type === "failed"
              ? AI_ERROR_FAILURE_CODE[outcome.error]
              : null,
          );
        }
      } else {
        const restored = await this.restoreCheckpoint(checkpoint);
        this.stored =
          Result.isOk(restored) || isChatTurnNotOwned(restored.error);
        if (Result.isError(restored) && !isChatTurnNotOwned(restored.error)) {
          observeFailure(restored.error, {
            sink: SETTLEMENT_FAILED_SINK,
            ctx: { threadId: this.options.owner.threadId },
          });
        }
      }
    } finally {
      this.release();
    }
  }

  /**
   * Track `work`, which runs past the end of this turn (a title, say): its
   * owner waits for it before the process gives up its database. Returns
   * `work` for the caller to detach under its own label.
   */
  async followUp<T>(work: Promise<T>): Promise<T> {
    return await this.ownership.followUp(work);
  }

  /** A detached action acquires its own lease only after this one releases. */
  async followUpAfterSettlement<T>(work: () => Promise<T>): Promise<T> {
    return await this.ownership.followUp(
      this.options.admission === undefined ? work() : this.settled.then(work),
    );
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
    const checkpoint = this.restorableCheckpoint;
    const failure =
      checkpoint === undefined
        ? await persistFailedChatTurn({
            code,
            execution: owner.execution,
            indexThread: owner.indexThread,
            owningAssistantMessage: owner.owningAssistantMessage,
            recordAuditEvent: owner.recordAuditEvent,
            retryable,
            safeDb: owner.safeDb,
            threadId: owner.threadId,
            userId: owner.userId,
            workspaceId: owner.workspaceId,
          })
        : await this.restoreCheckpoint(checkpoint);
    const settledElsewhere =
      Result.isError(failure) && isChatTurnNotOwned(failure.error);
    if (checkpoint === undefined && Result.isOk(failure)) {
      // Counted only once stored, so the count matches the turn row: a turn
      // another owner settled keeps (and counts) that outcome, and one whose
      // failure cannot be stored is left to its lease.
      this.countSettlement("failed", code);
    }
    if (Result.isOk(failure) || settledElsewhere) {
      // A turn another execution or the reaper settled first keeps that
      // outcome: the fence refused this run, and nothing is left to store.
      this.stored = true;
    } else {
      observeFailure(failure.error, {
        sink: SETTLEMENT_FAILED_SINK,
        ctx: { threadId: owner.threadId },
      });
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
        observeFailure(closed.error, {
          sink: CONNECTOR_CLOSE_FAILED_SINK,
          ctx: { threadId: owner.threadId },
        });
      }
    }
    this.release();
  }

  /** Stop the run as the user's cancel; resolves once it is over. */
  async stop(): Promise<ChatTurnRunEnd> {
    this.abortForStop();
    return await this.settled;
  }

  /**
   * End the run because its process is going away: it stores what it has as
   * `owner-lost` and resolves once that is stored.
   */
  async relinquish(): Promise<ChatTurnRunEnd> {
    this.abort(CHAT_TURN_OWNER_LOST_REASON);
    return await this.settled;
  }

  /**
   * Upstream's explicit-cancel reason, not a `DOMException`: the run then
   * reads as the user's cancel, never as a closed connection.
   */
  private abortForStop(): void {
    this.abort(RUN_CANCEL_REASON);
  }

  /**
   * Cut the run short with `reason`. A run not yet producing keeps the reason
   * until it produces: the response's pump never reads a stream whose
   * controller is already aborted, so the run would never store its outcome.
   */
  private abort(reason: string): void {
    if (this.state.status === "handed-over") {
      this.pendingAbort ??= reason;
      return;
    }
    const { abortController } = this.control;
    if (!abortController.signal.aborted) {
      abortController.abort(reason);
    }
  }

  /**
   * Look at the turn row on an interval until the run is cut short, renewing
   * the lease every few beats. A run that finds its turn no longer its own
   * stops producing: another owner, or the reaper, settles it.
   */
  private startHeartbeat(): ChatTurnRunHeartbeatHandle {
    const { heartbeat = CHAT_TURN_RUN_HEARTBEAT, owner } = this.options;
    let beats = 0;
    let stopped = false;
    const beat = async () => {
      beats += 1;
      const lookup = {
        execution: owner.execution,
        safeDb: owner.safeDb,
      };
      const standing =
        beats % heartbeat.renewEvery === 0
          ? await renewChatTurnExecutionLease(lookup)
          : await readChatTurnExecutionStanding(lookup);
      // A beat that lands after the heartbeat stopped reports a turn the run
      // is settling or has settled itself.
      if (stopped) {
        return;
      }
      // A failed read or renewal is transient: the lease still holds, and the
      // next beat asks again.
      if (Result.isError(standing)) {
        observeFailure(standing.error, { sink: HEARTBEAT_FAILED_SINK });
        return;
      }
      switch (standing.value) {
        case "owned":
          return;
        case "stop-requested":
          this.abortForStop();
          return;
        case "lost":
          this.abort(CHAT_TURN_OWNER_LOST_REASON);
          return;
        default:
          standing.value satisfies never;
          panic(`Unhandled standing: ${String(standing.value)}`);
      }
    };
    /** The beat still reading the turn, settled either way. */
    let beating: Promise<unknown> | undefined;
    const interval = setInterval(() => {
      if (beating !== undefined) {
        return;
      }
      const current = beat();
      detached(current, "chat-turn-run.heartbeat");
      beating = Promise.allSettled([current]).finally(() => {
        beating = undefined;
      });
    }, heartbeat.intervalMs);
    interval.unref();
    const stop = () => {
      stopped = true;
      clearInterval(interval);
    };
    this.control.abortController.signal.addEventListener("abort", stop, {
      once: true,
    });
    return {
      idle: async () => {
        await beating;
      },
      stop,
    };
  }

  /**
   * End the run: it is no longer owned, and it is over (`settled` resolves)
   * once a beat still reading its turn is done, so nothing of it touches the
   * database after that. Its response does not wait for the beat.
   */
  private release(): void {
    const { state } = this;
    this.state = { status: "settled" };
    const end: ChatTurnRunEnd = this.stored ? "stored" : "unstored";
    if (state.status !== "producing") {
      this.ownership.release(this);
      this.finishSettlement(end);
      return;
    }
    state.heartbeat.stop();
    // Handed to the owner before the run leaves it, so giving up the
    // process's turns at any moment from here still waits for that beat.
    const idle = this.ownership.followUp(state.heartbeat.idle());
    this.ownership.release(this);
    this.finishSettlement(idle.then(() => end));
  }
  private finishSettlement(
    end: ChatTurnRunEnd | Promise<ChatTurnRunEnd>,
  ): void {
    const { admission } = this.options;
    if (admission === undefined) {
      this.settledResolvers.resolve(end);
      return;
    }
    const upstreamClosed =
      this.upstream.status === "producing"
        ? this.upstream.closed
        : Promise.resolve(undefined);
    // Persistence runs within the output iterator: it must return so the
    // iterator can close. Only the end receipt waits for both settlements.
    const completed = this.ownership.followUp(
      Promise.resolve(end).then(async (settled) => {
        // A stuck SDK finalizer must not renew capacity indefinitely after
        // fenced persistence. Cleanup gets the existing provider time budget.
        const closed = await Result.tryPromise(
          async () =>
            await (this.options.waitForUpstream ?? withTimeout)(
              async () => await upstreamClosed,
              {
                label: "chat-upstream-finalization",
                timeoutMs: this.options.deadlineMs,
              },
            ),
        );
        if (Result.isError(closed)) {
          logger.warn("chat.turn.upstream_finalization_timeout", {
            executionId: this.execution.executionId,
            timeoutMs: this.options.deadlineMs,
          });
        }
        await admission.release();
        return settled;
      }),
    );
    this.settledResolvers.resolve(completed);
  }
}

/**
 * Stop the run `executionId` names if this process owns it. Resolves once the
 * run is over; null when another process owns the run.
 */
export const stopLocalChatTurnRun = (
  executionId: string,
): Promise<ChatTurnRunEnd> | null =>
  processChatTurnOwnership.run(executionId)?.stop() ?? null;

/** Give up every chat turn this process owns; see `relinquish`. */
export const relinquishChatTurnRuns = async (): Promise<ChatTurnRunEnd> =>
  await processChatTurnOwnership.relinquish();
