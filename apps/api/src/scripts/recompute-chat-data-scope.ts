/**
 * Recompute stored chat thread data scope from persisted messages, then carry
 * each thread's scope onto the DOCX suggestions it originated.
 *
 * Scope is recomputed with the runtime extractor (see
 * `lib/chat/recompute-thread-scope.ts`) and merged in SQL at update time, so a
 * turn writing scope concurrently is never overwritten. Threads are read in
 * (organization, owner, id) order and a batch never spans two owners, so each
 * batch's audit events share one recorder. The cursor is logged with every
 * batch and can be passed back to resume.
 *
 *   bun run src/scripts/recompute-chat-data-scope.ts [--after <org>:<user>:<thread>] [--dry-run]
 */
import { panic, Result } from "better-result";
import { asc, inArray, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { chatMessages, chatThreads, workspaces } from "@/api/db/schema";
import { chatMessageFromPersisted } from "@/api/handlers/chat/chat-message-parts";
import type { ChatMessage } from "@/api/handlers/chat/types";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  collectMessageWorkspaceIds,
  planThreadScopeAdditions,
} from "@/api/lib/chat/recompute-thread-scope";

const THREAD_BATCH_SIZE = 50;
const STATEMENT_TIMEOUT = "60000ms";

type Cursor = { organizationId: string; userId: string; threadId: string };

const parseCursor = (value: string | null): Cursor | null => {
  if (value === null) {
    return null;
  }
  const [organizationId, userId, threadId] = value.split(":");
  if (!organizationId || !userId || !threadId) {
    return panic("--after expects <organization>:<user>:<thread>");
  }
  return { organizationId, userId, threadId };
};

const formatCursor = ({ organizationId, threadId, userId }: Cursor) =>
  `${organizationId}:${userId}:${threadId}`;

type BatchOutcome = {
  next: Cursor | null;
  scannedThreads: number;
  unreadableMessages: number;
  widenedThreads: number;
  widenedSuggestions: number;
};

const readThreadBatch = async (after: Cursor | null) => {
  const rows = await rootDb
    .select({
      id: chatThreads.id,
      organizationId: chatThreads.organizationId,
      userId: chatThreads.userId,
      workspaceId: chatThreads.workspaceId,
      dataWorkspaceIds: chatThreads.dataWorkspaceIds,
    })
    .from(chatThreads)
    .where(
      after === null
        ? undefined
        : sql`(${chatThreads.organizationId}, ${chatThreads.userId}, ${chatThreads.id})
            > (${after.organizationId}, ${after.userId}, ${after.threadId}::uuid)`,
    )
    .orderBy(
      asc(chatThreads.organizationId),
      asc(chatThreads.userId),
      asc(chatThreads.id),
    )
    .limit(THREAD_BATCH_SIZE);
  const first = rows.at(0);
  return first === undefined
    ? []
    : rows.filter(
        (row) =>
          row.organizationId === first.organizationId &&
          row.userId === first.userId,
      );
};

const readMessagesByThreadId = async (
  threadIds: readonly SafeId<"chatThread">[],
) => {
  const rows = await rootDb
    .select({
      id: chatMessages.id,
      threadId: chatMessages.threadId,
      role: chatMessages.role,
      content: chatMessages.content,
    })
    .from(chatMessages)
    .where(inArray(chatMessages.threadId, [...threadIds]));

  let unreadable = 0;
  const messagesByThreadId = new Map<string, ChatMessage[]>();
  for (const row of rows) {
    const message = Result.try(() => chatMessageFromPersisted(row));
    if (Result.isError(message)) {
      unreadable += 1;
      continue;
    }
    const list = messagesByThreadId.get(row.threadId) ?? [];
    list.push(message.value);
    messagesByThreadId.set(row.threadId, list);
  }
  return { messagesByThreadId, unreadable };
};

