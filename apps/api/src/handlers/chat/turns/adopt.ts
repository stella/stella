import { panic, Result } from "better-result";

import { CHAT_RUN_TARGET_KIND } from "@stll/api-contract/chat-run-target";
import { mapWithConcurrency } from "@stll/concurrency";

import { sweepHandedOverChatTurns } from "@/api/db/root";
import { NO_ANSWER_QUOTE_CHECKER } from "@/api/handlers/chat/answer-quote-checks";
import { createChatTurnBudget } from "@/api/handlers/chat/chat-turn-budget";
import { adoptHandedOverChatTurn } from "@/api/handlers/chat/chat-turn-persistence";
import {
  CHAT_TURN_BOUNDARY_MODE,
  type ChatTurnOwnership,
  ChatTurnRun,
  chatTurnRunBoundOf,
  type ChatTurnStoredSettlement,
} from "@/api/handlers/chat/chat-turn-run";
import {
  knownDecisionPassageStamper,
  NO_DECISION_PASSAGE_NUMBERS,
} from "@/api/handlers/chat/decision-passage-numbers";
import { adoptChatLocalRun } from "@/api/handlers/chat/local-run-plan";
import {
  produceChatTurn,
  type StreamChatFinishEvent,
} from "@/api/handlers/chat/stream-chat";
import { resolveRegistryToolInputRefs } from "@/api/handlers/chat/tools/registry-adapter/input-ref-hydration";
import { resolveRegistryToolOutputRefs } from "@/api/handlers/chat/tools/registry-adapter/output-ref-resolution";
import {
  loadStoredTurnSettlement,
  persistStreamedTurn,
  type StreamedTurnSettlementContext,
} from "@/api/handlers/chat/turns/settle";
import { createVisualResourceOrigin } from "@/api/handlers/visual-sandbox/resource-origin";
import { detached } from "@/api/lib/analytics/capture";
import { createContextNoticeStamp } from "@/api/lib/chat/context-notice";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { resolveServerStartedMember } from "@/api/lib/chat/server-started-member";
import type { HandedOverChatTurn } from "@/api/lib/db/chat-turn-handover-system";
import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import type { DesktopRunnerRunBell } from "@/api/lib/desktop-runner/doorbell";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { startExecutionAdmission } from "@/api/lib/rate-limit/execution-admission";
import { upsertChatThreadSearchDocument } from "@/api/lib/search/index-chat";

/** Turns one sweep visits; a larger backlog continues on the next sweep. */
const SWEEP_BATCH_SIZE = 25;
const SWEEP_CONCURRENCY = 2;
/** How often every API task looks for a turn whose ring was lost. */
const CHAT_TURN_ADOPTION_SWEEP_INTERVAL_MS = 15_000;

/** A sweep for handed-over turns failed; the next one tries again. */
const ADOPTION_SWEEP_FAILED = failureSink({
  event: "chat.turn.adoption_sweep_failed",
  expected: [],
});
/** A step of adopting a handed-over turn failed; the sweep tries it again. */
const ADOPTION_FAILED = failureSink({
  event: "chat.turn.adoption_failed",
  expected: [],
});
/** Storing an adopted turn's answer failed; the turn is stored as failed. */
const ADOPTED_TURN_NOT_STORED = failureSink({
  event: "chat.turn.adopted_persist_failed",
  expected: [],
});

type ChatTurnAdoptionDependencies = {
  /** Ends adoption when this process stops: a stopping task adopts nothing. */
  signal: AbortSignal;
  indexThread: typeof upsertChatThreadSearchDocument;
  /** Who tracks the adopted runs; the process by default. */
  ownership?: ChatTurnOwnership | undefined;
  /** The gateway control; the process's own by default. */
  runtime?:
    | { control: DesktopRunnerControl; runBell: DesktopRunnerRunBell }
    | undefined;
  startAdmission?: typeof startExecutionAdmission | undefined;
};

/** What one attempt to adopt a handed-over turn did. */
type ChatTurnAdoptionOutcome =
  /** This task runs the turn now. */
  | { type: "adopted" }
  /** Another task took it, or it ended, or its member cannot act any more. */
  | { type: "not-adopted" }
  /** A step may pass on its own (admission, an outage): the sweep tries again. */
  | { type: "retry-later" };

/**
 * Store an adopted turn's finished answer, as the member's turn. No response
 * waits on it, so nothing is thrown: a turn whose answer cannot be stored is
 * stored as failed by its run, and the run is told so.
 */
const settleAdoptedTurn = async ({
  context,
  event,
  run,
}: {
  context: StreamedTurnSettlementContext;
  event: StreamChatFinishEvent;
  run: ChatTurnRun;
}): Promise<ChatTurnStoredSettlement> => {
  const persisted = await Result.tryPromise(
    async () => await persistStreamedTurn({ context, event }),
  );
  if (Result.isOk(persisted) && Result.isOk(persisted.value)) {
    return persisted.value.value.settlement;
  }
  const failure = Result.isError(persisted)
    ? { code: "internal" as const, error: persisted.error }
    : persisted.value.error;
  observeFailure(failure.error, {
    sink: ADOPTED_TURN_NOT_STORED,
    ctx: { threadId: context.turn.threadId },
  });
  await run.fail(failure.code, true);
  return { type: "failed-instead" };
};

