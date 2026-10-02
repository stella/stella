import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { clauses } from "@/api/db/schema";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import {
  readableReferencePassageIds,
  referencePassageIds,
} from "@/api/lib/document-review/reference-passages";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { brandPersistedClauseId } from "@/api/lib/safe-id-boundaries";
import {
  positionSourceEntityIds,
  positionSourceKey,
  positionSources,
  readablePositionSources,
} from "@/api/lib/workflow/playbook-position-sources";
import type {
  PlaybookPositions,
  Position,
} from "@/api/lib/workflow/playbook-positions";
import { isTierStandard } from "@/api/lib/workflow/position-runtime";
import type {
  GradedPosition,
  TierStandardPosition,
} from "@/api/lib/workflow/position-runtime";

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
// (presence/constraint) grades on its own, so it always satisfies this. A
// reference standard carries at least one passage by schema. Without either,
// LLM tier-match needs at least one authored signal — a rule in any tier, a
// fallback entry, or ideal language — otherwise there is nothing to compare.
export const gradedPositionHasContent = (position: GradedPosition): boolean => {
  if (
    position.check !== undefined ||
    position.standard.source === "reference"
  ) {
    return true;
  }
  const { tiers } = position.standard;
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
export const findDuplicateTierId = (
  position: TierStandardPosition,
): string | null => {
  const { tiers } = position.standard;
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
    // Clause ideal language lives at standard.tiers.acceptable.ideal.
    if (
      isTierStandard(position) &&
      position.standard.tiers.acceptable.ideal?.source === "clause"
    ) {
      ids.add(position.standard.tiers.acceptable.ideal.clauseId);
    }
  }
  return [...ids].map((id) => brandPersistedClauseId(id));
};

// A position may list each source document only once. The list records where
// the position came from, and readers look sources up by document id.
const hasDuplicatePositionSource = (position: Position): boolean => {
  const entityIds = arrayOrEmpty(position.sources).map(
    ({ entityId }) => entityId,
  );
  return new Set(entityIds).size !== entityIds.length;
};

type AssertPositionsValidArgs = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  /** Matters the caller can access; a newly added source must be in one. */
  accessibleWorkspaceIds: readonly SafeId<"workspace">[];
  positions: PlaybookPositions;
  /** The playbook's positions as stored before this save; null on create. */
  storedPositions: PlaybookPositions | null;
};

/**
 * Reject a positions payload before it is persisted: every position must own a
 * distinct `sourceId` (re-runs map a position back to its materialized
 * column/finding by that id), and every clause-backed standard must reference a
 * clause that exists in the same organization (no cross-org clause leakage).
 * The caller must be able to read every reference passage and every source
 * they add. A source the playbook already stores is kept without that check.
 */
export const assertPositionsValid = async ({
  safeDb,
  organizationId,
  accessibleWorkspaceIds,
  positions,
  storedPositions,
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
    if (hasDuplicatePositionSource(position)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "A position must list each source document once",
        }),
      );
    }
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
    if (!isTierStandard(position)) {
      continue;
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
  if (clauseIds.length > 0) {
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
  }

  // A reference-derived position pins passages by id, and a later run grades
  // them with service access on the author's behalf. Every pinned passage
  // must therefore be one the author's own transaction can read now; a
  // passage from a matter they cannot open is refused rather than published.
  // Runs regardless of whether the clause check above ran: the two guard
  // unrelated standards, and `readableReferencePassageIds` is a no-op query
  // when a position pins no reference passage at all.
  const pinnedPassageIds = referencePassageIds(positions.items);
  const readableResult = await safeDb(
    async (tx) => await readableReferencePassageIds(tx, pinnedPassageIds),
  );
  if (Result.isError(readableResult)) {
    return Result.err(readableResult.error);
  }
  if (pinnedPassageIds.some((id) => !readableResult.value.has(id))) {
    return Result.err(
      new HandlerError({
        status: 403,
        message: "A position quotes a reference passage you cannot read.",
      }),
    );
  }

  // A save can add a source only if the caller's own query finds that
  // document in that matter. This stops anyone attaching a document they
  // cannot open, and means the matter id sent by the client is never trusted.
  // A source the playbook already stores was checked when it was first added
  // and is not checked again; otherwise a colleague without access to the
  // source's matter could not edit the playbook at all. "Already stores"
  // means anywhere in the playbook, not only in the same position, so
  // duplicating a position or converting its mode keeps its sources.
  const storedKeys = new Set(
    positionSources(arrayOrEmpty(storedPositions?.items)).map(
      positionSourceKey,
    ),
  );
  const introduced = positionSources(positions.items).filter(
    (source) => !storedKeys.has(positionSourceKey(source)),
  );
  const readableSourcesResult = await readablePositionSources({
    safeDb,
    entityIds: positionSourceEntityIds(introduced),
    accessibleWorkspaceIds,
  });
  if (Result.isError(readableSourcesResult)) {
    return Result.err(readableSourcesResult.error);
  }
  const readableKeys = new Set(
    readableSourcesResult.value.map(positionSourceKey),
  );
  if (
    introduced.some((source) => !readableKeys.has(positionSourceKey(source)))
  ) {
    return Result.err(
      new HandlerError({
        status: 403,
        message: "A position cites a source document you cannot read.",
      }),
    );
  }

  return Result.ok(undefined);
};
