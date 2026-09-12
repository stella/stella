import { and, asc, eq, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { caseLawResearchColumns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

export type ResearchColumnRow = typeof caseLawResearchColumns.$inferSelect;

type ColumnScope = {
  tx: Pick<Transaction, "select">;
  organizationId: SafeId<"organization">;
  /**
   * Hold the rows until the transaction ends, so a question reworded in
   * between cannot have its old wording answered under the new heading.
   */
  lock?: boolean;
};

type NamedColumnScope = ColumnScope & {
  columnIds: readonly SafeId<"caseLawResearchColumn">[];
};

const selectColumns = async ({
  extraCondition,
  lock,
  organizationId,
  tx,
}: ColumnScope & { extraCondition?: SQL }): Promise<ResearchColumnRow[]> => {
  const conditions = [
    eq(caseLawResearchColumns.organizationId, organizationId),
  ];
  if (extraCondition !== undefined) {
    conditions.push(extraCondition);
  }
  const query = tx
    .select()
    .from(caseLawResearchColumns)
    .where(and(...conditions))
    .orderBy(
      asc(caseLawResearchColumns.position),
      asc(caseLawResearchColumns.id),
    )
    .limit(LIMITS.caseLawResearchColumnsPerOrganization);
  return lock === true ? await query.for("update") : await query;
};

/** Every question column the organization keeps, in display order. */
export const readOrganizationResearchColumns = async (
  scope: ColumnScope,
): Promise<ResearchColumnRow[]> => await selectColumns(scope);

/**
 * The named columns in display order, or null when one of them belongs to
 * another organization. Every handler that takes column ids from a request
 * starts here: a foreign id fails the whole request as a 404, it never
 * narrows the result silently.
 */
export const readNamedResearchColumns = async ({
  columnIds,
  ...scope
}: NamedColumnScope): Promise<ResearchColumnRow[] | null> => {
  const requested = new Set(columnIds);
  const rows = await selectColumns({
    ...scope,
    extraCondition: inArray(caseLawResearchColumns.id, [...requested]),
  });
  return rows.length === requested.size ? rows : null;
};
