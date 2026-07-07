import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import type { SafeDb, SafeDbError } from "@/api/db";
import { clauses } from "@/api/db/schema";
import type {
  PlaybookPositions,
  Position,
} from "@/api/handlers/playbooks/positions";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { brandPersistedClauseId } from "@/api/lib/safe-id-boundaries";

type GradedPosition = Extract<Position, { mode: "graded" }>;

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

// A graded position needs something to grade against. A deterministic `check`
// (presence/constraint) grades on its own, so it always satisfies this. Without
// a check, LLM tier-match needs at least one authored signal — a rule in any
// tier, a fallback entry, or ideal language — otherwise there is nothing to
// compare. v1's silent forced-deviation path is rejected here instead.
const gradedPositionHasContent = (position: GradedPosition): boolean => {
  if (position.check !== undefined) {
    return true;
  }
  const { tiers } = position;
  return (
    tiers.acceptable.rules.length > 0 ||
    tiers.notAcceptable.rules.length > 0 ||
    tiers.fallback.entries.length > 0 ||
    tiers.acceptable.ideal !== undefined
  );
};

// Rule and fallback-entry ids must be unique within a position: findings and DnD
// reorder cite these ids as stable identity, so a collision would make two lines
// indistinguishable. Returns the first colliding id, or null when all are unique.
const findDuplicateTierId = (position: GradedPosition): string | null => {
  const { tiers } = position;
  const seen = new Set<string>();
  const ids = [
    ...tiers.acceptable.rules.map((rule) => rule.id),
    ...tiers.notAcceptable.rules.map((rule) => rule.id),
    ...tiers.fallback.entries.map((entry) => entry.id),
  ];
  for (const id of ids) {
    if (seen.has(id)) {
      return id;
    }
    seen.add(id);
  }
  return null;
};

const collectClauseRefIds = (
  positions: PlaybookPositions,
): SafeId<"clause">[] => {
  const ids = new Set<string>();
  for (const position of positions.items) {
    // Clause ideal language now lives at tiers.acceptable.ideal (graded only).
    if (
      position.mode === "graded" &&
      position.tiers.acceptable.ideal?.source === "clause"
    ) {
      ids.add(position.tiers.acceptable.ideal.clauseId);
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

  for (const position of positions.items) {
    if (position.mode !== "graded") {
      continue;
    }
    if (!gradedPositionHasContent(position)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            "A graded position must have at least one tier rule, fallback entry, or ideal language",
        }),
      );
    }
    const duplicateTierId = findDuplicateTierId(position);
    if (duplicateTierId !== null) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Tier rule and fallback entry ids must be unique",
        }),
      );
    }
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
