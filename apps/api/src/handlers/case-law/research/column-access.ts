import { and, asc, eq, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { caseLawResearchColumns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

export type ResearchColumnRow = typeof caseLawResearchColumns.$inferSelect;

/** Columns a client never sees. */
const UNPROJECTED_RESEARCH_COLUMN_COLUMNS = [
  // The retiring research tables own this link; a column now belongs to the
  // organization, and the client addresses it by id alone.
  "tableId",
  // Tenant scope comes from the caller's session, never the response.
  "organizationId",
  // Which model answers the question is a server-side execution detail.
  "tool",
] as const satisfies readonly (keyof ResearchColumnRow)[];

/** One question column as a client reads it. */
export const toResearchColumnResponse = (row: ResearchColumnRow) => ({
  id: row.id,
  createdBy: row.createdBy,
  position: row.position,
  question: row.question,
  answerType: row.answerType,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

type ResearchColumnResponse = ReturnType<typeof toResearchColumnResponse>;

// Totality guard, bidirectional: every schema column must be projected onto
// the response or excused above, and the projection cannot carry a field that
// traces back to no real column.
type MissingProjectedResearchColumn = UnprojectedColumns<
  ResearchColumnRow,
  ResearchColumnResponse,
  (typeof UNPROJECTED_RESEARCH_COLUMN_COLUMNS)[number]
>;
type UnexpectedProjectedResearchColumn = UnbackedProjectionKeys<
  ResearchColumnRow,
  ResearchColumnResponse,
  (typeof UNPROJECTED_RESEARCH_COLUMN_COLUMNS)[number]
>;

true satisfies MissingProjectedResearchColumn extends never ? true : never;
true satisfies UnexpectedProjectedResearchColumn extends never ? true : never;

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
    // The held ceiling, not the create cap: an organization carrying columns
    // from the per-table era holds more than it may add, and a read that cut
    // the set there would hide a column from the results table and leave the
    // reorder, which must name every column once, impossible to satisfy.
    .limit(LIMITS.caseLawResearchColumnsPerOrganizationMax);
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