const recomputeBatch = async ({
  after,
  dryRun,
}: {
  after: Cursor | null;
  dryRun: boolean;
}): Promise<BatchOutcome> => {
  const threads = await readThreadBatch(after);
  const owner = threads.at(0);
  const last = threads.at(-1);
  if (owner === undefined || last === undefined) {
    return {
      next: null,
      scannedThreads: 0,
      unreadableMessages: 0,
      widenedThreads: 0,
      widenedSuggestions: 0,
    };
  }
  const threadIds = threads.map((thread) => thread.id);
  const { messagesByThreadId, unreadable } =
    await readMessagesByThreadId(threadIds);

  const mentionedWorkspaceIds = collectMessageWorkspaceIds(messagesByThreadId);
  const workspaceRows =
    mentionedWorkspaceIds.length === 0
      ? []
      : await rootDb
          .select({
            id: workspaces.id,
            organizationId: workspaces.organizationId,
          })
          .from(workspaces)
          .where(inArray(workspaces.id, mentionedWorkspaceIds));
  const planned = planThreadScopeAdditions({
    messagesByThreadId,
    threads,
    workspaceOrganizationById: new Map(
      workspaceRows.map((row) => [row.id, row.organizationId]),
    ),
  });
  const next = {
    organizationId: last.organizationId,
    userId: last.userId,
    threadId: last.id,
  };

  if (dryRun) {
    return {
      next,
      scannedThreads: threads.length,
      unreadableMessages: unreadable,
      widenedThreads: planned.length,
      widenedSuggestions: 0,
    };
  }

  const recordAuditEvent = createBackgroundAuditRecorder({
    execution: {
      performer: {
        id: "recompute-chat-data-scope",
        name: "Chat data scope recompute",
        type: "service",
      },
      trigger: { source: "recompute-chat-data-scope", type: "system" },
    },
    organizationId: owner.organizationId,
    workspaceId: null,
    userId: owner.userId,
  });
  const workspaceIdByThreadId = new Map(
    threads.map((thread) => [thread.id, thread.workspaceId]),
  );

  const outcome = await rootDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true)`,
    );

    let widenedThreads = 0;
    if (planned.length > 0) {
      const values = sql.join(
        planned.map(
          ({ additions, threadId }) =>
            sql`(${threadId}::uuid, ${additions}::uuid[])`,
        ),
        sql`, `,
      );
      // The union is taken from the locked row, so scope a concurrent turn
      // wrote after this batch was read is kept.
      const updated = await tx.execute<{
        id: SafeId<"chatThread">;
        old_ids: string[];
        new_ids: string[];
      }>(sql`
        WITH additions(thread_id, workspace_ids) AS (VALUES ${values}),
        locked AS (
          SELECT ct.id, ct.data_workspace_ids AS old_ids
          FROM chat_threads ct
          JOIN additions a ON a.thread_id = ct.id
          FOR UPDATE OF ct
        )
        UPDATE chat_threads ct
        SET data_workspace_ids = ARRAY(
          SELECT DISTINCT scoped.workspace_id
          FROM pg_catalog.unnest(ct.data_workspace_ids || a.workspace_ids)
            AS scoped(workspace_id)
        )
        FROM additions a, locked l
        WHERE ct.id = a.thread_id
          AND l.id = ct.id
          AND NOT (a.workspace_ids <@ ct.data_workspace_ids)
        RETURNING ct.id, l.old_ids, ct.data_workspace_ids AS new_ids
      `);
      widenedThreads = updated.length;
      await recordAuditEvent(
        tx,
        updated.map((row) => ({
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
          resourceId: row.id,
          workspaceId: workspaceIdByThreadId.get(row.id) ?? null,
          changes: {
            dataWorkspaceIds: { old: row.old_ids, new: row.new_ids },
          },
        })),
      );
    }

    // A suggestion inherits the scope of the thread it came from.
    const suggestions = await tx.execute<{ id: string }>(sql`
      UPDATE docx_suggestions ds
      SET source_data_workspace_ids = ARRAY(
        SELECT DISTINCT scoped.workspace_id
        FROM pg_catalog.unnest(
          ds.source_data_workspace_ids || ct.data_workspace_ids
        ) AS scoped(workspace_id)
      )
      FROM chat_threads ct
      WHERE ds.origin_thread_id = ct.id
        AND ct.id = ANY(${threadIds}::uuid[])
        AND NOT (ct.data_workspace_ids <@ ds.source_data_workspace_ids)
      RETURNING ds.id
    `);
    return { widenedThreads, widenedSuggestions: suggestions.length };
  });

  return {
    next,
    scannedThreads: threads.length,
    unreadableMessages: unreadable,
    ...outcome,
  };
};

const afterIndex = process.argv.indexOf("--after");
const dryRun = process.argv.includes("--dry-run");
let after = parseCursor(
  afterIndex === -1 ? null : (process.argv.at(afterIndex + 1) ?? null),
);
const totals = {
  scannedThreads: 0,
  unreadableMessages: 0,
  widenedThreads: 0,
  widenedSuggestions: 0,
};

console.log(`=== RECOMPUTE CHAT DATA SCOPE${dryRun ? " (dry run)" : ""} ===`);
for (let batch = 1; ; batch += 1) {
  const outcome = await recomputeBatch({ after, dryRun });
  if (outcome.next === null) {
    break;
  }
  totals.scannedThreads += outcome.scannedThreads;
  totals.unreadableMessages += outcome.unreadableMessages;
  totals.widenedThreads += outcome.widenedThreads;
  totals.widenedSuggestions += outcome.widenedSuggestions;
  console.log(
    `[batch ${batch}] scanned=${outcome.scannedThreads} ` +
      `widened_threads=${outcome.widenedThreads} ` +
      `widened_suggestions=${outcome.widenedSuggestions} ` +
      `unreadable_messages=${outcome.unreadableMessages} ` +
      `after=${formatCursor(outcome.next)}`,
  );
  after = outcome.next;
}
console.log(`done: ${JSON.stringify(totals)}`);
process.exit(0);