/**
 * Take over a handed-over turn and read its run on from where the task that
 * released it stopped, as the member: proved again now, holding a slot of
 * their own, with the turn's settlement read from its stored rows. Exactly
 * one task wins the claim (`adoptHandedOverChatTurn`); from then on this
 * task's run owns the turn, pumps the run log the turn's pages tail, and
 * settles the turn as the task that released it would have.
 *
 * A turn this task cannot take keeps waiting for another until its adopt-by,
 * when the reaper ends it as `owner-lost`. A turn claimed but not readable
 * (its member's matters or computer access gone, a store outage) is left to
 * its run lease, which nothing renews, with the same end.
 */
const adoptChatTurn = async ({
  dependencies,
  turn: { organizationId, threadId, turnId, userId },
}: {
  dependencies: ChatTurnAdoptionDependencies;
  turn: HandedOverChatTurn;
}): Promise<ChatTurnAdoptionOutcome> => {
  if (dependencies.signal.aborted) {
    return { type: "not-adopted" };
  }
  const member = await resolveServerStartedMember({
    organizationId,
    userId,
    work: { type: "turn-handover", threadId, turnId },
    signal: dependencies.signal,
  });
  if (Result.isError(member)) {
    observeFailure(member.error, {
      sink: ADOPTION_FAILED,
      ctx: { step: "member", threadId },
    });
    return { type: "retry-later" };
  }
  if (member.value.type === "unavailable") {
    return { type: "not-adopted" };
  }
  const { caller } = member.value;
  // The turn's slot: the task that released it gave its own up. The turn's
  // period was reserved by the send that started it (`[turn, run]`), and a
  // handover continues that phase, so none is reserved again.
  const admission = await (
    dependencies.startAdmission ?? startExecutionAdmission
  )({
    organizationId,
    userId,
    organizationStateDb: caller.scopedDb,
    mode: "concurrency-only",
    actionKind: "chat.send",
  });
  if (Result.isError(admission)) {
    return { type: "retry-later" };
  }
  const claimed = await adoptHandedOverChatTurn({
    safeDb: caller.safeDb,
    threadId,
    turnId,
  });
  if (Result.isError(claimed) || claimed.value === null) {
    await admission.value.release();
    if (Result.isError(claimed)) {
      observeFailure(claimed.error, {
        sink: ADOPTION_FAILED,
        ctx: { step: "claim", threadId },
      });
      return { type: "retry-later" };
    }
    return { type: "not-adopted" };
  }
  const adopted = claimed.value;
  const leaveToLease = async (step: string, error: unknown) => {
    observeFailure(error, { sink: ADOPTION_FAILED, ctx: { step, threadId } });
    await admission.value.release();
    return { type: "not-adopted" } satisfies ChatTurnAdoptionOutcome;
  };
  const loaded = await loadStoredTurnSettlement({
    checkpointMessageId: adopted.checkpointMessageId,
    createRefRegistry: createChatRefRegistry,
    execution: adopted.execution,
    indexThread: dependencies.indexThread,
    member: caller,
    threadId,
  });
  if (Result.isError(loaded)) {
    return await leaveToLease("load", loaded.error);
  }
  if (loaded.value.type !== "loaded") {
    return await leaveToLease("load", loaded.value);
  }
  const { context } = loaded.value;
  const checkpoint =
    context.turn.owningAssistantMessage ??
    panic("A loaded handed-over turn continues no stored answer");
  const adoptedRun = await adoptChatLocalRun({
    chatThreadId: threadId,
    chatTurnId: turnId,
    featureAccessSnapshot: caller.featureAccessSnapshot,
    organizationId,
    ...(dependencies.runtime === undefined
      ? {}
      : { runtime: dependencies.runtime }),
    userId,
    workspaceIds: context.refs.opaqueReadWorkspaceIds,
  });
  if (Result.isError(adoptedRun)) {
    return await leaveToLease("local-run", adoptedRun.error);
  }
  if (adoptedRun.value.type !== "adopted") {
    return await leaveToLease("local-run", adoptedRun.value);
  }
  const localRun = adoptedRun.value.run;
  // Apps the released read showed are in the stored answer; the origin
  // accepts them again when the turn is stored, and mints the rest.
  const visualOrigin = createVisualResourceOrigin({
    persistedParts: checkpoint.parts,
  });
  const run = new ChatTurnRun({
    ownership: dependencies.ownership,
    admission: admission.value,
    connectors: undefined,
    bound: chatTurnRunBoundOf(CHAT_RUN_TARGET_KIND.local),
    // A turn on a computer is never sent anonymized.
    mode: CHAT_TURN_BOUNDARY_MODE.rawOverride,
    owner: {
      indexThread: dependencies.indexThread,
      execution: adopted.execution,
      owningAssistantMessage: checkpoint,
      recordAuditEvent: caller.recordAuditEvent,
      safeDb: caller.safeDb,
      threadId,
      userId,
      workspaceId: adopted.workspaceId,
    },
  });
  const { registry } = context.refs;
  const production = produceChatTurn({
    source: localRun.withResourceOrigin(visualOrigin).stream({
      chatRunId: adopted.runId,
      chatTurnId: turnId,
      // The run already has its history and instructions.
      messages: [],
      instructions: "",
      resume: undefined,
      abortSignal: run.control.abortController.signal,
    }),
    run,
    safeDb: caller.safeDb,
    organizationId,
    runId: adopted.runId,
    threadId,
    thirdPartyBoundary: { type: "raw" },
    // Read only by an anonymized boundary.
    latestMessageId: checkpoint.id,
    initialMessages: context.history.messages,
    restorationPairs: [],
    owningAssistantMessageId: checkpoint.id,
    turnBudget: createChatTurnBudget({ owningMessage: checkpoint }),
    contextNotice: createContextNoticeStamp(null),
    dismissesAwaited: false,
    // A harness answered the turn: no turn model, no reasoning provenance.
    stampAnswer: (message) => message,
    storedHistory: {
      rewrittenOnAcceptance: [],
      // A local run's source drops snapshots (`LOCAL_RUN_EVENT_DISPOSITION`).
      loadServed: () => panic("A local run carries no messages snapshot"),
    },
    visualOrigin,
    decisionPassageStamper: knownDecisionPassageStamper(
      NO_DECISION_PASSAGE_NUMBERS,
    ),
    answerQuoteChecker: NO_ANSWER_QUOTE_CHECKER,
    resolveAssistantTextRefs: registry.resolveAssistantTextRefs,
    resolveAssistantToolInputRefs: ({ input, toolName }) =>
      resolveRegistryToolInputRefs({ input, refRegistry: registry, toolName }),
    resolveAssistantToolOutputRefs: ({ output, toolName }) =>
      resolveRegistryToolOutputRefs({
        output,
        refRegistry: registry,
        toolName,
      }),
    resolveAssistantValueRefs: registry.resolveAssistantValueRefs,
    onFinish: async (event) => await settleAdoptedTurn({ context, event, run }),
  });
  await run.pump(production.output, production.durability);
  return { type: "adopted" };
};

