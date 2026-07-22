import { panic, Result } from "better-result";
import { t } from "elysia";

import type { SafeDbError } from "@/api/db/safe-db";
import { estimateChatContextPromptTokens } from "@/api/handlers/chat/chat-prompt";
import {
  assertChatThreadScopeMatches,
  resolveChatScope,
} from "@/api/handlers/chat/chat-scope";
import { computeThreadContextUsage } from "@/api/handlers/chat/compaction";
import type { ThreadContextUsage } from "@/api/handlers/chat/compaction";
import { resolveChatCompactionBudget } from "@/api/handlers/chat/compaction-budget";
import { loadWindowedThreadMessages } from "@/api/handlers/chat/history-window";
import { loadChatMessagePage } from "@/api/handlers/chat/message-page";
import { readLatestChatCompactionOnTx } from "@/api/handlers/chat/persistent-compaction";
import {
  areSubagentToolsRegistered,
  isWebSearchAvailable,
} from "@/api/handlers/chat/tools/chat-tools";
import type { ChatMessage } from "@/api/handlers/chat/types";
import { getDisabledNativeToolSlugsFromSettingsRow } from "@/api/handlers/mcp-connectors/catalog-metadata";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resolveEffectiveChatModelId } from "@/api/lib/chat-model-selection";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { resolveWebSearchProvidersFromOrgSettingsRow } from "@/api/lib/web-search/load-org-keys";

/**
 * Unwrap a read helper's Result when it ran on this handler's shared `tx`:
 * with `tx`, the helper's `withScopedTx` never produces an error Result — a
 * failure throws and is caught by this transaction's own `safeDb`, so an
 * error Result here would mean that invariant broke.
 */
const unwrapTxRead = <T>(result: Result<T, SafeDbError>): T =>
  Result.isError(result)
    ? panic(
        "Chat messages tx-scoped read unexpectedly returned an error Result",
      )
    : result.value;

const config = {
  permissions: { chat: ["create"] },
  access: "read",
  mcp: { type: "capability", reason: "assistant_chat" },
  params: t.Object({ threadId: tSafeId("chatThread") }),
  query: t.Object({
    allowMissingThread: t.Optional(t.Boolean()),
    workspaceId: t.Optional(tSafeId("workspace")),
  }),
} satisfies HandlerConfig;

