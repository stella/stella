import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDbError, Transaction } from "@/api/db";
import { chatThreads, fileChatThreads } from "@/api/db/schema";
import { estimateChatContextPromptTokens } from "@/api/handlers/chat/chat-prompt";
import { computeThreadContextUsage } from "@/api/handlers/chat/compaction";
import type { ThreadContextUsage } from "@/api/handlers/chat/compaction";
import { resolveChatCompactionBudget } from "@/api/handlers/chat/compaction-budget";
import { loadWindowedThreadMessages } from "@/api/handlers/chat/history-window";
import type { ClientMessage } from "@/api/handlers/chat/message-page";
import { loadChatMessagePage } from "@/api/handlers/chat/message-page";
import { readLatestChatCompactionOnTx } from "@/api/handlers/chat/persistent-compaction";
import {
  areSubagentToolsRegistered,
  isWebSearchAvailable,
} from "@/api/handlers/chat/tools/chat-tools";
import { getDisabledNativeToolSlugsFromSettingsRow } from "@/api/handlers/mcp-connectors/catalog-metadata";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { PG_ERROR } from "@/api/lib/pg-error";
import { resolveWebSearchProvidersFromOrgSettingsRow } from "@/api/lib/web-search/load-org-keys";

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

const resolveFileThreadBodySchema = t.Object({
  entityId: tSafeId("entity"),
  fieldId: tSafeId("field"),
});

const config = {
  permissions: { chat: ["create"] },
  mcp: { type: "internal", reason: "assistant_chat" },
  body: resolveFileThreadBodySchema,
} satisfies HandlerConfig;

const CHAT_THREAD_TITLE_MAX_LENGTH = 255;

