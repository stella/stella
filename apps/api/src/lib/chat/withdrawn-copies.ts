import { inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  chatMessageRevisions,
  chatMessages,
  chatThreadCompactions,
  chatThreads,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { decisionReferencesIn } from "@/api/lib/case-law/withdrawn-copy-projection";
import { readWithdrawnCopyProjection } from "@/api/lib/case-law/withdrawn-copy-read";
import { LIMITS } from "@/api/lib/limits";
import { getRequestContext } from "@/api/lib/observability/request-context";

type ReadChatCopyProjectionOptions = {
  tx: Transaction;
  caseLawDb?: Parameters<typeof readWithdrawnCopyProjection>[0]["caseLawDb"];
  threadIds: readonly SafeId<"chatThread">[];
  values: unknown;
};

/** One request snapshot shared by message pages, history, revisions and compaction. */
const batches = new WeakMap<
  object,
  Map<string, ReturnType<typeof loadChatCopyProjection>>
>();

const loadChatCopyProjection = async ({
  tx,
  threadIds,
  values,
  caseLawDb,
}: ReadChatCopyProjectionOptions) => {
  const ids = [...new Set(threadIds)];
  const threads =
    ids.length === 0
      ? []
      : await tx
          .select({
            id: chatThreads.id,
            subjectDecisionId: chatThreads.subjectDecisionId,
            parent: sql`(select jsonb_build_object('subjectDecisionId', parent.subject_decision_id, 'title', parent.title) from chat_threads parent where parent.id = ${chatThreads.parentThreadId} limit 1)`,
            // These windows cover the send/list readers. A separately paged older
            // page contributes its own rows through `values` before the lookup.
            messages: sql`(select jsonb_agg(r.content) from (select ${chatMessages.content} from ${chatMessages} where ${chatMessages.threadId} = ${chatThreads.id} order by ${chatMessages.createdAt} desc, ${chatMessages.id} desc limit ${LIMITS.chatSendHistoryWindowMax}) r)`,
            revisions: sql`(select jsonb_agg(r.content) from (select ${chatMessageRevisions.content} from ${chatMessageRevisions} where ${chatMessageRevisions.threadId} = ${chatThreads.id} order by ${chatMessageRevisions.createdAt} desc, ${chatMessageRevisions.id} desc limit ${LIMITS.chatSendHistoryWindowMax}) r)`,
            checkpoint: sql`(select jsonb_build_object('summary', ${chatThreadCompactions.summary}, 'summaryMarkdown', ${chatThreadCompactions.summaryMarkdown}) from ${chatThreadCompactions} where ${chatThreadCompactions.threadId} = ${chatThreads.id} and ${chatThreadCompactions.status} = 'active' order by ${chatThreadCompactions.createdAt} desc limit 1)`,
          })
          .from(chatThreads)
          .where(inArray(chatThreads.id, ids))
          .limit(ids.length);
  const source = [values, threads];
  const references = decisionReferencesIn(source);
  const projection = await readWithdrawnCopyProjection({
    values: source,
    caseLawDb,
  });
  const subjectByThread = new Map(
    threads.map((row) => [row.id, row.subjectDecisionId]),
  );
  return { projection, subjectByThread, references };
};

/** A newly generated artifact can extend the read batch before its content leaves. */
export const readChatCopyProjection = async (
  options: ReadChatCopyProjectionOptions,
) => {
  const scope = getRequestContext() ?? options.tx;
  let scoped = batches.get(scope);
  if (scoped === undefined) {
    scoped = new Map();
    batches.set(scope, scoped);
  }
  const key = [...new Set(options.threadIds)].toSorted().join(",");
  let batch = scoped.get(key);
  if (batch === undefined) {
    batch = loadChatCopyProjection(options);
    scoped.set(key, batch);
  }
  const read = await batch;
  const fresh = [...decisionReferencesIn(options.values)].filter(
    (id) => !read.references.has(id),
  );
  if (fresh.length > 0) {
    const projection = await readWithdrawnCopyProjection({
      values: options.values,
      decisionIds: [...read.references],
      caseLawDb: options.caseLawDb,
    });
    const updated = {
      ...read,
      projection,
      references: new Set([...read.references, ...fresh]),
    };
    scoped.set(key, Promise.resolve(updated));
    return updated;
  }
  return read;
};