const getMessages = createSafeRootHandler(
  config,
  async function* ({
    getWorkspaceAccess,
    orgAIConfig,
    params: { threadId },
    query: { allowMissingThread, workspaceId },
    safeDb,
    session,
    user,
  }) {
    const scope = yield* resolveChatScope({
      getWorkspaceAccess,
      workspaceId,
    });

    // The next-send context estimate the meter renders, built for every
    // response — an existing thread, a brand-new empty one, or a draft that
    // has no row yet. With no messages and no summary the estimate collapses
    // to the honest cache-stable floor (system prompt + tools) the very first
    // send will pay, so the meter never shows a misleading 0% that jumps on
    // send. Mirrors the send path: `webResearch` steers the core rules through
    // the same gate, and the trigger denominator resolves the same model the
    // next send would use.
    const buildNextSendContext = ({
      messages,
      summary,
      threadChatModel,
      webResearch,
    }: {
      messages: readonly ChatMessage[];
      summary: {
        summarizedMessageCount: number;
        summaryMarkdown: string;
      } | null;
      threadChatModel: string | null;
      webResearch: boolean;
    }): ThreadContextUsage => {
      const { promptTokens, toolTokens } = estimateChatContextPromptTokens({
        toolAvailability: {
          docxEditMode: null,
          templateAuthoring: false,
          webResearch,
          folioAgentDocTools: false,
          subagents: areSubagentToolsRegistered({ delegationDepth: 0 }),
        },
      });
      const chatModelOverride = resolveEffectiveChatModelId({
        devModelId: undefined,
        threadChatModel,
        orgAIConfig,
      });
      const { triggerTokens } = resolveChatCompactionBudget({
        chatModelOverride,
        orgAIConfig,
        organizationId: session.activeOrganizationId,
      });
      return computeThreadContextUsage({
        messages,
        promptTokens,
        toolTokens,
        triggerTokens,
        summary,
      });
    };

    // One shared scoped transaction for the whole read-only sequence below:
    // the thread lookup, org settings (jurisdictions, tool overrides, and
    // web-search BYOK keys in one widened select), the most-recent message
    // page, the active compaction checkpoint, and the per-send windowed
    // history used to estimate context usage. All reads share the same RLS
    // scope (workspace access mode/organizationId/userId), so one transaction is
    // semantically identical to the independent transactions this replaced,
    // while paying for a single `set_config`.
    const reads = yield* Result.await(
      safeDb(async (tx) => {
        const thread = await tx.query.chatThreads.findFirst({
          where: {
            id: { eq: threadId },
            userId: { eq: user.id },
          },
          columns: {
            workspaceId: true,
            contextMatterIds: true,
            webSearchEnabled: true,
            usedAnonymization: true,
            chatModel: true,
          },
        });

        // Widened to also cover the web-search BYOK key columns, so this one
        // row read serves both the native-tool-override computation below
        // and web-search provider resolution — replacing a second,
        // independent read of the same organizationSettings row.

        const orgSettingsForChat =
          await tx.query.organizationSettings.findFirst({
            where: {
              organizationId: { eq: session.activeOrganizationId },
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
            session.activeOrganizationId,
            orgSettingsForChat,
          );
        const webSearchAvailable = isWebSearchAvailable({
          webSearchProviderAvailable: webSearchProvider !== null,
          disabledNativeToolSlugs,
        });

        if (!thread) {
          return { kind: "not-found" as const, webSearchAvailable };
        }

        // Reject requests whose scope contradicts the persisted thread.
        // A workspace-scoped thread asked for as global (or vice versa)
        // is a client bug — fail loud instead of silently 404'ing or
        // creating a duplicate. The shared assertion owns the check; this
        // read short-circuits with a discriminated kind so the mismatch
        // 400 is emitted after the transaction closes.
        if (
          Result.isError(
            assertChatThreadScopeMatches({
              persistedWorkspaceId: thread.workspaceId ?? null,
              scope,
            }),
          )
        ) {
          return { kind: "scope-mismatch" as const };
        }

        // The most-recent page is loaded first; older pages are fetched on
        // demand from the sibling /messages/older endpoint as the user
        // scrolls up. lastActivityAt is the newest message's timestamp,
        // which the client compares against the recap staleness window.
        const page = unwrapTxRead(
          await loadChatMessagePage({ tx, threadId, userId: user.id }),
        );

        // Estimate the model context the next send would carry, mirroring the
        // send path: the active compaction summary plus the same windowed
        // history the model receives. Computed only here (the initial page);
        // the /older pagination endpoint does not carry it. The checkpoint is
        // read once and threaded into loadWindowedThreadMessages (which would
        // otherwise re-run the identical query itself), so both observe the
        // same compaction state instead of racing as two independent reads.
        // `isAnonymized` mirrors the thread's persisted flag: anonymized
        // threads never checkpoint, so the capped branch bounds this read the
        // same way the send path bounds its history window (a long
        // anonymized thread must not scan every row just to render the
        // meter).
        const checkpoint = await readLatestChatCompactionOnTx({
          threadId,
          tx,
        });
        const windowedMessages = unwrapTxRead(
          await loadWindowedThreadMessages({
            tx,
            threadId,
            isAnonymized: thread.usedAnonymization,
            checkpoint,
          }),
        );

        return {
          kind: "ok" as const,
          webSearchAvailable,
          thread,
          page,
          checkpoint,
          windowedMessages,
        };
      }),
    );

    if (reads.kind === "not-found") {
      if (allowMissingThread) {
        return Result.ok({
          messages: [],
          olderCursor: null,
          contextMatterIds: [],
          lastActivityAt: null,
          webSearchAvailable: reads.webSearchAvailable,
          webSearchEnabled: false,
          model: null,
          // A not-yet-created draft still carries the cache-stable floor its
          // first send will pay. Web search is off (`webSearchEnabled: false`)
          // and the model defaults (`threadChatModel: null`) until the draft
          // opts in or picks a model, exactly as the first send would resolve.
          context: buildNextSendContext({
            messages: [],
            summary: null,
            threadChatModel: null,
            webResearch: false,
          }),
        });
      }

      return Result.err(
        new HandlerError({
          status: 404,
          message: "Chat thread not found",
        }),
      );
    }

    if (reads.kind === "scope-mismatch") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Chat thread scope does not match request",
        }),
      );
    }

    const { thread, webSearchAvailable, page, checkpoint, windowedMessages } =
      reads;

    // Estimated for every thread, empty ones included: with no messages and no
    // summary the estimate is just the cache-stable floor, so the meter is
    // honest from the first render instead of reading 0% until the first send.
    // Web research steers the core rules through the same two gates the send
    // path applies (provider availability and the thread's opt-in), and (unlike
    // template studio) the standalone read path never carries template-authoring
    // tools. The trigger denominator resolves the same model the next send uses.
    const context = buildNextSendContext({
      messages: windowedMessages.map((message) => ({
        id: message.id,
        role: message.role,
        parts: message.content.data,
      })),
      summary: checkpoint
        ? {
            summarizedMessageCount: checkpoint.summarizedMessageCount,
            summaryMarkdown: checkpoint.summaryMarkdown,
          }
        : null,
      threadChatModel: thread.chatModel,
      webResearch: webSearchAvailable && thread.webSearchEnabled,
    });

    return Result.ok({
      messages: page.messages,
      olderCursor: page.olderCursor,
      contextMatterIds: thread.contextMatterIds,
      lastActivityAt: page.lastActivityAt,
      webSearchAvailable,
      webSearchEnabled: thread.webSearchEnabled,
      model: thread.chatModel,
      context,
    });
  },
);

export default getMessages;
