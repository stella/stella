import { isCaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";

import type { Transaction } from "@/api/db/root";
import { reopenCitationsForDecisionIdentifiers } from "@/api/handlers/case-law/citation-resolution";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import type { ObservationShape } from "@/api/handlers/case-law/ingestion/pipeline/decision-existing";
import type {
  DecisionIdentity,
  ObservedDecision,
} from "@/api/handlers/case-law/ingestion/pipeline/decision-identity";
import type { DecisionWritePlan } from "@/api/handlers/case-law/ingestion/pipeline/decision-plan";
import type {
  RawWriteState,
  SourceRawArtifact,
} from "@/api/handlers/case-law/ingestion/pipeline/decision-raw";
import type { CaseLawJudgeDependencies } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import type { StoredSupplement } from "@/api/handlers/case-law/ingestion/supplement-composition";
import type { SafeId } from "@/api/lib/branded-types";
import { synchronizeLockedCorpusProjectionDesiredStateTx } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import type { ActiveCorpusProjectionSourceLock } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { logger } from "@/api/lib/observability/logger";

/** Everything one decision's row write reads, decided before it runs. */
export type DecisionRowWrite = Omit<DecisionIdentity, "decisionId"> &
  Pick<ObservedDecision, "persistedDecisionDate"> & {
    sourceId: SafeId<"caseLawSource">;
    decisionId: SafeId<"caseLawDecision">;
    /** The observation composed with the supplements its document takes in. */
    result: IngestionResult;
    composedSupplements: StoredSupplement[];
    observedAt: Date;
    observationOrder: bigint;
    shape: ObservationShape;
    plan: DecisionWritePlan;
    rawArtifact: SourceRawArtifact;
    rawWrites: RawWriteState;
    judges: CaseLawJudgeDependencies;
  };

type DecisionIdentifierLookup = Pick<
  DecisionWritePlan["identifierRows"][number],
  "type" | "normalizedValue"
>;

/**
 * Tell the citation graph which normalized identifiers this decision holds.
 *
 * A stored decision changes the answer for citations that are not its own,
 * in both directions: it can satisfy citations that gave up on that key, and
 * it can make a key that had exactly one holder ambiguous, which retracts
 * edges drawn to the earlier holder. Neither is discoverable from the citing
 * side, so the standing walk would never revisit them; doing it here, in the
 * transaction that created the reason, is what keeps the graph honest.
 *
 * Only when the identifier set is genuinely new to this row: a metadata
 * refresh under the same identities changes nothing about who can be cited.
 */
export const announceDecisionIdentifiers = async (
  tx: Transaction,
  { result, persistedDecisionDate }: DecisionRowWrite,
  id: SafeId<"caseLawDecision">,
  identifiers: readonly DecisionIdentifierLookup[],
): Promise<void> => {
  if (identifiers.length === 0) {
    return;
  }
  if (!isCaseLawJurisdiction(result.country)) {
    // A stored country nobody declares a resolution policy for. Loud rather
    // than defaulted: guessing a reach would write cross-border edges on an
    // assumption, and the fix is a declaration, not a fallback.
    logger.error("case_law.citation_resolution.undeclared_jurisdiction", {
      jurisdiction: result.country,
    });
    return;
  }
  await reopenCitationsForDecisionIdentifiers(tx, {
    identifiers,
    decisionId: id,
    jurisdiction: result.country,
    decisionDate: persistedDecisionDate ?? null,
  });
};

export const reconcileStableProjection = async (
  tx: Transaction,
  { plan: { corpusPlan } }: DecisionRowWrite,
  id: SafeId<"caseLawDecision">,
  projectionLock: ActiveCorpusProjectionSourceLock | null,
): Promise<void> => {
  if (
    projectionLock === null ||
    corpusPlan.type === "postgres-mirrored" ||
    corpusPlan.type === "object-storage"
  ) {
    return;
  }
  await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
    lock: projectionLock,
    subject: { family: "case_law", entityId: id },
  });
};

/**
 * The decision's judges, in the transaction that writes the row they belong
 * to. An observation that states none leaves the stored rows alone: only a
 * source that named judges can say the decision has different ones.
 */
export const writeDecisionJudges = async (
  tx: Transaction,
  { result, judges }: DecisionRowWrite,
  writtenDecisionId: SafeId<"caseLawDecision">,
): Promise<void> => {
  if (result.judges === undefined) {
    return;
  }
  await judges.replace(tx, {
    decisionId: writtenDecisionId,
    judges: result.judges,
  });
};
