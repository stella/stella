import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import type { SafeDb, SafeDbError } from "@/api/db";
import { clauses } from "@/api/db/schema";
import type { PlaybookPositions } from "@/api/handlers/playbooks/positions";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { brandPersistedClauseId } from "@/api/lib/safe-id-boundaries";

export const findDuplicatePositionSourceId = (
  positions: PlaybookPositions,
): string | null => {
  const seen = new Set<string>();
  for (const position of positions.items) {
    if (seen.has(position.sourceId)) {
      return position.sourceId;
    }
    seen.add(position.sourceId);
  }
  return null;
};

const collectClauseRefIds = (
  positions: PlaybookPositions,
): SafeId<"clause">[] => {
  const ids = new Set<string>();
  for (const position of positions.items) {
    if (position.standard.source === "clause") {
      ids.add(position.standard.clauseId);
    }
  }
  return [...ids].map((id) => brandPersistedClauseId(id));
};

type AssertPositionsValidArgs = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  positions: PlaybookPositions;
};

/**
 * Reject a positions payload before it is persisted: every position must own a
 * distinct `sourceId` (re-runs map a position back to its materialized
 * column/finding by that id), and every clause-backed standard must reference a
 * clause that exists in the same organization (no cross-org clause leakage).
 */
export const assertPositionsValid = async ({
  safeDb,
  organizationId,
  positions,
}: AssertPositionsValidArgs): Promise<
  Result<void, SafeDbError | HandlerError>
> => {
  const duplicateSourceId = findDuplicatePositionSourceId(positions);
  if (duplicateSourceId !== null) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Positions must have unique sourceIds",
      }),
    );
  }

  const clauseIds = collectClauseRefIds(positions);
  if (clauseIds.length === 0) {
    return Result.ok(undefined);
  }

  const foundResult = await safeDb((tx) =>
    tx
      .select({ id: clauses.id })
      .from(clauses)
      .where(
        and(
          eq(clauses.organizationId, organizationId),
          inArray(clauses.id, clauseIds),
        ),
      ),
  );
  if (Result.isError(foundResult)) {
    return Result.err(foundResult.error);
  }

  const foundIds = new Set(foundResult.value.map((row) => row.id));
  const missing = clauseIds.find((id) => !foundIds.has(id));
  if (missing !== undefined) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Referenced clause not found in this organization",
      }),
    );
  }

  return Result.ok(undefined);
};
