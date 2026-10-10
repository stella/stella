import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import { stella } from "@/api/db/rls";
import {
  setScopedTransactionSettings,
  type WorkspaceScope,
} from "@/api/db/scoped";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord } from "@/api/lib/type-guards";

type ExplainTransaction = {
  execute: (query: SQLWrapper | string) => PromiseLike<unknown>;
};

type ExplainDatabase<TTransaction extends ExplainTransaction> = {
  transaction: <TResult>(
    fn: (tx: TTransaction) => Promise<TResult>,
  ) => Promise<TResult>;
};

export type ExplainPlanDocument = Record<string, unknown> & {
  Plan: Record<string, unknown>;
};

const isExplainPlanDocument = (
  document: unknown,
): document is ExplainPlanDocument =>
  isRecord(document) && isRecord(document["Plan"]);

export type ExplainAsStellaOptions<TTransaction extends ExplainTransaction> = {
  database: ExplainDatabase<TTransaction>;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user"> | null;
  workspaceScope: WorkspaceScope;
  featureIds: readonly string[];
  jit: "on" | "off";
  query: SQLWrapper;
};

/** Run an analyzed plan under the same RLS settings as a scoped application transaction. */
export const explainAsStella = async <TTransaction extends ExplainTransaction>({
  database,
  organizationId,
  userId,
  workspaceScope,
  featureIds,
  jit,
  query,
}: ExplainAsStellaOptions<TTransaction>): Promise<ExplainPlanDocument[]> =>
  await database.transaction(async (tx) => {
    await setScopedTransactionSettings({
      tx,
      organizationId,
      userId,
      workspaceScope,
      featureIds,
    });
    await tx.execute(sql`SELECT set_config('jit', ${jit}, true)`);

    const role = executedRows(
      await tx.execute(sql`SELECT current_user AS role`),
    ).at(0);
    if (!isRecord(role) || role["role"] !== stella.name) {
      return panic("Scoped query plan did not run as the stella role");
    }

    const row = executedRows(
      await tx.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`),
    ).at(0);
    const plan = isRecord(row) ? row["QUERY PLAN"] : undefined;
    if (!Array.isArray(plan) || !plan.every(isExplainPlanDocument)) {
      return panic("Could not decode EXPLAIN JSON plan");
    }
    return plan;
  });
