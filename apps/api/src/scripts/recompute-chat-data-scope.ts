/**
 * Recompute stored chat thread data scope from persisted messages, then carry
 * each thread's scope onto the rows derived from it: the DOCX suggestions it
 * originated, its compaction snapshots, and memories extracted from its
 * messages.
 *
 * Scope is recomputed with the runtime extractor (see
 * `handlers/chat/recompute-thread-scope.ts`) and merged in SQL against the
 * locked rows, so a turn writing scope concurrently is never overwritten, and
 * scope only ever widens. Threads are read in (organization, owner, id) order
 * and a batch never spans two owners, so a batch's audit events share one
 * recorder. A thread with a message the reader cannot parse is left unchanged
 * and listed at the end, and the run then exits non-zero. The cursor is
 * logged with every batch and can be passed back to resume.
 *
 *   bun run src/scripts/recompute-chat-data-scope.ts [--after <org>:<user>:<thread>] [--dry-run]
 */
import { panic, Result } from "better-result";
import { asc, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { chatMessages, chatThreads, workspaces } from "@/api/db/schema";
import { chatMessageFromPersisted } from "@/api/handlers/chat/chat-message-parts";
import {
  collectMessageWorkspaceIds,
  planThreadScopeAdditions,
} from "@/api/handlers/chat/recompute-thread-scope";
import type { ChatMessage } from "@/api/handlers/chat/types";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { openOperatorScriptDb } from "@/api/lib/db/operator-script-db";

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

/** A PostgreSQL uuid[] built from bound elements (never empty here). */
const uuidArray = (ids: readonly string[]): SQL =>
  sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;

// Derived rows whose scope must cover their thread's, widened in one
// statement. Each branch touches only rows that do not yet cover it.
const widenDerivedRows = (threadIds: readonly string[]) => sql`
  WITH batch_threads AS (
    SELECT id, data_workspace_ids FROM chat_threads
    WHERE id = ANY(${uuidArray(threadIds)})
  ),
  suggestions AS (
    UPDATE docx_suggestions ds
    SET source_data_workspace_ids = ARRAY(
      SELECT DISTINCT scoped.workspace_id
      FROM pg_catalog.unnest(
        ds.source_data_workspace_ids || bt.data_workspace_ids
      ) AS scoped(workspace_id)
    )
    FROM batch_threads bt
    WHERE ds.origin_thread_id = bt.id
      AND NOT (bt.data_workspace_ids <@ ds.source_data_workspace_ids)
    RETURNING ds.id
  ),
  compactions AS (
    UPDATE chat_thread_compactions cc
    SET memory_extraction_data_workspace_ids = ARRAY(
      SELECT DISTINCT scoped.workspace_id
      FROM pg_catalog.unnest(
        cc.memory_extraction_data_workspace_ids || bt.data_workspace_ids
      ) AS scoped(workspace_id)
    )
    FROM batch_threads bt
    WHERE cc.thread_id = bt.id
      AND NOT (bt.data_workspace_ids <@ cc.memory_extraction_data_workspace_ids)
    RETURNING cc.id
  ),
  memories AS (
    UPDATE ai_memories m
    SET source_data_workspace_ids = ARRAY(
      SELECT DISTINCT scoped.workspace_id
      FROM pg_catalog.unnest(
        m.source_data_workspace_ids || bt.data_workspace_ids
      ) AS scoped(workspace_id)
    )
    FROM chat_messages cm
    JOIN batch_threads bt ON bt.id = cm.thread_id
    WHERE m.source_message_id = cm.id
      AND NOT (bt.data_workspace_ids <@ m.source_data_workspace_ids)
    RETURNING m.id
  )
  SELECT
    (SELECT count(*)::int FROM suggestions)
    + (SELECT count(*)::int FROM compactions)
    + (SELECT count(*)::int FROM memories) AS changed
`;

// The same predicates, counted without writing, for `--dry-run`.
const countStaleDerivedRows = (threadIds: readonly string[]) => sql`
  SELECT
    (SELECT count(*)::int FROM docx_suggestions ds
      JOIN chat_threads ct ON ct.id = ds.origin_thread_id
      WHERE ct.id = ANY(${uuidArray(threadIds)})
        AND NOT (ct.data_workspace_ids <@ ds.source_data_workspace_ids))
    +
    (SELECT count(*)::int FROM chat_thread_compactions cc
      JOIN chat_threads ct ON ct.id = cc.thread_id
      WHERE ct.id = ANY(${uuidArray(threadIds)})
        AND NOT (ct.data_workspace_ids <@ cc.memory_extraction_data_workspace_ids))
    +
    (SELECT count(*)::int FROM ai_memories m
      JOIN chat_messages cm ON cm.id = m.source_message_id
      JOIN chat_threads ct ON ct.id = cm.thread_id
      WHERE ct.id = ANY(${uuidArray(threadIds)})
        AND NOT (ct.data_workspace_ids <@ m.source_data_workspace_ids))
    AS stale
`;

type BatchOutcome = {
  next: Cursor | null;
  scannedThreads: number;
  widenedThreads: number;
  widenedDerivedRows: number;
  heldThreadIds: string[];
};

const readThreadBatch = async (after: Cursor | null) => {
  const rows = await db.transaction(
    async (tx) =>
      await tx
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
        .limit(THREAD_BATCH_SIZE),
  );
  const first = rows.at(0);
  return first === undefined
    ? []
    : rows.filter(
        (row) =>
          row.organizationId === first.organizationId &&
          row.userId === first.userId,
      );
};

/** Parsed messages per thread; a thread with any unreadable message is held. */
const readMessagesByThreadId = async (
  threadIds: readonly SafeId<"chatThread">[],
) => {
  const rows = await db.transaction(
    async (tx) =>
      await tx
        .select({
          id: chatMessages.id,
          threadId: chatMessages.threadId,
          role: chatMessages.role,
          content: chatMessages.content,
        })
        .from(chatMessages)
        .where(inArray(chatMessages.threadId, [...threadIds])),
  );

  const held = new Set<string>();
  const messagesByThreadId = new Map<string, ChatMessage[]>();
  for (const row of rows) {
    const message = Result.try(() => chatMessageFromPersisted(row));
    if (Result.isError(message)) {
      held.add(row.threadId);
      continue;
    }
    const list = messagesByThreadId.get(row.threadId);
    if (list === undefined) {
      messagesByThreadId.set(row.threadId, [message.value]);
    } else {
      list.push(message.value);
    }
  }
  for (const threadId of held) {
    messagesByThreadId.delete(threadId);
  }
  return { held: [...held], messagesByThreadId };
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
      widenedThreads: 0,
      widenedDerivedRows: 0,
      heldThreadIds: [],
    };
  }
  const { held, messagesByThreadId } = await readMessagesByThreadId(
    threads.map((thread) => thread.id),
  );
  const heldSet = new Set(held);
  const readableThreadIds = threads
    .map((thread) => thread.id)
    .filter((threadId) => !heldSet.has(threadId));

  const mentionedWorkspaceIds = collectMessageWorkspaceIds(messagesByThreadId);
  const workspaceRows =
    mentionedWorkspaceIds.length === 0
      ? []
      : await db.transaction(
          async (tx) =>
            await tx
              .select({
                id: workspaces.id,
                organizationId: workspaces.organizationId,
              })
              .from(workspaces)
              .where(inArray(workspaces.id, mentionedWorkspaceIds)),
        );
  const planned = planThreadScopeAdditions({
    messagesByThreadId,
    threads,
    workspaceOrganizationById: new Map(
      workspaceRows.map((row) => [row.id, row.organizationId]),
    ),
  });
  const base = {
    next: {
      organizationId: last.organizationId,
      userId: last.userId,
      threadId: last.id,
    },
    scannedThreads: threads.length,
    heldThreadIds: held,
  };

  if (readableThreadIds.length === 0) {
    return { ...base, widenedThreads: 0, widenedDerivedRows: 0 };
  }

  if (dryRun) {
    // Counts derived rows already behind their thread; rows that fall behind
    // only once a planned thread widens are counted by the real run.
    const counted = await db.execute<{ stale: number }>(
      countStaleDerivedRows(readableThreadIds),
    );
    return {
      ...base,
      widenedThreads: planned.length,
      widenedDerivedRows: counted.at(0)?.stale ?? 0,
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

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true)`,
    );

    let widenedThreads = 0;
    if (planned.length > 0) {
      const values = sql.join(
        planned.map(
          ({ additions, threadId }) =>
            sql`(${threadId}::uuid, ${uuidArray(additions)})`,
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

    // Runs after the thread update so it reads the widened thread scope.
    const derived = await tx.execute<{ changed: number }>(
      widenDerivedRows(readableThreadIds),
    );
    return {
      widenedThreads,
      widenedDerivedRows: derived.at(0)?.changed ?? 0,
    };
  });

  return { ...base, ...outcome };
};

type Totals = {
  scannedThreads: number;
  widenedThreads: number;
  widenedDerivedRows: number;
  heldThreadIds: string[];
};

// Keyset batches run strictly in order, one after the other.
const runBatches = async ({
  after,
  batch,
  dryRun,
  totals,
}: {
  after: Cursor | null;
  batch: number;
  dryRun: boolean;
  totals: Totals;
}): Promise<Totals> => {
  const outcome = await recomputeBatch({ after, dryRun });
  if (outcome.next === null) {
    return totals;
  }
  console.log(
    `[batch ${batch}] scanned=${outcome.scannedThreads} ` +
      `widened_threads=${outcome.widenedThreads} ` +
      `widened_derived_rows=${outcome.widenedDerivedRows} ` +
      `held=${outcome.heldThreadIds.length} ` +
      `after=${formatCursor(outcome.next)}`,
  );
  return await runBatches({
    after: outcome.next,
    batch: batch + 1,
    dryRun,
    totals: {
      scannedThreads: totals.scannedThreads + outcome.scannedThreads,
      widenedThreads: totals.widenedThreads + outcome.widenedThreads,
      widenedDerivedRows:
        totals.widenedDerivedRows + outcome.widenedDerivedRows,
      heldThreadIds: [...totals.heldThreadIds, ...outcome.heldThreadIds],
    },
  });
};

const afterIndex = process.argv.indexOf("--after");
const dryRun = process.argv.includes("--dry-run");
const db = openOperatorScriptDb({ readOnly: dryRun });
console.log(`=== RECOMPUTE CHAT DATA SCOPE${dryRun ? " (dry run)" : ""} ===`);
const { heldThreadIds, ...totals } = await runBatches({
  after: parseCursor(
    afterIndex === -1 ? null : (process.argv.at(afterIndex + 1) ?? null),
  ),
  batch: 1,
  dryRun,
  totals: {
    scannedThreads: 0,
    widenedThreads: 0,
    widenedDerivedRows: 0,
    heldThreadIds: [],
  },
});
console.log(`done: ${JSON.stringify(totals)}`);
if (heldThreadIds.length > 0) {
  console.log(
    `held ${heldThreadIds.length} thread(s) with unreadable messages; ` +
      `repair them and re-run: ${heldThreadIds.join(",")}`,
  );
  process.exit(1);
}
process.exit(0);
