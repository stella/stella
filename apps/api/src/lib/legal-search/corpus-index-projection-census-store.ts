import { panic } from "better-result";
import { and, asc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { isUuid } from "@/api/lib/custom-schema";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import {
  lockRegisteredCorpusProjectionManifestForMutation,
  readRegisteredCorpusProjectionManifestForCleanup,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { CORPUS_PROJECTION_DELETE_MAX_REVISIONS } from "@/api/lib/legal-search/corpus-index-projection-engine";
import {
  corpusProjectionAcceptedAppendCleanupFence,
  corpusProjectionAppendIsPublished,
} from "@/api/lib/legal-search/corpus-index-projection-publish-fence";
import { brandValidatedCorpusIndexProjectionIntentId } from "@/api/lib/safe-id-boundaries";

type ProjectionRevision = SafeId<"corpusIndexProjectionIntent">;

export type AppliedCorpusProjectionCensusCandidate = {
  entityId: string;
  revision: ProjectionRevision;
  expectedDocumentCount: number;
};

export type SettledCorpusProjectionCensusCandidate = {
  revision: ProjectionRevision;
};

export type CorpusProjectionCensusPage<TCandidate> = {
  candidates: TCandidate[];
  nextCursor: string | null;
  complete: boolean;
};

type CorpusProjectionCensusPageOptions = {
  family: CorpusFamily;
  generation: string;
  indexId: string;
  after: string | null;
  limit: number;
};

const validateCensusPage = ({
  after,
  limit,
}: Pick<CorpusProjectionCensusPageOptions, "after" | "limit">): void => {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > CORPUS_PROJECTION_DELETE_MAX_REVISIONS
  ) {
    return panic(
      `Corpus projection census page size must be an integer from 1 to ${CORPUS_PROJECTION_DELETE_MAX_REVISIONS}`,
    );
  }
  if (after !== null && !isUuid(after)) {
    return panic("Corpus projection census cursor must be a UUID");
  }
};

const censusPage = <TCandidate extends { revision: string }>(
  candidates: TCandidate[],
  limit: number,
  cursor: (candidate: TCandidate) => string,
): CorpusProjectionCensusPage<TCandidate> => ({
  candidates,
  nextCursor:
    candidates.length === 0
      ? null
      : cursor(
          candidates.at(-1) ?? panic("Lost corpus projection census cursor"),
        ),
  complete: candidates.length < limit,
});

const requireAppliedCandidateDocumentCount = ({
  entityId,
  revision,
  expectedDocumentCount,
}: {
  entityId: string;
  revision: ProjectionRevision;
  expectedDocumentCount: number | null;
}): AppliedCorpusProjectionCensusCandidate => {
  if (expectedDocumentCount === null) {
    return panic(
      `Applied projection has no expected document count: ${revision}`,
    );
  }
  return { entityId, revision, expectedDocumentCount };
};

/**
 * Bounded authoritative revisions that the engine must currently contain.
 * A revision the engine has accepted but not yet published is not one of
 * them: reading it now would report a queued append as drift.
 */
export const readAppliedCorpusProjectionCensusPageTx = async (
  tx: Transaction,
  options: CorpusProjectionCensusPageOptions,
): Promise<
  CorpusProjectionCensusPage<AppliedCorpusProjectionCensusCandidate>
> => {
  validateCensusPage(options);
  const manifest = await readRegisteredCorpusProjectionManifestForCleanup(
    tx,
    options.family,
    options.generation,
  );
  const candidates = await tx
    .select({
      entityId: corpusIndexProjectionStates.entityId,
      revision: corpusIndexProjectionIntents.id,
      expectedDocumentCount: corpusIndexProjectionIntents.expectedDocumentCount,
    })
    .from(corpusIndexProjectionStates)
    .innerJoin(
      corpusIndexProjectionIntents,
      eq(
        corpusIndexProjectionIntents.id,
        corpusIndexProjectionStates.appliedRevision,
      ),
    )
    .where(
      and(
        eq(corpusIndexProjectionStates.family, options.family),
        eq(corpusIndexProjectionStates.generation, options.generation),
        eq(corpusIndexProjectionStates.appliedAction, "upsert"),
        eq(corpusIndexProjectionStates.appliedIndexId, options.indexId),
        isNotNull(corpusIndexProjectionStates.appliedRevision),
        eq(corpusIndexProjectionIntents.status, "applied"),
        corpusProjectionAppendIsPublished(manifest),
        options.after === null
          ? undefined
          : gt(corpusIndexProjectionStates.entityId, options.after),
      ),
    )
    .orderBy(asc(corpusIndexProjectionStates.entityId))
    .limit(options.limit);
  return censusPage(
    candidates.map(requireAppliedCandidateDocumentCount),
    options.limit,
    ({ entityId }) => entityId,
  );
};

type RevalidateAppliedCorpusProjectionCensusOptions = {
  family: CorpusFamily;
  generation: string;
  indexId: string;
  revisions: readonly ProjectionRevision[];
};

/** Re-read exact applied identities after the engine observation. */
export const revalidateAppliedCorpusProjectionCensusTx = async (
  tx: Transaction,
  options: RevalidateAppliedCorpusProjectionCensusOptions,
): Promise<AppliedCorpusProjectionCensusCandidate[]> => {
  if (
    options.revisions.length === 0 ||
    options.revisions.length > CORPUS_PROJECTION_DELETE_MAX_REVISIONS
  ) {
    return panic("Corpus projection census revalidation batch is invalid");
  }
  const candidates = await tx
    .select({
      entityId: corpusIndexProjectionStates.entityId,
      revision: corpusIndexProjectionIntents.id,
      expectedDocumentCount: corpusIndexProjectionIntents.expectedDocumentCount,
    })
    .from(corpusIndexProjectionStates)
    .innerJoin(
      corpusIndexProjectionIntents,
      eq(
        corpusIndexProjectionIntents.id,
        corpusIndexProjectionStates.appliedRevision,
      ),
    )
    .where(
      and(
        eq(corpusIndexProjectionStates.family, options.family),
        eq(corpusIndexProjectionStates.generation, options.generation),
        eq(corpusIndexProjectionStates.appliedAction, "upsert"),
        eq(corpusIndexProjectionStates.appliedIndexId, options.indexId),
        inArray(corpusIndexProjectionIntents.id, options.revisions),
        eq(corpusIndexProjectionIntents.status, "applied"),
      ),
    )
    .orderBy(asc(corpusIndexProjectionStates.entityId))
    .limit(options.revisions.length);
  return candidates.map(requireAppliedCandidateDocumentCount);
};

type RepairAppliedCorpusProjectionDriftOptions = {
  family: CorpusFamily;
  generation: string;
  indexId: string;
  revisions: readonly ProjectionRevision[];
  testNow?: Date;
};

/**
 * Fence still-authoritative broken revisions into exact cleanup. The explicit
 * repair state makes the unchanged desired epoch runnable again only after
 * that cleanup settles, without moving applied history backward.
 */
export const repairAppliedCorpusProjectionDriftTx = async (
  tx: Transaction,
  options: RepairAppliedCorpusProjectionDriftOptions,
): Promise<number> => {
  if (
    options.revisions.length === 0 ||
    options.revisions.length > CORPUS_PROJECTION_DELETE_MAX_REVISIONS
  ) {
    return panic("Corpus projection census repair batch is invalid");
  }
  const manifest = await lockRegisteredCorpusProjectionManifestForMutation(
    tx,
    options.family,
    options.generation,
  );
  const candidates = await tx
    .select({
      entityId: corpusIndexProjectionStates.entityId,
      revision: corpusIndexProjectionIntents.id,
    })
    .from(corpusIndexProjectionStates)
    .innerJoin(
      corpusIndexProjectionIntents,
      eq(
        corpusIndexProjectionIntents.id,
        corpusIndexProjectionStates.appliedRevision,
      ),
    )
    .where(
      and(
        eq(corpusIndexProjectionStates.family, options.family),
        eq(corpusIndexProjectionStates.generation, options.generation),
        eq(corpusIndexProjectionStates.appliedAction, "upsert"),
        eq(corpusIndexProjectionStates.appliedIndexId, options.indexId),
        inArray(corpusIndexProjectionIntents.id, options.revisions),
        eq(corpusIndexProjectionIntents.status, "applied"),
      ),
    )
    .orderBy(asc(corpusIndexProjectionStates.entityId))
    .limit(options.revisions.length)
    .for("update", { of: corpusIndexProjectionStates });
  if (candidates.length === 0) {
    return 0;
  }
  const revisions = candidates.map(({ revision }) => revision);
  await tx
    .select({ id: corpusIndexProjectionIntents.id })
    .from(corpusIndexProjectionIntents)
    .where(inArray(corpusIndexProjectionIntents.id, revisions))
    .orderBy(asc(corpusIndexProjectionIntents.id))
    .limit(revisions.length)
    .for("update");
  const repairAt = options.testNow ?? sql<Date>`clock_timestamp()`;
  const scheduled = await tx
    .update(corpusIndexProjectionStates)
    .set({
      workStatus: "repair_scheduled",
      retryNotBefore: null,
      failureAttempts: 0,
      lastFailureKind: null,
      lastFailureMessage: null,
      updatedAt: repairAt,
    })
    .where(
      and(
        eq(corpusIndexProjectionStates.family, options.family),
        eq(corpusIndexProjectionStates.generation, options.generation),
        inArray(corpusIndexProjectionStates.appliedRevision, revisions),
      ),
    )
    .returning({ entityId: corpusIndexProjectionStates.entityId });
  const retired = await tx
    .update(corpusIndexProjectionIntents)
    .set({
      status: "cleanup_pending",
      ...corpusProjectionAcceptedAppendCleanupFence(manifest, repairAt),
      lastError: "applied census observed engine drift",
      updatedAt: repairAt,
    })
    .where(
      and(
        inArray(corpusIndexProjectionIntents.id, revisions),
        eq(corpusIndexProjectionIntents.status, "applied"),
      ),
    )
    .returning({ id: corpusIndexProjectionIntents.id });
  if (
    scheduled.length !== candidates.length ||
    retired.length !== candidates.length
  ) {
    return panic("Corpus projection census repair lost its state fence");
  }
  return retired.length;
};

/** Bounded retired revisions that the engine must no longer contain. */
export const readSettledCorpusProjectionCensusPageTx = async (
  tx: Transaction,
  options: CorpusProjectionCensusPageOptions,
): Promise<
  CorpusProjectionCensusPage<SettledCorpusProjectionCensusCandidate>
> => {
  validateCensusPage(options);
  await readRegisteredCorpusProjectionManifestForCleanup(
    tx,
    options.family,
    options.generation,
  );
  const afterRevision =
    options.after === null
      ? null
      : (brandValidatedCorpusIndexProjectionIntentId(options.after) ??
        panic("Lost validated corpus projection census cursor"));
  const candidates = await tx
    .select({ revision: corpusIndexProjectionIntents.id })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        eq(corpusIndexProjectionIntents.family, options.family),
        eq(corpusIndexProjectionIntents.generation, options.generation),
        eq(corpusIndexProjectionIntents.indexId, options.indexId),
        eq(corpusIndexProjectionIntents.status, "settled"),
        afterRevision === null
          ? undefined
          : gt(corpusIndexProjectionIntents.id, afterRevision),
      ),
    )
    .orderBy(asc(corpusIndexProjectionIntents.id))
    .limit(options.limit);
  return censusPage(candidates, options.limit, ({ revision }) => revision);
};
