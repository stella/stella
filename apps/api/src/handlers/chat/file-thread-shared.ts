import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { ReasoningEffort } from "@stll/ai-catalog";

import type { Transaction } from "@/api/db/root";
import type { SafeDbError } from "@/api/db/safe-db";
import {
  CHAT_THREAD_TITLE_MAX_LENGTH,
  chatThreads,
  fileChatThreads,
} from "@/api/db/schema";
import { estimateChatContextPromptTokens } from "@/api/handlers/chat/chat-prompt";
import { computeThreadContextUsage } from "@/api/handlers/chat/compaction";
import type { ThreadContextUsage } from "@/api/handlers/chat/compaction";
import type {
  FileThreadLookupInput,
  FileThreadMetadata,
} from "@/api/handlers/chat/file-thread-mapping";
import { loadWindowedThreadMessages } from "@/api/handlers/chat/history-window";
import type { ClientMessage } from "@/api/handlers/chat/message-page";
import { loadChatMessagePage } from "@/api/handlers/chat/message-page";
import { readLatestChatCompactionOnTx } from "@/api/handlers/chat/persistent-compaction";
import {
  areSubagentToolsRegistered,
  isWebSearchAvailable,
} from "@/api/handlers/chat/tools/chat-tools";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { resolveEffectiveChatModelId } from "@/api/lib/chat-model-selection";
import { resolveChatCompactionBudget } from "@/api/lib/chat/compaction-budget";
import { getDisabledNativeToolSlugsFromSettingsRow } from "@/api/lib/mcp-connectors/catalog-metadata";
import { resolveWebSearchProvidersFromOrgSettingsRow } from "@/api/lib/web-search/load-org-keys";

/**
 * Shared read helpers for the two file-thread endpoints: the read-only
 * `GET .../file-thread` a document open issues, and the materializing
 * `POST .../file-thread` that runs once, on the first message sent into a
 * file's chat. Extracted here so the read path can reuse the exact message
 * page/loading semantics of the resolve path without importing from an
 * endpoint module.
 */

/**
 * Unwrap a read helper's Result when it ran on this handler's shared `tx`:
 * with `tx`, the helper's `withScopedTx` never produces an error Result — a
 * failure throws and is caught by this transaction's own `safeDb` catch-all,
 * so an error Result here would mean that invariant broke. Mirrors
 * `get-messages.ts`'s identically-named helper.
 */
const unwrapTxRead = <T>(result: Result<T, SafeDbError>): T =>
  Result.isError(result)
    ? panic("File-thread tx-scoped read unexpectedly returned an error Result")
    : result.value;

/**
 * Thread columns needed to load its initial message page. Fetched inline
 * alongside the thread-identity lookups (a join / widened select, not a
 * separate query) so resolving a message page never costs more than the
 * lookup that would have run anyway.
 */
export type ThreadMetadata = {
  chatModel: string | null;
  chatReasoningEffort: ReasoningEffort | null;
  contextMatterIds: SafeId<"workspace">[];
  usedAnonymization: boolean;
  webSearchEnabled: boolean;
};

/**
 * Same shape `GET /chat/threads/:id/messages` returns for its initial page
 * (see `get-messages.ts`), including `webSearchAvailable`: resolved once per
 * transaction by `loadWebSearchAvailable` below (mirroring
 * `get-messages.ts`'s widened `organizationSettings` select) and threaded
 * into every branch that builds this page, so the frontend's
 * `fileChatThreadOptions` seed never has to guess the org-wide flag.
 */
export type FileThreadMessagePage = {
  messages: ClientMessage[];
  olderCursor: string | null;
  contextMatterIds: SafeId<"workspace">[];
  lastActivityAt: string | null;
  usedAnonymization: boolean;
  webSearchAvailable: boolean;
  webSearchEnabled: boolean;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  context: ThreadContextUsage | null;
};

/** The message page for a thread that does not exist yet (or was created in
 *  this same tx and so cannot have messages). */
