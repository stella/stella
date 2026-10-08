import { Result } from "better-result";
import type { SQL } from "drizzle-orm";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { t } from "elysia";

import {
  CHAT_THREAD_ORIGIN,
  type ChatThreadOrigin,
} from "@stll/api-contract/chat";
import { classifyFailure } from "@stll/errors";

import {
  chatMessages,
  chatThreads,
  workspaces as workspacesTable,
} from "@/api/db/schema";
import {
  chatThreadListCursorCodec,
  encodeChatThreadListCursor,
} from "@/api/handlers/chat/thread-list-pagination";
import {
  CHAT_THREAD_CONTEXT_MATTER_SCAN_LIMIT,
  CHAT_THREAD_CONTEXT_PREVIEW_LIMIT,
  EMPTY_CHAT_THREAD_CONTEXT,
  readChatThreadContexts,
} from "@/api/handlers/chat/threads/list-context";
import type { ChatThreadContext } from "@/api/handlers/chat/threads/list-context";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { readPublicDecisionBadges } from "@/api/lib/case-law/decision-badges";
import type { PublicDecisionBadge } from "@/api/lib/case-law/decision-badges";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import { LIMITS } from "@/api/lib/limits";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";

/** The matters a thread's pinned or embedded matter ids name, for search. */
const contextMatterWorkspaces = alias(
  workspacesTable,
  "context_matter_workspaces",
);

/**
 * The case-law decision a chat is about. Null for a chat about none, or about
 * one the public corpus no longer serves; `unavailable` when the corpus could
 * not be read this time, so the row knows it has a decision it cannot draw.
 */
type ChatThreadDecision =
  | { type: "present"; badge: PublicDecisionBadge }
  | { type: "unavailable" };

type ChatThreadListItem = {
  context: ChatThreadContext;
  decision: ChatThreadDecision | null;
  id: string;
  origin: ChatThreadOrigin;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  usedAnonymization: boolean;
};

/**
 * The decisions a page of threads is about, as a lookup by subject id. A badge
 * is not worth failing someone's history over, so a failed read marks the
 * rows that have a decision instead of failing the page.
 */
const decisionBadgesUnavailable = failureSink({
  event: "chat.thread_list.decision_badges_unavailable",
  expected: [],
});

const readThreadDecisions = async (
  subjectDecisionIds: readonly (SafeId<"caseLawDecision"> | null)[],
) => {
  const badges = await readPublicDecisionBadges({
    decisionIds: subjectDecisionIds.filter((id) => id !== null),
  });
  if (Result.isError(badges)) {
    observeFailure(classifyFailure(badges.error, "upstream_unavailable"), {
      sink: decisionBadgesUnavailable,
      ctx: { step: "getThreads.readThreadDecisions" },
    });
  }
  return (
    subjectDecisionId: SafeId<"caseLawDecision"> | null,
  ): ChatThreadDecision | null => {
    if (subjectDecisionId === null) {
      return null;
    }
    if (Result.isError(badges)) {
      return { type: "unavailable" };
    }
    const badge = badges.value.get(subjectDecisionId);
    return badge === undefined ? null : { type: "present", badge };
  };
};

const config = {
  description:
    "List your own chat threads, most recently active first, split into " +
    "global threads and groups per matter. Threads with no messages, and " +
    "threads belonging to a matter that is being deleted, are left out. " +
    "Each thread carries a bounded preview of its context: the matters and " +
    "files it drew on, with their total counts, and the case-law decision " +
    "the chat is about, if any. search matches the thread " +
    "title, the matter it lives in, or a matter pinned to it; paginate with " +
    "limit and cursor.",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "assistant_chat",
    consumesServices: false,
  },
  query: t.Object({
    cursor: t.Optional(tPaginationCursor()),
    search: t.Optional(t.String({ maxLength: LIMITS.searchQueryMaxLength })),
    limit: t.Optional(
      t.Integer({
        minimum: 1,
        maximum: LIMITS.chatThreadListPageSizeMax,
      }),
    ),
  }),
} satisfies HandlerConfig;

