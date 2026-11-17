import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { CHAT_RUN_TARGET_KIND } from "@stll/api-contract/chat-run-target";
import { mapWithConcurrency } from "@stll/concurrency";

import { sweepHandedOverChatTurns } from "@/api/db/root";
import { CHAT_TITLE_SOURCE, chatThreads } from "@/api/db/schema";
import {
  type AnswerQuoteChecker,
  createTurnAnswerQuoteChecker,
} from "@/api/handlers/chat/answer-quote-checks";
import { extractTitle } from "@/api/handlers/chat/chat-prompt";
import { createChatTurnBudget } from "@/api/handlers/chat/chat-turn-budget";
import { adoptHandedOverChatTurn } from "@/api/handlers/chat/chat-turn-persistence";
import {
  CHAT_TURN_BOUNDARY_MODE,
  type ChatTurnOwnership,
  ChatTurnRun,
  chatTurnRunBoundOf,
  type ChatTurnStoredSettlement,
} from "@/api/handlers/chat/chat-turn-run";
import type { ChatTurnFailureCode } from "@/api/handlers/chat/chat-turn-state";
import {
  knownDecisionPassageStamper,
  NO_DECISION_PASSAGE_NUMBERS,
} from "@/api/handlers/chat/decision-passage-numbers";
import { generateThreadTitle } from "@/api/handlers/chat/generate-thread-title";
import { adoptChatLocalRun } from "@/api/handlers/chat/local-run-plan";
import { createSteeredQueue } from "@/api/handlers/chat/queue/steered-message";
import { markChatCompactionDue } from "@/api/handlers/chat/send-message-compaction";
import {
  produceChatTurn,
  type StreamChatFinishEvent,
} from "@/api/handlers/chat/stream-chat";
import { resolveRegistryToolInputRefs } from "@/api/handlers/chat/tools/registry-adapter/input-ref-hydration";
import { resolveRegistryToolOutputRefs } from "@/api/handlers/chat/tools/registry-adapter/output-ref-resolution";
import {
  type CompletedTurnFollowUps,
  loadStoredTurnSettlement,
  persistStreamedTurn,
  type StreamedTurnSettlementContext,
} from "@/api/handlers/chat/turns/settle";
import { createVisualResourceOrigin } from "@/api/handlers/visual-sandbox/resource-origin";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { detached } from "@/api/lib/analytics/capture";
import type { SessionMemberCaller } from "@/api/lib/auth/member-caller";
import { resolveEffectiveChatModelSelection } from "@/api/lib/chat-model-selection";
import { answerChatTurnAdopterDoorbell } from "@/api/lib/chat/chat-turn-handover-doorbell";
import { createContextNoticeStamp } from "@/api/lib/chat/context-notice";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { resolveServerStartedMember } from "@/api/lib/chat/server-started-member";
import type { HandedOverChatTurn } from "@/api/lib/db/chat-turn-handover-system";
import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import type { DesktopRunnerRunBell } from "@/api/lib/desktop-runner/doorbell";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
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
/** A completed adopted turn's follow-ups failed; the turn stays settled. */
const ADOPTED_TURN_FOLLOW_UPS_FAILED = failureSink({
  event: "chat.turn.adopted_follow_ups_failed",
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
  /** The case-law reads the answer's quote check makes; the shared ones by default. */
  caseLawDb?: Parameters<typeof createTurnAnswerQuoteChecker>[0]["caseLawDb"];
  /** What a completed turn runs after it settled; the send path's own by default. */
  followUps?: AdoptedTurnFollowUpSteps | undefined;
  /** The answer's quote check; built from `caseLawDb` by default. */
  answerQuoteChecker?: AnswerQuoteChecker | undefined;
};

/** The steps a completed turn's follow-ups take, as the send path takes them. */
type AdoptedTurnFollowUpSteps = {
  markCompactionDue: typeof markChatCompactionDue;
  generateTitle: typeof generateThreadTitle;
};

const ADOPTED_TURN_FOLLOW_UP_STEPS = {
  markCompactionDue: markChatCompactionDue,
  generateTitle: generateThreadTitle,
} as const satisfies AdoptedTurnFollowUpSteps;

/**
 * What a completed turn runs once settled, for a turn a task adopted, as the
 * send that started it would have (`runCompletedTurnFollowUps`), from the
 * turn's rows instead of that send's request: compaction marked due when the
 * thread's window crosses its trigger, and a title for a thread this turn
 * opened. Neither touches the settled turn; an anonymized turn runs neither.
 */
const runAdoptedTurnFollowUps = async ({
  caller,
  context,
  followUps: { messagesAfterAssistantPersist, resolvedResponseMessage },
  indexThread,
  modelTier,
  run,
  steps,
}: {
  caller: SessionMemberCaller;
  context: StreamedTurnSettlementContext;
  followUps: CompletedTurnFollowUps;
  indexThread: ChatTurnAdoptionDependencies["indexThread"];
  modelTier: Parameters<typeof markChatCompactionDue>[0]["modelTier"];
  run: ChatTurnRun;
  steps: AdoptedTurnFollowUpSteps;
}): Promise<void> => {
  const { threadId, userId, workspaceId } = context.turn;
  // A send refuses outright while the organization's AI settings cannot be
  // read; the follow-ups' model choices depend on them the same way.
  if (
    context.turn.sendMode === CHAT_SEND_MODE.anonymized ||
    caller.orgAIConfigStatus === ORG_AI_CONFIG_STATUS.unreadable
  ) {
    return;
  }
  const read = await caller.safeDb(async (tx) =>
    (
      await tx
        .select({
          chatModel: chatThreads.chatModel,
          chatReasoningEffort: chatThreads.chatReasoningEffort,
          titleSource: chatThreads.titleSource,
        })
        .from(chatThreads)
        .where(eq(chatThreads.id, threadId))
        .limit(1)
    ).at(0),
  );
  if (Result.isError(read)) {
    observeFailure(read.error, {
      sink: ADOPTED_TURN_FOLLOW_UPS_FAILED,
      ctx: { threadId },
    });
    return;
  }
  const thread = read.value;
  // A thread deleted since the turn settled needs neither.
  if (thread === undefined) {
    return;
  }
  if (messagesAfterAssistantPersist !== null) {
    await steps.markCompactionDue({
      chatModelOverride: resolveEffectiveChatModelSelection({
        devModelId: undefined,
        threadChatModel: thread.chatModel,
        threadReasoningEffort: thread.chatReasoningEffort,
        orgAIConfig: caller.orgAIConfig,
      }).modelId,
      messages: messagesAfterAssistantPersist,
      modelTier,
      organizationId: caller.session.activeOrganizationId,
      orgAIConfig: caller.orgAIConfig,
      safeDb: caller.safeDb,
      threadId,
    });
  }
  // The send that opened the thread titles it once its first turn
  // completes; the first turn is the only member's message so far.
  const asked = context.history.messages.filter(({ role }) => role === "user");
  const [opening] = asked;
  if (
    asked.length !== 1 ||
    opening === undefined ||
    thread.titleSource !== CHAT_TITLE_SOURCE.DEFAULT
  ) {
    return;
  }
  const title = async () =>
    await steps.generateTitle({
      indexThread,
      initialTitle: extractTitle(opening.parts),
      messages: [opening, resolvedResponseMessage],
      organizationId: caller.session.activeOrganizationId,
      orgAIConfig: caller.orgAIConfig,
      managedAIResidency: caller.managedAIResidency,
      promptCachingEnabled: caller.promptCachingEnabled,
      recordAuditEvent: caller.recordAuditEvent,
      safeDb: caller.safeDb,
      organizationStateDb: caller.scopedDb,
      threadId,
      threadWorkspaceId: workspaceId,
      userId,
    });
  detached(
    async () => run.followUpAfterSettlement(title),
    "chat-turn-adopter.generate-thread-title",
  );
};

/**
 * Why a task did not take a handed-over turn it was rung or swept for. None
 * leaves the turn adoptable for ever: one never claimed waits for another
 * task, or this one's next sweep, until its adopt-by, and one claimed but
 * not readable keeps a run lease nothing renews; either way the reaper then
 * ends it as `owner-lost`, as it ends a turn whose owner vanished.
 */
type ChatTurnAdoptionSkip =
  /** This task is stopping; it adopts nothing more. */
  | "adopter-stopping"
  /** The member could not be proved again (an outage). */
  | "member-unresolved"
  /** The member may no longer act in the organization. */
  | "member-unavailable"
  /** No slot of the member's could be held. */
  | "admission-refused"
  /** The claim could not be written. */
  | "claim-failed"
  /** Another task took it, it ended, or its adopt-by passed. */
  | "not-handed-over"
  /** Claimed, then its stored settlement could not be read. */
  | "settlement-unreadable"
  /** Claimed, then the member could no longer see its thread. */
  | "thread-unavailable"
  /** Claimed, then the answer it was released with was not found. */
  | "checkpoint-missing"
  /** Claimed, then its run on the computer could not be read. */
  | "local-run-unreadable"
  /** Claimed, then the member had no run on a computer for it. */
  | "local-run-missing"
  /** Claimed, then the member could no longer run turns on a computer. */
  | "computer-unavailable";

/**
 * How loudly a skip is traced: the ones every task but the winner meets, or
 * a stopping task meets, are routine; the rest end the turn as `owner-lost`
 * unless another task fares better.
 */
const ADOPTION_SKIP_LEVEL = {
  "adopter-stopping": "info",
  "member-unresolved": "warn",
  "member-unavailable": "warn",
  "admission-refused": "warn",
  "claim-failed": "warn",
  "not-handed-over": "info",
  "settlement-unreadable": "warn",
  "thread-unavailable": "warn",
  "checkpoint-missing": "warn",
  "local-run-unreadable": "warn",
  "local-run-missing": "warn",
  "computer-unavailable": "warn",
} as const satisfies Record<ChatTurnAdoptionSkip, "info" | "warn">;

/** The trace every skipped adoption leaves. */
export const CHAT_TURN_ADOPTION_SKIPPED_EVENT = "chat.turn.adoption_skipped";

/** What one attempt did: this task runs the turn now, or it says why not. */
type ChatTurnAdoptionOutcome =
  { type: "adopted" } | { type: "skipped"; reason: ChatTurnAdoptionSkip };

const skipped = (reason: ChatTurnAdoptionSkip) =>
  ({ type: "skipped", reason }) satisfies ChatTurnAdoptionOutcome;

/** Store the turn as failed because its answer could not be stored. */
const failInstead = async ({
  context,
  failure,
  run,
}: {
  context: StreamedTurnSettlementContext;
  failure: { code: ChatTurnFailureCode; error: unknown };
  run: ChatTurnRun;
}): Promise<ChatTurnStoredSettlement> => {
  observeFailure(failure.error, {
    sink: ADOPTED_TURN_NOT_STORED,
    ctx: { threadId: context.turn.threadId },
  });
  await run.fail(failure.code, true);
  return { type: "failed-instead" };
};

/**
 * Store an adopted turn's finished answer, as the member's turn, and run a
 * completed turn's follow-ups (`runAdoptedTurnFollowUps`). No response waits
 * on it, so nothing is thrown: a turn whose answer cannot be stored is
 * stored as failed by its run, and the run is told so.
 */
const settleAdoptedTurn = async ({
  context,
  event,
  run,
  runFollowUps,
}: {
  context: StreamedTurnSettlementContext;
  event: StreamChatFinishEvent;
  run: ChatTurnRun;
  runFollowUps: (followUps: CompletedTurnFollowUps) => Promise<void>;
}): Promise<ChatTurnStoredSettlement> => {
  const persisted = await Result.tryPromise(
    async () => await persistStreamedTurn({ context, event }),
  );
  if (Result.isError(persisted)) {
    return await failInstead({
      context,
      failure: { code: "internal", error: persisted.error },
      run,
    });
  }
  const stored = persisted.value;
  if (Result.isError(stored)) {
    return await failInstead({ context, failure: stored.error, run });
  }
  const { followUps, settlement } = stored.value;
  if (followUps !== null) {
    const followedUp = await Result.tryPromise(
      async () => await runFollowUps(followUps),
    );
    if (Result.isError(followedUp)) {
      observeFailure(followedUp.error, {
        sink: ADOPTED_TURN_FOLLOW_UPS_FAILED,
        ctx: { threadId: context.turn.threadId },
      });
    }
  }
  return settlement;
};

/**
 * Prove the turn's member again, hold a slot of theirs and claim the turn:
 * the steps before which this task holds nothing of the turn's.
 */
const claimHandedOverTurn = async ({
  dependencies,
  turn: { organizationId, threadId, turnId, userId },
}: {
  dependencies: ChatTurnAdoptionDependencies;
  turn: HandedOverChatTurn;
}) => {
  if (dependencies.signal.aborted) {
    return skipped("adopter-stopping");
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
    return skipped("member-unresolved");
  }
  if (member.value.type === "unavailable") {
    return skipped("member-unavailable");
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
    return skipped("admission-refused");
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
      return skipped("claim-failed");
    }
    return skipped("not-handed-over");
  }
  return {
    type: "claimed",
    adopted: claimed.value,
    admission: admission.value,
    caller,
  } as const;
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
 * its run lease, which nothing renews, with the same end. Every skip says
 * why (`ChatTurnAdoptionSkip`); the caller traces it.
 */
const adoptChatTurn = async ({
  dependencies,
  turn,
}: {
  dependencies: ChatTurnAdoptionDependencies;
  turn: HandedOverChatTurn;
}): Promise<ChatTurnAdoptionOutcome> => {
  const { organizationId, threadId, turnId, userId } = turn;
  const claim = await claimHandedOverTurn({ dependencies, turn });
  if (claim.type === "skipped") {
    return claim;
  }
  const { adopted, admission, caller } = claim;
  const leaveToLease = async (
    reason: ChatTurnAdoptionSkip,
    failure?: { step: string; error: unknown },
  ) => {
    if (failure !== undefined) {
      observeFailure(failure.error, {
        sink: ADOPTION_FAILED,
        ctx: { step: failure.step, threadId },
      });
    }
    await admission.release();
    return skipped(reason);
  };
  const loaded = await loadStoredTurnSettlement({
    caseLawDb: dependencies.caseLawDb,
    checkpointMessageId: adopted.checkpointMessageId,
    createRefRegistry: createChatRefRegistry,
    execution: adopted.execution,
    indexThread: dependencies.indexThread,
    member: caller,
    threadId,
  });
  if (Result.isError(loaded)) {
    return await leaveToLease("settlement-unreadable", {
      step: "load",
      error: loaded.error,
    });
  }
  if (loaded.value.type !== "loaded") {
    return await leaveToLease(loaded.value.type);
  }
  const { context } = loaded.value;
  const checkpoint = context.turn.owningAssistantMessage;
  const adoptedRun = await adoptChatLocalRun({
    chatThreadId: threadId,
    chatTurnId: turnId,
    featureAccessSnapshot: caller.featureAccessSnapshot,
    organizationId,
    ...(dependencies.runtime === undefined
      ? {}
      : { runtime: dependencies.runtime }),
    // The adopted run's steer reports settle the queued messages it was
    // handed, as the starting task's would have.
    steeredQueue: createSteeredQueue({
      organizationId,
      recordAuditEvent: caller.recordAuditEvent,
      safeDb: caller.safeDb,
      threadId,
      userId,
    }),
    userId,
    workspaceIds: context.refs.opaqueReadWorkspaceIds,
  });
  if (Result.isError(adoptedRun)) {
    return await leaveToLease("local-run-unreadable", {
      step: "local-run",
      error: adoptedRun.error,
    });
  }
  if (adoptedRun.value.type !== "adopted") {
    return await leaveToLease(
      adoptedRun.value.type === "no-run"
        ? "local-run-missing"
        : "computer-unavailable",
    );
  }
  const localRun = adoptedRun.value.run;
  // Apps the released read showed are in the stored answer; the origin
  // accepts them again when the turn is stored, and mints the rest.
  const visualOrigin = createVisualResourceOrigin({
    persistedParts: checkpoint.parts,
  });
  const run = new ChatTurnRun({
    ownership: dependencies.ownership,
    admission,
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
      handOverSignal: run.control.handOverSignal,
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
    // The released read's answer is this turn's; the adopted read ends it.
    answerSoFar: "released",
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
    answerQuoteChecker:
      dependencies.answerQuoteChecker ??
      createTurnAnswerQuoteChecker({ caseLawDb: dependencies.caseLawDb }),
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
    onFinish: async (event) =>
      await settleAdoptedTurn({
        context,
        event,
        run,
        runFollowUps: async (followUps) =>
          await runAdoptedTurnFollowUps({
            caller,
            context,
            followUps,
            indexThread: dependencies.indexThread,
            modelTier: admission.modelAdmission.modelTier,
            run,
            steps: dependencies.followUps ?? ADOPTED_TURN_FOLLOW_UP_STEPS,
          }),
      }),
  });
  await run.pump(production.output, production.durability);
  return { type: "adopted" };
};

/**
 * This process's adopter: adopts a rung turn at most once at a time here
 * (another task adopting the same turn loses the claim), and sweeps for
 * turns whose ring was lost.
 */
export const createChatTurnAdopter = (
  dependencies: ChatTurnAdoptionDependencies,
) => {
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
      return;
    }
    if (adopted.value.type === "skipped") {
      const { reason } = adopted.value;
      logger[ADOPTION_SKIP_LEVEL[reason]](CHAT_TURN_ADOPTION_SKIPPED_EVENT, {
        organizationId: turn.organizationId,
        reason,
        threadId: turn.threadId,
        turnId: turn.turnId,
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
 * Adopt handed-over chat turns from this API task: each one a stopping task
 * rings for (`ringChatTurnAdopters`), and a sweep every
 * `CHAT_TURN_ADOPTION_SWEEP_INTERVAL_MS` for those whose ring was lost. Safe
 * on every task at once: one claim wins each turn. Answers the stop the
 * server calls on shutdown, after which this task adopts nothing more.
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
  const stopAnswering = answerChatTurnAdopterDoorbell((turn) => {
    detached(async () => await adopter.adopt(turn), "chat-turn-adopter.ring");
  });
  return () => {
    stopAnswering();
    clearInterval(timer);
    stopping.abort();
  };
};