/**
 * This process's adopter: adopts a rung turn at most once at a time here
 * (another task adopting the same turn loses the claim), and sweeps for
 * turns whose ring was lost.
 */
const createChatTurnAdopter = (dependencies: ChatTurnAdoptionDependencies) => {
  const adopting = new Set<string>();
  const adopt = async (turn: HandedOverChatTurn): Promise<void> => {
    if (adopting.has(turn.turnId)) {
      return;
    }
    adopting.add(turn.turnId);
    const adopted = await Result.tryPromise(
      async () => await adoptChatTurn({ dependencies, turn }),
    );
    adopting.delete(turn.turnId);
    if (Result.isError(adopted)) {
      observeFailure(adopted.error, {
        sink: ADOPTION_FAILED,
        ctx: { step: "adopt", threadId: turn.threadId },
      });
    }
  };
  const sweep = async (): Promise<void> => {
    if (dependencies.signal.aborted) {
      return;
    }
    const turns = await sweepHandedOverChatTurns(SWEEP_BATCH_SIZE);
    await mapWithConcurrency({
      items: turns,
      limit: SWEEP_CONCURRENCY,
      operation: async (turn) => {
        await adopt(turn);
        return 1;
      },
    });
  };
  return { adopt, sweep };
};

/**
 * Adopt handed-over chat turns from this API task: a sweep every
 * `CHAT_TURN_ADOPTION_SWEEP_INTERVAL_MS`. Safe on every task at once: one
 * claim wins each turn. Answers the stop the server calls on shutdown, after
 * which this task adopts nothing more.
 */
export const startChatTurnAdopter = (): (() => void) => {
  const stopping = new AbortController();
  const adopter = createChatTurnAdopter({
    signal: stopping.signal,
    indexThread: upsertChatThreadSearchDocument,
  });
  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) {
      return;
    }
    sweeping = true;
    detached(async () => {
      const swept = await Result.tryPromise(async () => await adopter.sweep());
      sweeping = false;
      if (Result.isError(swept)) {
        observeFailure(swept.error, { sink: ADOPTION_SWEEP_FAILED });
      }
    }, "chat-turn-adopter.sweep");
  }, CHAT_TURN_ADOPTION_SWEEP_INTERVAL_MS);
  return () => {
    clearInterval(timer);
    stopping.abort();
  };
};
