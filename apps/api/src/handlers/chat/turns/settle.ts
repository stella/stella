import { panic, Result } from "better-result";

import type { ChatSendMode } from "@stll/anonymize-chat";
import { RESOURCE_TYPE, resourceRef } from "@stll/api-contract";
import {
  isHarnessChatToolCall,
  isServerChatToolCall,
} from "@stll/api-contract/chat";

import type { SafeDb } from "@/api/db/safe-db";
import {
  isChatPart,
  synchronizeToolResultContent,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import { finalizeAssistantTurn } from "@/api/handlers/chat/chat-message-persistence";
import {
  chatRefsWrittenIn,
  toolCallIdsOf,
} from "@/api/handlers/chat/chat-refs-shown";
import {
  type ChatToolCallOwnership,
  validateToolCallParts,
} from "@/api/handlers/chat/chat-schema";
import {
  type ChatTurnExecution,
  isChatTurnNotOwned,
} from "@/api/handlers/chat/chat-turn-persistence";
import type { ChatTurnStoredSettlement } from "@/api/handlers/chat/chat-turn-run";
import { CUT_SHORT_OUTCOME } from "@/api/handlers/chat/chat-turn-settlement";
import type { ChatTurnFailureCode } from "@/api/handlers/chat/chat-turn-state";
import { computeAssistantTurnWorkspaceIds } from "@/api/handlers/chat/data-scope";
import type { MessagePersistencePlan } from "@/api/handlers/chat/persist-message";
import type { StreamChatFinishEvent } from "@/api/handlers/chat/stream-chat";
import { resolveRegistryToolInputRefs } from "@/api/handlers/chat/tools/registry-adapter/input-ref-hydration";
import { resolveRegistryToolOutputRefs } from "@/api/handlers/chat/tools/registry-adapter/output-ref-resolution";
import type {
  ChatMessage,
  ChatPart,
  PersistableChatMessage,
} from "@/api/handlers/chat/types";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import type { ChatToolMap } from "@/api/lib/chat/chat-tool-types";
import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import {
  CHAT_REF_ENCODING,
  type ChatEntityRefContext,
  type ChatRefBinding,
  type ChatRefContext,
  type ChatUnresolvedInputRefContext,
} from "@/api/lib/chat/ref-token";
import type { ChatThreadNamesRead } from "@/api/lib/chat/thread-names";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type { upsertChatThreadSearchDocument } from "@/api/lib/search/index-chat";

/**
 * Everything storing a streamed turn's answer reads, as explicit inputs,
 * supplied by whoever owns the turn (today the request that started it,
 * `send-message.ts`), so the answer is validated, its refs resolved, the
 * thread's scope widened and the turn settled the same way whoever stores
 * it.
 */
export type StreamedTurnSettlementContext = {
  turn: {
    execution: ChatTurnExecution;
    threadId: SafeId<"chatThread">;
    userId: SafeId<"user">;
    /** The thread's matter; null for a chat outside one. */
    workspaceId: SafeId<"workspace"> | null;
    /** The stored answer the run continues; absent when it starts one. */
    owningAssistantMessage: PersistableChatMessage | undefined;
    /** Marks the thread as having used anonymization when it did. */
    sendMode: ChatSendMode | null;
  };
  /** The thread's messages the run continues, as stored or accepted. */
  history: {
    messages: PersistableChatMessage[];
    existingIds: Set<SafeId<"chatMessage">>;
  };
  /** The names the thread held once the turn's owner held it. */
  threadNames: ChatThreadNamesRead;
  refs: {
    /** The registry the run's stream resolved refs through. */
    registry: ChatRefRegistry;
    /** What the registry had observed when the run started. */
    observedBeforeRun: ReadonlySet<SafeId<"workspace">>;
    /** The member's usable matters; the answer's scope stays inside them. */
    accessibleWorkspaceIds: ReadonlySet<string>;
    /** Matters an agent's opaque tools could read, whatever they showed. */
    opaqueReadWorkspaceIds: readonly SafeId<"workspace">[];
  };
  /**
   * Whose tool calls the answer may carry. A cloud call is checked against
   * the registry tools the turn offered; a harness call against nothing the
   * registry describes.
   */
  toolCalls:
    | { ownership: Extract<ChatToolCallOwnership, "cloud">; tools: ChatToolMap }
    | { ownership: Extract<ChatToolCallOwnership, "harness"> };
  /** The member the turn is stored as. */
  member: { recordAuditEvent: AuditRecorder; safeDb: SafeDb };
  indexThread: typeof upsertChatThreadSearchDocument;
};

/** No registry tool describes a call a harness ran. */
const NO_REGISTRY_TOOLS: ChatToolMap = {};

/** Storing a streamed turn's answer failed; the turn is settled as failed. */
const STREAMED_TURN_NOT_STORED = failureSink({
  event: "chat.turn.persist_failed",
  expected: [],
});

/**
 * Why a streamed turn could not be persisted: the failure code its turn row
 * records and the error the stream reports to the client.
 */
export type AssistantTurnFailure = {
  code: ChatTurnFailureCode;
  error: HandlerError<500>;
};

/** What a stored, completed turn's follow-ups read. */
export type CompletedTurnFollowUps = {
  messagesAfterAssistantPersist: ReturnType<
    typeof applyAssistantPersistencePlan
  >;
  resolvedResponseMessage: ChatMessage;
};

/** What storing a streamed turn left, or why it could not be stored. */
export type StreamedTurnPersistence = Result<
  {
    followUps: CompletedTurnFollowUps | null;
    settlement: ChatTurnStoredSettlement;
  },
  AssistantTurnFailure
>;

/**
 * What a streamed turn's persistence left: nothing when another execution or
 * the reaper settled the turn first, the failure to report when storing
 * failed, else the stored outcome and, for a completed turn, what its
 * follow-ups read.
 */
const persistedTurnSettlement = ({
  messages,
  persistResult,
  resolvedResponseMessage,
  threadId,
}: {
  messages: ApplyAssistantPersistencePlanProps["messages"];
  persistResult: Awaited<ReturnType<typeof finalizeAssistantTurn>>;
  resolvedResponseMessage: ChatMessage;
  threadId: SafeId<"chatThread">;
}): StreamedTurnPersistence => {
  if (
    Result.isError(persistResult) &&
    isChatTurnNotOwned(persistResult.error)
  ) {
    // Another execution or the reaper settled the turn first: its outcome
    // stands, and this run has nothing left to store or count.
    return Result.ok({ followUps: null, settlement: { type: "not-owned" } });
  }
  if (Result.isError(persistResult)) {
    observeFailure(persistResult.error, {
      sink: STREAMED_TURN_NOT_STORED,
      ctx: { threadId },
    });
    return Result.err({
      code: "persistence",
      error: new HandlerError({
        status: 500,
        message: "Failed to persist assistant turn",
        cause: persistResult.error,
      }),
    });
  }
  const { outcome: storedOutcome, persistencePlan } = persistResult.value;
  return Result.ok({
    // A stop that won the race stored `cancelled`, whatever the run proposed.
    followUps:
      storedOutcome.type === "completed"
        ? {
            messagesAfterAssistantPersist: applyAssistantPersistencePlan({
              messages,
              persistencePlan,
            }),
            resolvedResponseMessage,
          }
        : null,
    settlement: { type: "stored", outcome: storedOutcome },
  });
};

type ApplyAssistantPersistencePlanProps = {
  messages: PersistableChatMessage[];
  persistencePlan: MessagePersistencePlan;
};

const applyAssistantPersistencePlan = ({
  messages,
  persistencePlan,
}: ApplyAssistantPersistencePlanProps): PersistableChatMessage[] | null => {
  switch (persistencePlan.type) {
    case "none":
      return null;
    case "insert":
      return [...messages, persistencePlan.message];
    case "update":
      return messages.map((message) =>
        message.id === persistencePlan.messageId
          ? persistencePlan.message
          : message,
      );
    case "replace-last-assistant":
      return [
        ...messages.filter(
          (message) => message.id !== persistencePlan.deleteMessageId,
        ),
        persistencePlan.insertMessage,
      ];
    default: {
      persistencePlan satisfies never;
      return panic(`Unhandled persistence plan: ${String(persistencePlan)}`);
    }
  }
};

type ResolveAssistantMessageRefsProps = {
  accessibleWorkspaceIds: ReadonlySet<string>;
  /** Whether the call records a server executor for its output. */
  isServerTool: (part: Extract<ChatPart, { type: "tool-call" }>) => boolean;
  messages: PersistableChatMessage[];
  opaqueReadWorkspaceIds: readonly SafeId<"workspace">[];
  refRegistry: ChatRefRegistry;
  workspaceIdsBeforeStream: ReadonlySet<SafeId<"workspace">>;
};

type ResolveAssistantMessageRefsResult = {
  messages: PersistableChatMessage[];
  /** The refs the messages showed the model. */
  refBindings: ChatRefBinding[];
  workspaceIds: SafeId<"workspace">[];
};

type ResolveAssistantPartRefsProps = {
  part: ChatMessage["parts"][number];
  entityContexts: ChatEntityRefContext[];
  unresolvedInputRefs: ChatUnresolvedInputRefContext[];
  refRegistry: ChatRefRegistry;
};

const resolveAssistantPartRefs = ({
  part,
  entityContexts,
  unresolvedInputRefs,
  refRegistry,
}: ResolveAssistantPartRefsProps): ChatMessage["parts"][number] => {
  // A harness call is stored as its harness reported it: its name only
  // collides with a registry tool's by chance, so no registry ref rule
  // applies to it.
  const withDeclaredToolRefs: unknown =
    part.type === "tool-call" && !isHarnessChatToolCall(part)
      ? {
          ...part,
          ...("input" in part
            ? {
                input: resolveRegistryToolInputRefs({
                  input: part.input,
                  onEntityRefResolved: (target) => {
                    entityContexts.push({
                      entity: resourceRef({
                        type: RESOURCE_TYPE.ENTITY,
                        id: target.entityId,
                      }),
                      toolCallId: part.id,
                      workspace: resourceRef({
                        type: RESOURCE_TYPE.WORKSPACE,
                        id: target.workspaceId,
                      }),
                    });
                  },
                  onRefUnresolved: (unresolved) => {
                    unresolvedInputRefs.push({
                      ...unresolved,
                      toolCallId: part.id,
                    });
                  },
                  refRegistry,
                  toolName: part.name,
                }),
              }
            : {}),
          ...("output" in part
            ? {
                output: resolveRegistryToolOutputRefs({
                  output: part.output,
                  refRegistry,
                  toolName: part.name,
                }),
              }
            : {}),
        }
      : part;
  const resolved = refRegistry.resolveAssistantValueRefs(withDeclaredToolRefs);
  if (!isChatPart(resolved)) {
    panic("Resolving assistant refs changed the message part shape");
  }
  return resolved;
};

const resolveAssistantMessageRefs = ({
  accessibleWorkspaceIds,
  isServerTool,
  messages,
  opaqueReadWorkspaceIds,
  refRegistry,
  workspaceIdsBeforeStream,
}: ResolveAssistantMessageRefsProps): ResolveAssistantMessageRefsResult => {
  const observedWorkspaceIdsAfterStream = refRegistry.getObservedWorkspaceIds();
  const turnWorkspaceIds = new Set<SafeId<"workspace">>();
  const refBindings: ChatRefBinding[] = [];

  const resolvedMessages = messages.map((message) => {
    if (message.role !== "assistant") {
      return message;
    }
    const entityContexts: ChatEntityRefContext[] = [];
    const unresolvedInputRefs: ChatUnresolvedInputRefContext[] = [];
    const resolvedParts = message.parts.map((part) =>
      resolveAssistantPartRefs({
        part,
        entityContexts,
        unresolvedInputRefs,
        refRegistry,
      }),
    );
    const parts = synchronizeToolResultContent(resolvedParts);
    const messageWorkspaceIds = computeAssistantTurnWorkspaceIds({
      accessibleWorkspaceIds,
      opaqueReadWorkspaceIds,
      observedWorkspaceIdsAfterStream,
      responseParts: parts,
      workspaceIdsBeforeStream,
    });
    for (const id of messageWorkspaceIds) {
      turnWorkspaceIds.add(id);
    }
    const shownRefBindings = refRegistry.collectRefBindings(
      chatRefsWrittenIn({ isServerTool, parts: message.parts }),
    );
    refBindings.push(...shownRefBindings);
    const refContext = {
      version: 2,
      refs: shownRefBindings,
      entities: entityContexts,
      unresolvedInputs: unresolvedInputRefs,
      workspaceScope: messageWorkspaceIds.map((id) =>
        resourceRef({ type: RESOURCE_TYPE.WORKSPACE, id }),
      ),
    } satisfies ChatRefContext;
    return {
      ...message,
      metadata: {
        ...message.metadata,
        refContext,
        refEncoding: CHAT_REF_ENCODING.PERSISTED_RESOURCE_REFS_V2,
      },
      parts,
    };
  });

  return {
    messages: resolvedMessages,
    refBindings,
    workspaceIds: [...turnWorkspaceIds],
  };
};

/**
 * Store a streamed turn's answer and settle the turn: validate its tool
 * calls as their owner's, resolve its refs, widen the thread's scope to
 * what it shows, and write message, scope and turn in one transaction. Every
 * expected failure comes back naming the turn row's failure code; nothing
 * here settles a failed turn, which is the `onFinish` boundary's job
 * (`settleStreamedAssistantTurn` in `send-message.ts`).
 */
export const persistStreamedTurn = async ({
  context: { history, indexThread, member, refs, threadNames, toolCalls, turn },
  event: { outcome, responseMessage },
}: {
  context: StreamedTurnSettlementContext;
  event: StreamChatFinishEvent;
}): Promise<StreamedTurnPersistence> => {
  const validatedToolParts = validateToolCallParts({
    allowPartialInput: CUT_SHORT_OUTCOME[outcome.type],
    allowDeferredServerInput: outcome.type === "awaiting-user",
    message: responseMessage,
    ownership: toolCalls.ownership,
    tools:
      toolCalls.ownership === "cloud" ? toolCalls.tools : NO_REGISTRY_TOOLS,
  });
  if (Result.isError(validatedToolParts)) {
    // Nothing of this turn can be stored.
    return Result.err({
      code: "persistence",
      error: new HandlerError({
        status: 500,
        message: "Generated chat tool parts are invalid",
        cause: validatedToolParts.error,
      }),
    });
  }
  const canonicalResponseMessage = toPersistableChatMessage({
    ...responseMessage,
    parts: validatedToolParts.value,
  });
  const resolved = resolveAssistantMessageRefs({
    accessibleWorkspaceIds: refs.accessibleWorkspaceIds,
    isServerTool: isServerChatToolCall,
    messages: [canonicalResponseMessage],
    opaqueReadWorkspaceIds: refs.opaqueReadWorkspaceIds,
    refRegistry: refs.registry,
    workspaceIdsBeforeStream: refs.observedBeforeRun,
  });
  const resolvedResponseMessage =
    resolved.messages.at(0) ?? panic("Missing chat response message");

  // Scope, message, and turn settlement are written in one transaction: if
  // widening the thread's data scope to the matters the answer shows fails,
  // nothing is stored. Storing matter content while the thread's
  // `data_workspace_ids` stays stale would leave it readable after the
  // member loses access to those matters.
  const persistResult = await finalizeAssistantTurn({
    acceptedSendMode: turn.sendMode,
    threadNames: {
      added: {
        refBindings: resolved.refBindings,
        toolCallIds: toolCallIdsOf(resolvedResponseMessage.parts),
      },
      read: threadNames,
    },
    dataScopeExpansion: { newWorkspaceIds: resolved.workspaceIds },
    existingIds: history.existingIds,
    execution: turn.execution,
    outcome,
    owningAssistantMessage: turn.owningAssistantMessage,
    recordAuditEvent: member.recordAuditEvent,
    responseMessage: resolvedResponseMessage,
    safeDb: member.safeDb,
    threadId: turn.threadId,
    userId: turn.userId,
    workspaceId: turn.workspaceId,
    indexThread,
  });
  return persistedTurnSettlement({
    messages: history.messages,
    persistResult,
    resolvedResponseMessage,
    threadId: turn.threadId,
  });
};
