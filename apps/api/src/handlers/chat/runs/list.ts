import { panic, Result } from "better-result";
import type { SQL } from "drizzle-orm";
import { and, asc, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import { CHAT_ACTIVE_RUN_STATE } from "@stll/api-contract/chat";
import type {
  ChatActiveRun,
  ChatActiveRunState,
} from "@stll/api-contract/chat";
import { numberFromString } from "@stll/api-contract/http-input";

import { chatThreads, chatTurns, workspaces } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { readWithdrawnCopyProjection } from "@/api/lib/case-law/withdrawn-copy-read";
import { THREAD_ARTEFACT_PROVENANCE_SELECTION } from "@/api/lib/chat/artefact-provenance";
import type { ChatTurnStatus } from "@/api/lib/chat/turn-status";
import { paginationCursorSchema } from "@/api/lib/custom-schema";
import {
  parsePgTimestampCursorValue,
  pgTimestampCursorBoundary,
  pgTimestampCursorValue,
} from "@/api/lib/db-pagination";
import type { ParsedPgTimestampCursor } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import type { Page } from "@/api/lib/pagination";
import type { AssertNoExtraFields } from "@/api/lib/projection-totality";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedChatThreadId } from "@/api/lib/safe-id-boundaries";

/** The one active status that waits on the member rather than the model. */
const WAITING_ON_MEMBER_STATUS = "awaiting-user" satisfies ChatTurnStatus;

/**
 * The state a turn's status shows the member. Only active turns are read; a
 * settled one reaching this is a broken query, not a state to guess.
 */
const activeRunStateOf = (status: ChatTurnStatus): ChatActiveRunState => {
  switch (status) {
    case "accepted":
    case "running":
      return CHAT_ACTIVE_RUN_STATE.working;
    case "awaiting-user":
      return CHAT_ACTIVE_RUN_STATE.needsYou;
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return panic(`A ${status} chat turn is not an active run`);
    default:
      status satisfies never;
      return panic(`Unhandled chat turn status: ${String(status)}`);
  }
};

/** Runs waiting on the member sort before runs the assistant is working on. */
const stateRank = sql<number>`CASE WHEN ${chatTurns.status} = ${WAITING_ON_MEMBER_STATUS} THEN 0 ELSE 1 END`;

const STATE_RANK = {
  [CHAT_ACTIVE_RUN_STATE.needsYou]: 0,
  [CHAT_ACTIVE_RUN_STATE.working]: 1,
} as const satisfies Record<ChatActiveRunState, number>;

/**
 * When the run entered its state. A working run counts from its current
 * active span (a continuation restarts it), or from acceptance when it has
 * none. A waiting run has no column of its own: its `updated_at` is the
 * settlement to `awaiting-user`, the last write a waiting turn receives,
 * since every other turn write needs a running execution.
 */
const runSince =
  sql<Date>`CASE WHEN ${chatTurns.status} = ${WAITING_ON_MEMBER_STATUS} THEN ${chatTurns.updatedAt} ELSE coalesce(${chatTurns.activeStartedAt}, ${chatTurns.createdAt}) END`.mapWith(
    chatTurns.updatedAt,
  );

type ActiveRunCursor = {
  since: ParsedPgTimestampCursor;
  state: ChatActiveRunState;
  threadId: string;
};

const isActiveRunState = (value: unknown): value is ChatActiveRunState =>
  value === CHAT_ACTIVE_RUN_STATE.needsYou ||
  value === CHAT_ACTIVE_RUN_STATE.working;

const encodeActiveRunCursor = ({
  sinceCursor,
  state,
  threadId,
}: {
  sinceCursor: string;
  state: ChatActiveRunState;
  threadId: string;
}): string => encodePaginationCursor([state, sinceCursor, threadId]);

const decodeActiveRunCursor = (cursor: string): ActiveRunCursor | null => {
  const parts = decodePaginationCursor(cursor);
  if (parts?.length !== 3) {
    return null;
  }
  const [state, rawSince, threadId] = parts;
  const since = parsePgTimestampCursorValue(rawSince);
  if (
    !isActiveRunState(state) ||
    since?.precision !== "microseconds" ||
    !isUuidPaginationCursorPart(threadId)
  ) {
    return null;
  }
  return { since, state, threadId };
};

/** Rows strictly after `cursor` in (state, since, thread) order. */
const afterActiveRunCursor = ({ since, state, threadId }: ActiveRunCursor) =>
  sql`(${stateRank}, ${runSince}, ${chatTurns.threadId}) > (${STATE_RANK[state]}::int, ${pgTimestampCursorBoundary(since)}, ${threadId}::uuid)`;

