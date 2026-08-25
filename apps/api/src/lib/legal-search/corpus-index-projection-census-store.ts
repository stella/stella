import { panic } from "better-result";
import { and, asc, eq, gt, inArray, isNotNull } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { toSafeId, type SafeId } from "@/api/lib/branded-types";
import { isUuid } from "@/api/lib/custom-schema";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import { readRegisteredCorpusProjectionManifestForCleanup } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { CORPUS_PROJECTION_DELETE_MAX_REVISIONS } from "@/api/lib/legal-search/corpus-index-projection-engine";

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

/** Bounded authoritative revisions that the engine must currently contain. */
export const readAppliedCorpusProjectionCensusPageTx = async (
  tx: Transaction,
  options: CorpusProjectionCensusPageOptions,
): Promise<
  CorpusProjectionCensusPage<AppliedCorpusProjectionCensusCandidate>
> => {
  validateCensusPage(options);
  await readRegisteredCorpusProjectionManifestForCleanup(
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
      : toSafeId<"corpusIndexProjectionIntent">(options.after);
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