export const emptyMessagePage = (
  webSearchAvailable: boolean,
): FileThreadMessagePage => ({
  messages: [],
  olderCursor: null,
  contextMatterIds: [],
  lastActivityAt: null,
  usedAnonymization: false,
  webSearchAvailable,
  webSearchEnabled: false,
  model: null,
  reasoningEffort: null,
  context: null,
});

/**
 * Organization-wide web-search availability: an org key (or the platform
 * fallback) resolves to a provider, and the org has not disabled the
 * `web_search` native tool for its practice jurisdictions. Mirrors
 * `get-messages.ts`'s widened `organizationSettings` select and helper
 * chain (`getDisabledNativeToolSlugs` +
 * `resolveWebSearchProvidersFromOrgSettingsRow` + `isWebSearchAvailable`)
 * exactly, run once per transaction on the handler's already-open `tx` so
 * it costs one extra round-trip, not a second GET after the thread resolves.
 */
export const loadWebSearchAvailable = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
): Promise<boolean> => {
  const orgSettingsForChat = await tx.query.organizationSettings.findFirst({
    where: {
      organizationId: { eq: organizationId },
    },
    columns: {
      practiceJurisdictions: true,
      nativeToolOverrides: true,
      webSearchApiKeyEncrypted: true,
      webSearchApiKeyIv: true,
      urlFetchApiKeyEncrypted: true,
      urlFetchApiKeyIv: true,
    },
  });
  const disabledNativeToolSlugs =
    getDisabledNativeToolSlugsFromSettingsRow(orgSettingsForChat);
  const { webSearchProvider } =
    await resolveWebSearchProvidersFromOrgSettingsRow(
      organizationId,
      orgSettingsForChat,
    );

  return isWebSearchAvailable({
    webSearchProviderAvailable: webSearchProvider !== null,
    disabledNativeToolSlugs,
  });
};

type LoadResolvedThreadMessagePageArgs = ThreadMetadata & {
  tx: Transaction;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  orgAIConfig: OrgAIConfig | null;
  webSearchAvailable: boolean;
};

/**
 * Loads the same initial message page `get-messages.ts` loads, reusing its
 * exact helpers on the handler's already-open `tx` so the reads share one
 * `set_config` instead of paying for a second round-trip GET.
 * `webSearchAvailable` is resolved once per transaction by
 * `loadWebSearchAvailable` and passed in so the context-usage estimate's
 * `webResearch` gate mirrors `get-messages.ts`'s (provider availability AND
 * the thread's opt-in), not a hardcoded false.
 */
export const loadResolvedThreadMessagePage = async ({
  tx,
  threadId,
  userId,
  organizationId,
  orgAIConfig,
  contextMatterIds,
  chatModel,
  chatReasoningEffort,
  usedAnonymization,
  webSearchAvailable,
  webSearchEnabled,
}: LoadResolvedThreadMessagePageArgs): Promise<FileThreadMessagePage> => {
  const page = unwrapTxRead(
    await loadChatMessagePage({ tx, threadId, userId }),
  );

  const checkpoint = await readLatestChatCompactionOnTx({ threadId, tx });
  const windowedMessages = unwrapTxRead(
    await loadWindowedThreadMessages({
      tx,
      threadId,
      checkpoint,
    }),
  );

  const hasContext = windowedMessages.length > 0 || checkpoint !== null;
  const { promptTokens, toolTokens } = estimateChatContextPromptTokens({
    toolAvailability: {
      docxEditMode: null,
      templateAuthoring: false,
      webResearch: webSearchAvailable && webSearchEnabled,
      folioAgentDocTools: false,
      subagents: areSubagentToolsRegistered({ delegationDepth: 0 }),
    },
  });
  // Without the thread's model override, the budget falls back to the org's
  // chat-role default context window even when the thread is pinned to a
  // model with a different one, so the estimate (and its compaction trigger)
  // can be wrong for the model this thread will actually send with.
  const chatModelOverride = resolveEffectiveChatModelId({
    devModelId: undefined,
    threadChatModel: chatModel,
    orgAIConfig,
  });
  const { triggerTokens } = resolveChatCompactionBudget({
    chatModelOverride,
    orgAIConfig,
    organizationId,
  });
  const context: ThreadContextUsage | null = hasContext
    ? computeThreadContextUsage({
        messages: windowedMessages.map((message) => ({
          id: message.id,
          role: message.role,
          parts: message.content.data,
        })),
        promptTokens,
        toolTokens,
        triggerTokens,
        summary: checkpoint
          ? {
              summarizedMessageCount: checkpoint.summarizedMessageCount,
              summaryMarkdown: checkpoint.summaryMarkdown,
            }
          : null,
      })
    : null;

  return {
    messages: page.messages,
    olderCursor: page.olderCursor,
    contextMatterIds,
    lastActivityAt: page.lastActivityAt,
    usedAnonymization,
    webSearchAvailable,
    webSearchEnabled,
    model: chatModel,
    reasoningEffort: chatReasoningEffort,
    context,
  };
};