const config = {
  contract: "patch",
  description:
    "List your unfinished chat runs in the active organization: the ones " +
    "waiting on you first, then the ones the assistant is working on, each " +
    "oldest first, with the thread, its matter, and since when the run is " +
    "in that state. Paginate with limit and cursor.",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: { type: "internal", reason: "chat_thread_ui" },
  query: v.strictObject({
    cursor: v.optional(paginationCursorSchema()),
    limit: v.optional(
      numberFromString(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.maxValue(LIMITS.chatActiveRunsPageSizeMax),
        ),
      ),
    ),
  }),
} satisfies HandlerConfig;

type ListActiveChatRunsDependencies = {
  readCopies: typeof readWithdrawnCopyProjection;
};

const LIST_ACTIVE_CHAT_RUNS_DEPENDENCIES: ListActiveChatRunsDependencies = {
  readCopies: readWithdrawnCopyProjection,
};

export const createListActiveChatRuns = ({
  readCopies,
}: ListActiveChatRunsDependencies = LIST_ACTIVE_CHAT_RUNS_DEPENDENCIES) =>
  createSafeRootHandler(
    config,
    async function* ({ query, safeDb, session, user }) {
      const limit = normalizeTenantPageLimit(
        query.limit ?? LIMITS.chatActiveRunsPageSizeDefault,
      );
      const cursor =
        query.cursor === undefined ? null : decodeActiveRunCursor(query.cursor);
      if (query.cursor !== undefined && cursor === null) {
        return Result.err(
          new HandlerError({
            status: 400,
            code: "invalid_cursor",
            message: "Invalid cursor",
            hint: "Restart the list without a cursor.",
          }),
        );
      }

      const conditions: SQL[] = [
        // Served by the partial chat_turns_org_user_active_idx: the read
        // never walks the member's settled history. The statuses stay literal
        // and match the index predicate, because a generic plan cannot prove
        // bound parameters imply it.
        eq(chatTurns.organizationId, session.activeOrganizationId),
        eq(chatTurns.userId, user.id),
        sql`${chatTurns.status} IN ('accepted', 'running', 'awaiting-user')`,
        eq(chatThreads.organizationId, session.activeOrganizationId),
        eq(chatThreads.userId, user.id),
        // A matter being deleted is sealed, as in the thread list.
        sql`(${chatTurns.workspaceId} IS NULL OR ${workspaces.status} <> 'deleting')`,
      ];
      if (cursor !== null) {
        conditions.push(afterActiveRunCursor(cursor));
      }

      const rows = yield* Result.await(
        safeDb((tx) =>
          tx
            .select({
              since: runSince,
              sinceCursor: pgTimestampCursorValue(runSince).as("since_cursor"),
              status: chatTurns.status,
              subjectDecisionId: chatThreads.subjectDecisionId,
              threadId: chatTurns.threadId,
              title: chatThreads.title,
              titleSource: chatThreads.titleSource,
              ...THREAD_ARTEFACT_PROVENANCE_SELECTION,
              workspaceId: chatTurns.workspaceId,
            })
            .from(chatTurns)
            .innerJoin(chatThreads, eq(chatThreads.id, chatTurns.threadId))
            .leftJoin(workspaces, eq(workspaces.id, chatTurns.workspaceId))
            .where(and(...conditions))
            .orderBy(asc(stateRank), asc(runSince), asc(chatTurns.threadId))
            .limit(limit + 1),
        ),
      );

      const runs = rows.map((row) => ({
        ...row,
        state: activeRunStateOf(row.status),
      }));
      const page = createCursorPage({
        rows: runs,
        limit,
        cursorForItem: ({ sinceCursor, state, threadId }) =>
          encodeActiveRunCursor({ sinceCursor, state, threadId }),
      });

      // A title can quote a withdrawn decision; it is read through the same
      // projection as every other thread title.
      const withdrawal = yield* Result.await(
        Result.tryPromise(async () => readCopies({ values: page.items })),
      );

      return Result.ok({
        ...page,
        items: page.items.map((run): ChatActiveRun => {
          const item = {
            threadId: brandPersistedChatThreadId(run.threadId),
            threadTitle: withdrawal.thread(run).title,
            workspaceId: run.workspaceId,
            state: run.state,
            since: run.since.toISOString(),
          };
          return item satisfies AssertNoExtraFields<typeof item, ChatActiveRun>;
        }),
      } satisfies Page<ChatActiveRun>);
    },
  );

export default createListActiveChatRuns();
