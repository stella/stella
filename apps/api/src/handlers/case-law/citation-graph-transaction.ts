import { sql, type SQL } from "drizzle-orm";

import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord } from "@/api/lib/type-guards";

type CitationGraphExecutor = {
  execute: (query: SQL) => Promise<unknown>;
};

const CITATION_GRAPH_HELD = Symbol("citation-graph-held");
// One transaction-scoped lock orders graph snapshots and every decision,
// identifier and citation mutation that can change their resolution.
const CITATION_GRAPH_LOCK = sql`hashtext('case_law'), hashtext('citation_resolution_walk')`;

/** A transaction admitted before any decision, identifier or citation row lock. */
export type CitationGraphTransaction<
  TTx extends CitationGraphExecutor = CitationGraphExecutor,
> = TTx & { readonly [CITATION_GRAPH_HELD]: true };

type GraphTransactionRunner<TTx extends CitationGraphExecutor> = <T>(
  run: (tx: TTx) => Promise<T>,
) => Promise<T>;

/**
 * Admit graph work before any domain row lock. Scoped and root factories begin
 * a transaction here. Adaptive maintenance may adapt its existing transaction
 * after admission/checkpoint work, provided it has touched no decision,
 * identifier or citation rows; those control rows are outside the graph.
 */
export const runCitationGraphTransaction = async <
  TTx extends CitationGraphExecutor,
  T,
>(
  transact: GraphTransactionRunner<TTx>,
  run: (tx: CitationGraphTransaction<TTx>) => Promise<T>,
): Promise<T> =>
  await transact(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${CITATION_GRAPH_LOCK})`);
    return await run(
      Object.assign(tx, { [CITATION_GRAPH_HELD]: true } as const),
    );
  });

/** A busy graph declines the standing walk before it reads or writes rows. */
export const tryCitationGraphTransaction = async <
  TTx extends CitationGraphExecutor,
  T,
>(
  transact: GraphTransactionRunner<TTx>,
  run: (tx: CitationGraphTransaction<TTx>) => Promise<T>,
): Promise<T | null> =>
  await transact(async (tx) => {
    const result: unknown = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(${CITATION_GRAPH_LOCK}) AS locked`,
    );
    const row = executedRows(result).at(0);
    if (!isRecord(row) || row["locked"] !== true) {
      return null;
    }
    return await run(
      Object.assign(tx, { [CITATION_GRAPH_HELD]: true } as const),
    );
  });
