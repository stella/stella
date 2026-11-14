import { panic, Result } from "better-result";
import type { SQL } from "drizzle-orm";
import { and, desc, eq, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import * as v from "valibot";

import {
  CHAT_THREAD_ORIGIN,
  CHAT_THREAD_PIN_STATE,
  CHAT_THREAD_READ_STATE,
  type ChatThreadOrigin,
  type ChatThreadPinState,
  type ChatThreadReadState,
} from "@stll/api-contract/chat";
import { numberFromString } from "@stll/api-contract/http-input";
import { classifyFailure } from "@stll/errors";

import {
  chatMessages,
  chatThreads,
  workspaces as workspacesTable,
} from "@/api/db/schema";
import { resolveChatScope } from "@/api/handlers/chat/chat-scope";
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
import {
  LATEST_ANSWER,
  UNREAD_BESIDE_LATEST_ANSWER,
} from "@/api/handlers/chat/threads/reader-state";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { readPublicDecisionBadges } from "@/api/lib/case-law/decision-badges";
import type { PublicDecisionBadge } from "@/api/lib/case-law/decision-badges";
import { readWithdrawnCopyProjection } from "@/api/lib/case-law/withdrawn-copy-read";
import { THREAD_ARTEFACT_PROVENANCE_SELECTION } from "@/api/lib/chat/artefact-provenance";
import {
  paginationCursorSchema,
  resourceIdSchema,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import { LIMITS } from "@/api/lib/limits";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type { AssertNoExtraFields } from "@/api/lib/projection-totality";
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
  { type: "present"; badge: PublicDecisionBadge } | { type: "unavailable" };

type ChatThreadListItem = {
  context: ChatThreadContext;
  decision: ChatThreadDecision | null;
  id: string;
  origin: ChatThreadOrigin;
  pinState: ChatThreadPinState;
  readState: ChatThreadReadState;
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
  readDecisionBadges: typeof readPublicDecisionBadges,
) => {
  const badges = await readDecisionBadges({
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
  contract: "patch",
  description:
    "List your own chat threads, most recently active first, split into " +
    "global threads and groups per matter. Threads with no messages, and " +
    "threads belonging to a matter that is being deleted, are left out. " +
    "Each thread carries a bounded preview of its context: the matters and " +
    "files it drew on, with their total counts, and the case-law decision " +
    "the chat is about, if any. Each thread also says whether you have read " +
    "its latest answer (readState) and whether you pinned it (pinState). " +
    "The pinState filter keeps only your pinned or only your unpinned " +
    "threads, so a list can show the pinned ones first. search matches the " +
    "thread " +
    "title, the matter it lives in, or a matter pinned to it; matterId " +
    "keeps only the threads that live in that matter (not global threads " +
    "that merely pinned it) and is not found when you cannot open the " +
    "matter; paginate with limit and cursor.",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "assistant_chat",
    consumesServices: false,
  },
  query: v.object({
    cursor: v.optional(paginationCursorSchema()),
    search: v.optional(
      v.pipe(v.string(), v.maxLength(LIMITS.searchQueryMaxLength)),
    ),
    workspaceId: v.optional(resourceIdSchema("workspace")),
    pinState: v.optional(v.picklist(Object.values(CHAT_THREAD_PIN_STATE))),
    limit: v.optional(
      numberFromString(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.maxValue(LIMITS.chatThreadListPageSizeMax),
        ),
      ),
    ),
  }),
} satisfies HandlerConfig;

const readerStatesOf = ({
  pinnedAt,
  unread,
}: {
  pinnedAt: Date | null;
  unread: boolean;
}): Pick<ChatThreadListItem, "pinState" | "readState"> => ({
  pinState:
    pinnedAt === null
      ? CHAT_THREAD_PIN_STATE.unpinned
      : CHAT_THREAD_PIN_STATE.pinned,
  readState: unread
    ? CHAT_THREAD_READ_STATE.unread
    : CHAT_THREAD_READ_STATE.read,
});

const THREAD_LIST_PROJECTION = {
  createdAt: chatThreads.createdAt,
  forkedFromMessageId: chatThreads.forkedFromMessageId,
  id: chatThreads.id,
  pinnedAt: chatThreads.pinnedAt,
  subjectDecisionId: chatThreads.subjectDecisionId,
  title: chatThreads.title,
  titleSource: chatThreads.titleSource,
  ...THREAD_ARTEFACT_PROVENANCE_SELECTION,
  updatedAt: chatThreads.updatedAt,
  usedAnonymization: chatThreads.usedAnonymization,
  updatedAtCursor:
    chatThreadListCursorCodec.cursorValue.as("updated_at_cursor"),
  workspaceId: chatThreads.workspaceId,
  workspaceName: workspacesTable.name,
} as const;

/**
 * A title search reads at most this many batches of `limit + 1` rows while it
 * skips threads that matched only by a withdrawn title; a page cut short by
 * the budget still returns a cursor, so the walk continues on the next page.
 */
const TITLE_SEARCH_SCAN_BATCHES_MAX = 4;

type ListCursor = NonNullable<
  ReturnType<typeof chatThreadListCursorCodec.decode>
>;
type ListedRow = { id: SafeId<"chatThread">; updatedAtCursor: string };

type ReadListPageOptions<Row extends ListedRow> = {
  cursor: ListCursor | null;
  limit: number;
  readBatch: (after: ListCursor | null) => Promise<Row[]>;
  /** Null keeps every row read; a search filter decides per batch. */
  admitBatch: ((batch: Row[]) => Promise<(row: Row) => boolean>) | null;
};

/**
 * One page of rows the filter admits, read in keyset batches of `limit + 1`.
 * The cursor resumes after the page's last row, or after the last row read
 * when the batch budget ends the page early.
 */
const readListPage = async <Row extends ListedRow>({
  cursor,
  limit,
  readBatch,
  admitBatch,
}: ReadListPageOptions<Row>) => {
  const admitted: Row[] = [];
  let after = cursor;
  let scanned: Row | undefined;
  let exhausted = false;
  const batchesMax = admitBatch === null ? 1 : TITLE_SEARCH_SCAN_BATCHES_MAX;
  for (
    let batchIndex = 0;
    batchIndex < batchesMax && admitted.length <= limit && !exhausted;
    batchIndex++
  ) {
    const batch = await readBatch(after);
    exhausted = batch.length <= limit;
    const admits = admitBatch === null ? () => true : await admitBatch(batch);
    for (const row of batch) {
      if (admitted.length > limit) {
        break;
      }
      scanned = row;
      if (admits(row)) {
        admitted.push(row);
      }
    }
    if (scanned !== undefined) {
      after =
        chatThreadListCursorCodec.decode(
          encodeChatThreadListCursor({
            id: scanned.id,
            updatedAt: scanned.updatedAtCursor,
          }),
        ) ?? panic("A listed thread must encode a decodable cursor");
    }
  }
  const page = admitted.slice(0, limit);
  let resumeAfter: Row | undefined;
  if (admitted.length > limit) {
    resumeAfter = page.at(-1);
  } else if (!exhausted) {
    resumeAfter = scanned;
  }
  return {
    page,
    nextCursor:
      resumeAfter === undefined
        ? null
        : encodeChatThreadListCursor({
            id: resumeAfter.id,
            updatedAt: resumeAfter.updatedAtCursor,
          }),
  };
};

type GetThreadsDependencies = {
  readDecisionBadges: typeof readPublicDecisionBadges;
  readCopies?: typeof readWithdrawnCopyProjection;
};

type ListedThreadItem = {
  item: ChatThreadListItem;
  workspaceId: string | null;
  workspaceName: string | null;
};

type WorkspaceThreadGroup = {
  workspaceId: string;
  workspaceName: string;
  threads: ChatThreadListItem[];
};

// Global threads stay in page order; matter threads group under their matter,
// most recently updated matter first. A matter thread whose matter name is
// unreadable is left out.
const groupListedThreads = (listed: readonly ListedThreadItem[]) => {
  const global: ChatThreadListItem[] = [];
  const groupedWorkspaceThreads = new Map<string, WorkspaceThreadGroup>();
  for (const { item, workspaceId, workspaceName } of listed) {
    if (workspaceId === null) {
      global.push(item);
      continue;
    }
    if (workspaceName === null) {
      continue;
    }
    const existingGroup = groupedWorkspaceThreads.get(workspaceId);
    if (existingGroup) {
      existingGroup.threads.push(item);
      continue;
    }
    groupedWorkspaceThreads.set(workspaceId, {
      workspaceId,
      workspaceName,
      threads: [item],
    });
  }
  const workspaces = Array.from(groupedWorkspaceThreads.values()).toSorted(
    (left, right) => {
      const leftUpdatedAt = left.threads.at(0)?.updatedAt.getTime() ?? 0;
      const rightUpdatedAt = right.threads.at(0)?.updatedAt.getTime() ?? 0;
      return rightUpdatedAt - leftUpdatedAt;
    },
  );
  return { global, workspaces };
};

const GET_THREADS_DEPENDENCIES = {
  readDecisionBadges: readPublicDecisionBadges,
};

export const createGetThreads = ({
  readDecisionBadges,
  readCopies = readWithdrawnCopyProjection,
}: GetThreadsDependencies = GET_THREADS_DEPENDENCIES) =>
  createSafeRootHandler(
    config,
    async function* ({ getWorkspaceAccess, query, safeDb, session, user }) {
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
      // The matter filter goes through the same access check as every other
      // matter-scoped chat call, so a matter the caller cannot open (or one
      // being deleted) is a 404 rather than a silently empty list.
      const scope = yield* resolveChatScope({
        admitted: "active-or-archived",
        getWorkspaceAccess,
        workspaceId: query.workspaceId,
      });
      if (scope.scope === "workspace") {
        conditions.push(eq(chatThreads.workspaceId, scope.workspaceId));
      }
      if (query.pinState !== undefined) {
        conditions.push(
          query.pinState === CHAT_THREAD_PIN_STATE.pinned
            ? isNotNull(chatThreads.pinnedAt)
            : isNull(chatThreads.pinnedAt),
        );
      }
      const search = query.search?.trim();
      const searchPattern = search ? `%${escapeLike(search)}%` : null;
      // Membership-mode RLS filters workspace-scoped threads and verifies every
      // data_workspace_ids entry on global threads without materializing an
      // application-side workspace allowlist. The joined status predicate keeps
      // deleting workspaces sealed at the product layer.
      const { contexts, nextCursor, page } = yield* Result.await(
        safeDb(async (tx) => {
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
          const matterMatch =
            searchPattern === null || contextMatterMatch === null
              ? sql<boolean>`false`
              : sql<boolean>`coalesce(${ilike(workspacesTable.name, searchPattern)} OR ${contextMatterMatch.matched} IS TRUE, false)`;
          const searchCondition =
            searchPattern === null
              ? undefined
              : or(ilike(chatThreads.title, searchPattern), matterMatch);

          const readBatch = async (after: typeof cursor) => {
            let listQuery = tx
              .select({
                ...THREAD_LIST_PROJECTION,
                matterMatched: matterMatch,
                unread: UNREAD_BESIDE_LATEST_ANSWER,
              })
              .from(chatThreads)
              .leftJoin(
                workspacesTable,
                eq(workspacesTable.id, chatThreads.workspaceId),
              )
              .leftJoinLateral(LATEST_ANSWER, sql`true`)
              .$dynamic();
            if (contextMatterMatch !== null) {
              listQuery = listQuery.leftJoinLateral(
                contextMatterMatch,
                sql`true`,
              );
            }
            const keyset =
              after === null
                ? undefined
                : chatThreadListCursorCodec.keysetAfter({
                    cursor: after,
                    direction: "descending",
                    idColumn: chatThreads.id,
                  });
            return await listQuery
              .where(and(...conditions, searchCondition, keyset))
              .orderBy(desc(chatThreads.updatedAt), desc(chatThreads.id))
              .limit(limit + 1);
          };

          // A withdrawn title is masked when listed, so its stored text cannot
          // be what matched: such a thread stays only when a matter name did.
          const { nextCursor: listedCursor, page: listedPage } =
            await readListPage({
              cursor,
              limit,
              readBatch,
              admitBatch:
                searchPattern === null
                  ? null
                  : async (batch) => {
                      const projection = await readCopies({ values: batch });
                      return (row) =>
                        row.matterMatched ||
                        projection.threadTitleMarker(row) === null;
                    },
            });

          // One bounded read for the whole page's context, never one per row.
          const threadContexts = await readChatThreadContexts({
            previewLimit: CHAT_THREAD_CONTEXT_PREVIEW_LIMIT,
            threadIds: listedPage.map((row) => row.id),
            tx,
          });
          return {
            contexts: threadContexts,
            nextCursor: listedCursor,
            page: listedPage,
          };
        }),
      );

      // After the tenant transaction, not inside it: decisions live in the
      // public corpus, read through its own gated connection.
      const decisionOf = await readThreadDecisions(
        page.map((row) => row.subjectDecisionId),
        readDecisionBadges,
      );

      const withdrawal = yield* Result.await(
        Result.tryPromise(async () => readCopies({ values: page })),
      );
      const listed: ListedThreadItem[] = [];
      for (const thread of page) {
        const origin =
          thread.forkedFromMessageId === null
            ? CHAT_THREAD_ORIGIN.original
            : CHAT_THREAD_ORIGIN.fork;
        const context = contexts.get(thread.id) ?? EMPTY_CHAT_THREAD_CONTEXT;
        const decision = decisionOf(thread.subjectDecisionId);
        const item = {
          context,
          decision,
          id: thread.id,
          origin,
          ...readerStatesOf(thread),
          title: withdrawal.thread(thread).title,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          usedAnonymization: thread.usedAnonymization,
        };
        const slice = item satisfies AssertNoExtraFields<
          typeof item,
          ChatThreadListItem
        >;
        listed.push({
          item: slice,
          workspaceId: thread.workspaceId,
          workspaceName: thread.workspaceName,
        });
      }

      return Result.ok({ ...groupListedThreads(listed), nextCursor });
    },
  );

export default createGetThreads();