export type FileThreadCreateResult =
  | {
      ok: true;
      chatThreadId: SafeId<"chatThread">;
      messagePage: FileThreadMessagePage;
    }
  | {
      ok: false;
      message: string;
      status: 404 | 409;
    };

const insertFileChatThread = async (
  tx: Transaction,
  {
    entityId,
    fieldId,
    organizationId,
    userId,
    workspaceId,
  }: FileThreadLookupInput,
  chatThreadId: SafeId<"chatThread">,
  recordAuditEvent: AuditRecorder,
): Promise<void> => {
  const fileChatThreadId = createSafeId<"fileChatThread">();
  await tx.insert(fileChatThreads).values({
    id: fileChatThreadId,
    organizationId,
    workspaceId,
    userId,
    entityId,
    fieldId,
    chatThreadId,
  });
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
    resourceId: chatThreadId,
    workspaceId,
    metadata: { entityId, fieldId, fileChatThreadId },
  });
};

/**
 * Materialize the thread + file mapping for a first send. Lives here (not in
 * the endpoint module) so the placeholder-adoption and legacy branches stay
 * integration-testable against a real transaction.
 */
export const createFileChatThread = async (
  tx: Transaction,
  {
    entityId,
    fieldId,
    organizationId,
    userId,
    workspaceId,
  }: FileThreadLookupInput,
  recordAuditEvent: AuditRecorder,
  orgAIConfig: OrgAIConfig | null,
  webSearchAvailable: boolean,
  requestedThreadId: SafeId<"chatThread"> | undefined,
): Promise<FileThreadCreateResult> => {
  const entity = await tx.query.entities.findFirst({
    where: {
      id: { eq: entityId },
      workspaceId: { eq: workspaceId },
    },
    columns: {
      id: true,
    },
    with: {
      currentVersion: {
        columns: {},
        with: {
          fields: {
            columns: {
              content: true,
              id: true,
            },
          },
        },
      },
    },
  });

  const field = entity?.currentVersion?.fields.find(
    (candidate) => candidate.id === fieldId,
  );
  const content = field?.content;

  if (content?.type !== "file") {
    return {
      ok: false,
      status: 404,
      message: "File not found",
    };
  }

  const fieldKeyedThread = await findFieldKeyedChatThread(tx, {
    entityId,
    fieldId,
    organizationId,
    userId,
    workspaceId,
  });

  if (fieldKeyedThread) {
    await insertFileChatThread(
      tx,
      {
        entityId,
        fieldId,
        organizationId,
        userId,
        workspaceId,
      },
      fieldKeyedThread.id,
      recordAuditEvent,
    );

    // A field-keyed thread predates this handler's file/entity mapping, so it
    // may already carry real message history — load its initial page rather
    // than assuming empty, same as the `existing` branch in the caller.
    const messagePage = await loadResolvedThreadMessagePage({
      tx,
      threadId: fieldKeyedThread.id,
      userId,
      organizationId,
      orgAIConfig,
      webSearchAvailable,
      chatModel: fieldKeyedThread.chatModel,
      chatReasoningEffort: fieldKeyedThread.chatReasoningEffort,
      contextMatterIds: fieldKeyedThread.contextMatterIds,
      usedAnonymization: fieldKeyedThread.usedAnonymization,
      webSearchEnabled: fieldKeyedThread.webSearchEnabled,
    });

    return {
      ok: true,
      chatThreadId: fieldKeyedThread.id,
      messagePage,
    };
  }

  const chatThreadId = requestedThreadId ?? createSafeId<"chatThread">();

  // Pre-send settings changes (model picker, web-search toggle) upsert a
  // placeholder chatThreads row under the client draft id before this
  // materialization runs. Adopt only a same-owner, same-workspace placeholder
  // instead of colliding with it; any other occupant of the id is a client
  // bug and must never be retitled or mapped onto this file.
  if (requestedThreadId) {
    const occupant = await tx.query.chatThreads.findFirst({
      where: { id: { eq: requestedThreadId } },
      columns: {
        id: true,
        userId: true,
        organizationId: true,
        workspaceId: true,
        chatModel: true,
        chatReasoningEffort: true,
        contextMatterIds: true,
        usedAnonymization: true,
        webSearchEnabled: true,
      },
    });
    if (occupant) {
      if (
        occupant.userId !== userId ||
        occupant.organizationId !== organizationId ||
        occupant.workspaceId !== workspaceId
      ) {
        return {
          ok: false,
          status: 409,
          message: "Thread id already in use",
        };
      }
      await tx
        .update(chatThreads)
        .set({
          title: content.fileName.slice(0, CHAT_THREAD_TITLE_MAX_LENGTH),
        })
        .where(eq(chatThreads.id, occupant.id));
      await insertFileChatThread(
        tx,
        { entityId, fieldId, organizationId, userId, workspaceId },
        occupant.id,
        recordAuditEvent,
      );
      // The placeholder carries the user's pre-send settings; surface them
      // the same way the resolve handler's `existing` branch does.
      const messagePage = await loadResolvedThreadMessagePage({
        tx,
        threadId: occupant.id,
        userId,
        organizationId,
        orgAIConfig,
        webSearchAvailable,
        chatModel: occupant.chatModel,
        chatReasoningEffort: occupant.chatReasoningEffort,
        contextMatterIds: occupant.contextMatterIds,
        usedAnonymization: occupant.usedAnonymization,
        webSearchEnabled: occupant.webSearchEnabled,
      });
      return {
        ok: true,
        chatThreadId: occupant.id,
        messagePage,
      };
    }
  }

  await tx.insert(chatThreads).values({
    id: chatThreadId,
    organizationId,
    title: content.fileName.slice(0, CHAT_THREAD_TITLE_MAX_LENGTH),
    userId,
    workspaceId,
    contextMatterIds: [],
    dataWorkspaceIds: [workspaceId],
  });

  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.CREATE,
    resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
    resourceId: chatThreadId,
    workspaceId,
    metadata: { entityId, fieldId, source: "resolve-file-thread" },
  });

  await insertFileChatThread(
    tx,
    {
      entityId,
      fieldId,
      organizationId,
      userId,
      workspaceId,
    },
    chatThreadId,
    recordAuditEvent,
  );

  // Brand-new thread just inserted above in this same tx — it cannot have
  // messages yet, so skip the message-page read entirely instead of
  // querying a thread nothing has ever written to.
  return {
    ok: true,
    chatThreadId,
    messagePage: emptyMessagePage(webSearchAvailable),
  };
};

export const findFieldKeyedChatThread = async (
  tx: Transaction,
  { fieldId, organizationId, userId, workspaceId }: FileThreadLookupInput,
): Promise<FileThreadMetadata | undefined> =>
  (
    await tx
      .select({
        id: chatThreads.id,
        chatModel: chatThreads.chatModel,
        chatReasoningEffort: chatThreads.chatReasoningEffort,
        contextMatterIds: chatThreads.contextMatterIds,
        usedAnonymization: chatThreads.usedAnonymization,
        webSearchEnabled: chatThreads.webSearchEnabled,
      })
      .from(chatThreads)
      .where(
        and(
          sql`${chatThreads.id} = ${fieldId}`,
          eq(chatThreads.organizationId, organizationId),
          eq(chatThreads.userId, userId),
          eq(chatThreads.workspaceId, workspaceId),
        ),
      )
      .limit(1)
  ).at(0);