const getThreads = createSafeRootHandler(
  config,
  async function* ({ query, safeDb, session, user }) {
    const limit = normalizeTenantPageLimit(
      query.limit ?? LIMITS.chatThreadListPageSizeDefault,
    );
    const cursor = query.cursor
      ? chatThreadListCursorCodec.decode(query.cursor)
      : null;
    if (query.cursor && !cursor) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }

    const conditions: SQL[] = [
      eq(chatThreads.organizationId, session.activeOrganizationId),
      eq(chatThreads.userId, user.id),
      sql`(
        ${chatThreads.workspaceId} IS NULL
        OR ${workspacesTable.status} <> 'deleting'
      )`,
      sql`exists (
        select 1
        from ${chatMessages}
        where ${chatMessages.threadId} = ${chatThreads.id}
      )`,
    ];
    const search = query.search?.trim();
    const searchPattern = search ? `%${escapeLike(search)}%` : null;
    // Membership-mode RLS filters workspace-scoped threads and verifies every
    // data_workspace_ids entry on global threads without materializing an
    // application-side workspace allowlist. The joined status predicate keeps
    // deleting workspaces sealed at the product layer.
    if (cursor) {
      const cursorCondition = chatThreadListCursorCodec.keysetAfter({
        cursor,
        direction: "descending",
        idColumn: chatThreads.id,
      });
      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    const { contexts, rows } = yield* Result.await(
      safeDb(async (tx) => {
        const listConditions = [...conditions];
        // A matter pinned to a thread, or whose data it embedded, matches by
        // name too. The lateral probe looks up that thread's own matter ids
        // (bounded like its context preview) by primary key, so no matching
        // matter is dropped and the result never depends on how many matters
        // match the term. RLS keeps it to matters the user can open.
        const contextMatterMatch =
          searchPattern === null
            ? null
            : tx
                .select({
                  matched: sql<boolean>`true`.as("context_matter_matched"),
                })
                .from(contextMatterWorkspaces)
                .where(
                  and(
                    sql`${contextMatterWorkspaces.id} = ANY(
                      ${chatThreads.contextMatterIds}[1:${CHAT_THREAD_CONTEXT_MATTER_SCAN_LIMIT}::int]
                      || ${chatThreads.dataWorkspaceIds}[1:${CHAT_THREAD_CONTEXT_MATTER_SCAN_LIMIT}::int]
                    )`,
                    ilike(contextMatterWorkspaces.name, searchPattern),
                  ),
                )
                .limit(1)
                .as("context_matter_match");
        if (searchPattern !== null && contextMatterMatch !== null) {
          const searchCondition = or(
            ilike(chatThreads.title, searchPattern),
            ilike(workspacesTable.name, searchPattern),
            sql`${contextMatterMatch.matched} IS TRUE`,
          );
          if (searchCondition) {
            listConditions.push(searchCondition);
          }
        }

        let listQuery = tx
          .select({
            createdAt: chatThreads.createdAt,
            forkedFromMessageId: chatThreads.forkedFromMessageId,
            id: chatThreads.id,
            subjectDecisionId: chatThreads.subjectDecisionId,
            title: chatThreads.title,
            updatedAt: chatThreads.updatedAt,
            usedAnonymization: chatThreads.usedAnonymization,
            updatedAtCursor:
              chatThreadListCursorCodec.cursorValue.as("updated_at_cursor"),
            workspaceId: chatThreads.workspaceId,
            workspaceName: workspacesTable.name,
          })
          .from(chatThreads)
          .leftJoin(
            workspacesTable,
            eq(workspacesTable.id, chatThreads.workspaceId),
          )
          .$dynamic();
        if (contextMatterMatch !== null) {
          listQuery = listQuery.leftJoinLateral(contextMatterMatch, sql`true`);
        }
        const listedRows = await listQuery
          .where(and(...listConditions))
          .orderBy(desc(chatThreads.updatedAt), desc(chatThreads.id))
          .limit(limit + 1);

        // One bounded read for the whole page's context, never one per row.
        const threadContexts = await readChatThreadContexts({
          previewLimit: CHAT_THREAD_CONTEXT_PREVIEW_LIMIT,
          threadIds: listedRows.slice(0, limit).map((row) => row.id),
          tx,
        });
        return { contexts: threadContexts, rows: listedRows };
      }),
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const lastItem = page.at(-1);
    const nextCursor =
      hasMore && lastItem
        ? encodeChatThreadListCursor({
            id: lastItem.id,
            updatedAt: lastItem.updatedAtCursor,
          })
        : null;

    // After the tenant transaction, not inside it: decisions live in the
    // public corpus, read through its own gated connection.
    const decisionOf = await readThreadDecisions(
      page.map((row) => row.subjectDecisionId),
    );

    const global: ChatThreadListItem[] = [];

    const groupedWorkspaceThreads = new Map<
      string,
      {
        workspaceId: string;
        workspaceName: string;
        threads: ChatThreadListItem[];
      }
    >();

    for (const thread of page) {
      const origin =
        thread.forkedFromMessageId === null
          ? CHAT_THREAD_ORIGIN.original
          : CHAT_THREAD_ORIGIN.fork;
      const context = contexts.get(thread.id) ?? EMPTY_CHAT_THREAD_CONTEXT;
      const decision = decisionOf(thread.subjectDecisionId);
      if (thread.workspaceId === null) {
        global.push({
          context,
          decision,
          id: thread.id,
          origin,
          title: thread.title,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          usedAnonymization: thread.usedAnonymization,
        });
        continue;
      }

      if (thread.workspaceName === null) {
        continue;
      }

      const slice = {
        context,
        decision,
        id: thread.id,
        origin,
        title: thread.title,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        usedAnonymization: thread.usedAnonymization,
      };

      const existingGroup = groupedWorkspaceThreads.get(thread.workspaceId);
      if (existingGroup) {
        existingGroup.threads.push(slice);
        continue;
      }

      groupedWorkspaceThreads.set(thread.workspaceId, {
        workspaceId: thread.workspaceId,
        workspaceName: thread.workspaceName,
        threads: [slice],
      });
    }

    const workspaceGroups = Array.from(
      groupedWorkspaceThreads.values(),
    ).toSorted((left, right) => {
      const leftUpdatedAt = left.threads.at(0)?.updatedAt.getTime() ?? 0;
      const rightUpdatedAt = right.threads.at(0)?.updatedAt.getTime() ?? 0;

      return rightUpdatedAt - leftUpdatedAt;
    });

    return Result.ok({
      global,
      nextCursor,
      workspaces: workspaceGroups,
    });
  },
);

export default getThreads;
