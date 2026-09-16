import { panic } from "better-result";
import { asc, eq, gt, sql, type SQL } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawStatuteCitationCountState,
  STATUTE_CITATION_COUNT_STATE_KEY,
  STATUTE_CITATION_COUNT_STATUS,
} from "@/api/db/schema";
import { commitReplaySafeIngestionBatch } from "@/api/lib/replay-safe-ingestion";
import type { IngestionTransactionRunner } from "@/api/lib/replay-safe-ingestion";

const BATCH_SIZE = 500;

type CitationCountRepairTransaction = Pick<Transaction, "select" | "update"> & {
  execute: (query: SQL) => PromiseLike<unknown>;
};

type CitationCountRepairDatabase = {
  transaction: <T>(
    work: (tx: CitationCountRepairTransaction) => Promise<T>,
  ) => Promise<T>;
};

/** Create an operation that commits one bounded batch; invoke serially until ready. */
export const createStatuteCitationCountRepair =
  (db: CitationCountRepairDatabase) => async () =>
    await db.transaction(async (tx) => {
      // audit: skip — rebuilds a public-corpus projection with a durable maintenance checkpoint.
      const [state] = await tx
        .select({
          cursorDecisionId: caseLawStatuteCitationCountState.cursorDecisionId,
          status: caseLawStatuteCitationCountState.status,
        })
        .from(caseLawStatuteCitationCountState)
        .where(
          eq(
            caseLawStatuteCitationCountState.key,
            STATUTE_CITATION_COUNT_STATE_KEY,
          ),
        )
        .for("update")
        .limit(1);

      if (state === undefined) {
        return panic("Statute citation count state is missing");
      }

      if (state.status === STATUTE_CITATION_COUNT_STATUS.READY) {
        return { status: "ready" as const, decisions: 0 };
      }

      const decisionRows = await tx
        .select({ decisionId: caseLawDecisions.id })
        .from(caseLawDecisions)
        .where(
          state.cursorDecisionId === null
            ? undefined
            : gt(caseLawDecisions.id, state.cursorDecisionId),
        )
        .orderBy(asc(caseLawDecisions.id))
        .limit(BATCH_SIZE)
        .for("no key update");

      const lastDecisionId = decisionRows.at(-1)?.decisionId;
      if (lastDecisionId === undefined) {
        await tx
          .update(caseLawStatuteCitationCountState)
          .set({
            cursorDecisionId: null,
            status: STATUTE_CITATION_COUNT_STATUS.READY,
            updatedAt: new Date(),
          })
          .where(
            eq(
              caseLawStatuteCitationCountState.key,
              STATUTE_CITATION_COUNT_STATE_KEY,
            ),
          );
        return { status: "ready" as const, decisions: 0 };
      }

      const runInTransaction: IngestionTransactionRunner<
        CitationCountRepairTransaction
      > = async (work) => await work(tx);
      return await commitReplaySafeIngestionBatch({
        items: decisionRows,
        checkpoint: lastDecisionId,
        // Reuse the transaction holding the state and decision locks above.
        runInTransaction,
        persistItems: async (transaction, rows) => {
          const ids = sql.join(
            rows.map(({ decisionId }) => sql`${decisionId}::uuid`),
            sql`, `,
          );
          await transaction.execute(sql`
        SELECT refresh_case_law_statute_citation_memberships(id)
        FROM case_law_decisions WHERE id IN (${ids}) ORDER BY id
      `);
          return { status: "advanced" as const, decisions: rows.length };
        },
        persistCheckpoint: async (transaction, cursorDecisionId) => {
          // audit: skip — advances the locked public-corpus repair checkpoint.
          await transaction
            .update(caseLawStatuteCitationCountState)
            .set({ cursorDecisionId, updatedAt: new Date() })
            .where(
              eq(
                caseLawStatuteCitationCountState.key,
                STATUTE_CITATION_COUNT_STATE_KEY,
              ),
            );
        },
      });
    });