type FileThreadLookupInput = {
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

/**
 * Thread columns needed to load its initial message page. Fetched inline
 * alongside the thread-identity lookups below (a join / widened select, not
 * a separate query) so resolving a message page never costs more than the
 * lookup that would have run anyway.
 */
type ThreadMetadata = {
  chatModel: string | null;
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
type ResolveFileThreadMessagePage = {
  messages: ClientMessage[];
  olderCursor: string | null;
  contextMatterIds: SafeId<"workspace">[];
  lastActivityAt: string | null;
  webSearchAvailable: boolean;
  webSearchEnabled: boolean;
  model: string | null;
  context: ThreadContextUsage | null;
};

type ResolveFileThreadTxResult =
  | {
      ok: true;
      chatThreadId: SafeId<"chatThread">;
      messagePage: ResolveFileThreadMessagePage;
    }
  | {
      ok: false;
      message: string;
      status: 404;
    };

/** A thread just inserted in this same tx cannot have messages yet — return
 *  the static empty page instead of querying a thread that was never written
 *  to. */
const emptyMessagePage = (
  webSearchAvailable: boolean,
): ResolveFileThreadMessagePage => ({
  messages: [],
  olderCursor: null,
  contextMatterIds: [],
  lastActivityAt: null,
  webSearchAvailable,
  webSearchEnabled: false,
  model: null,
  context: null,
});

/**
 * Organization-wide web-search availability: an org key (or the platform
 * fallback) resolves to a provider, and the org has not disabled the
 * `web_search` native tool for its practice jurisdictions. Mirrors
 * `get-messages.ts`'s widened `organizationSettings` select and helper
 * chain (`getDisabledNativeToolSlugs` +
 * `resolveWebSearchProvidersFromOrgSettingsRow` + `isWebSearchAvailable`)
 * exactly, run once per transaction on this handler's already-open `tx` so
 * it costs one extra round-trip, not a second GET after the thread resolves.
 */
const loadWebSearchAvailable = async (
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
 * Loads the same initial message page `get-messages.ts` loads (lines 131-162
 * there), reusing its exact helpers on this handler's already-open `tx` so
 * the reads share one `set_config` instead of paying for a second
 * round-trip GET. `webSearchAvailable` is resolved once per transaction by
 * `loadWebSearchAvailable` and passed in so the context-usage estimate's
 * `webResearch` gate mirrors `get-messages.ts`'s (provider availability AND
 * the thread's opt-in), not a hardcoded false.
 */
const loadResolvedThreadMessagePage = async ({
  tx,
  threadId,
  userId,
  organizationId,
  orgAIConfig,
  contextMatterIds,
  chatModel,
  usedAnonymization,
  webSearchAvailable,
  webSearchEnabled,
}: LoadResolvedThreadMessagePageArgs): Promise<ResolveFileThreadMessagePage> => {
  const page = unwrapTxRead(
    await loadChatMessagePage({ tx, threadId, userId }),
  );

  const checkpoint = await readLatestChatCompactionOnTx({ threadId, tx });
  const windowedMessages = unwrapTxRead(
    await loadWindowedThreadMessages({
      tx,
      threadId,
      isAnonymized: usedAnonymization,
      checkpoint,
    }),
  );

  const hasContext = windowedMessages.length > 0 || checkpoint !== null;
  const { promptTokens, toolTokens } = estimateChatContextPromptTokens({
    toolAvailability: {
      templateAuthoring: false,
      webResearch: webSearchAvailable && webSearchEnabled,
      folioAgentDocTools: false,
      subagents: areSubagentToolsRegistered({ delegationDepth: 0 }),
    },
  });
  const { triggerTokens } = resolveChatCompactionBudget({
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
    webSearchAvailable,
    webSearchEnabled,
    model: chatModel,
    context,
  };
};

const findFileChatThread = async (
  tx: Transaction,
  {
    entityId,
    fieldId,
    organizationId,
    userId,
    workspaceId,
  }: FileThreadLookupInput,
) =>
  (
    await tx
      .select({
        chatThreadId: fileChatThreads.chatThreadId,
        chatModel: chatThreads.chatModel,
        contextMatterIds: chatThreads.contextMatterIds,
        usedAnonymization: chatThreads.usedAnonymization,
        webSearchEnabled: chatThreads.webSearchEnabled,
      })
      .from(fileChatThreads)
      .innerJoin(chatThreads, eq(fileChatThreads.chatThreadId, chatThreads.id))
      .where(
        and(
          eq(fileChatThreads.entityId, entityId),
          eq(fileChatThreads.fieldId, fieldId),
          eq(fileChatThreads.organizationId, organizationId),
          eq(fileChatThreads.userId, userId),
          eq(fileChatThreads.workspaceId, workspaceId),
        ),
      )
      .limit(1)
  ).at(0);

const findFieldKeyedChatThread = async (
  tx: Transaction,
  { fieldId, organizationId, userId, workspaceId }: FileThreadLookupInput,
) =>
  (
    await tx
      .select({
        id: chatThreads.id,
        chatModel: chatThreads.chatModel,
        contextMatterIds: chatThreads.contextMatterIds,
        usedAnonymization: chatThreads.usedAnonymization,
        webSearchEnabled: chatThreads.webSearchEnabled,
      })
      .from(chatThreads)
      .where(
        and(
          // File chat threads were previously keyed directly by
          // field UUID. Preserve those rows without constructing
          // a new branded ID from request input.
          sql`${chatThreads.id} = ${fieldId}`,
          eq(chatThreads.organizationId, organizationId),
          eq(chatThreads.userId, userId),
          eq(chatThreads.workspaceId, workspaceId),
        ),
      )
      .limit(1)
  ).at(0);

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
) => {
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

const createFileChatThread = async (
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
): Promise<ResolveFileThreadTxResult> => {
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

  const chatThreadId = createSafeId<"chatThread">();

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

const resolveFileThread = createSafeHandler(
  config,
  async function* ({
    body,
    orgAIConfig,
    recordAuditEvent,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    const input: FileThreadLookupInput = {
      entityId: body.entityId,
      fieldId: body.fieldId,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      workspaceId,
    };

    const txResult = await safeDb(async (tx) => {
      const webSearchAvailable = await loadWebSearchAvailable(
        tx,
        input.organizationId,
      );
      const existing = await findFileChatThread(tx, input);

      if (existing) {
        const messagePage = await loadResolvedThreadMessagePage({
          tx,
          threadId: existing.chatThreadId,
          userId: input.userId,
          organizationId: input.organizationId,
          orgAIConfig,
          webSearchAvailable,
          chatModel: existing.chatModel,
          contextMatterIds: existing.contextMatterIds,
          usedAnonymization: existing.usedAnonymization,
          webSearchEnabled: existing.webSearchEnabled,
        });

        return {
          ok: true as const,
          chatThreadId: existing.chatThreadId,
          messagePage,
        };
      }

      return await createFileChatThread(
        tx,
        input,
        recordAuditEvent,
        orgAIConfig,
        webSearchAvailable,
      );
    });

    if (Result.isError(txResult)) {
      if (
        !DatabaseError.is(txResult.error) ||
        txResult.error.code !== PG_ERROR.UNIQUE_VIOLATION
      ) {
        return yield* Result.err(txResult.error);
      }

      const recovered = yield* Result.await(
        safeDb(async (tx) => {
          const webSearchAvailable = await loadWebSearchAvailable(
            tx,
            input.organizationId,
          );
          const found = await findFileChatThread(tx, input);
          if (!found) {
            return null;
          }

          const messagePage = await loadResolvedThreadMessagePage({
            tx,
            threadId: found.chatThreadId,
            userId: input.userId,
            organizationId: input.organizationId,
            orgAIConfig,
            webSearchAvailable,
            chatModel: found.chatModel,
            contextMatterIds: found.contextMatterIds,
            usedAnonymization: found.usedAnonymization,
            webSearchEnabled: found.webSearchEnabled,
          });

          return { chatThreadId: found.chatThreadId, messagePage };
        }),
      );

      if (recovered) {
        return Result.ok({
          threadId: recovered.chatThreadId,
          ...recovered.messagePage,
        });
      }

      return yield* Result.err(
        new HandlerError({
          status: 404,
          message: "File not found",
        }),
      );
    }

    if (!txResult.value.ok) {
      return yield* Result.err(
        new HandlerError({
          status: txResult.value.status,
          message: txResult.value.message,
        }),
      );
    }

    return Result.ok({
      threadId: txResult.value.chatThreadId,
      ...txResult.value.messagePage,
    });
  },
);

export default resolveFileThread;
