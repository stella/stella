import { panic, Result } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisionSourceIdentities,
  caseLawDecisions,
} from "@/api/db/schema";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { normalizeDecisionIdentifier } from "@/api/handlers/case-law/ingestion/citation-extractor";
import {
  DECISION_DATE_OUT_OF_BOUNDS,
  MAX_LOGGED_DECISION_DATE_LENGTH,
  MAX_SOURCE_IDENTITY_CANDIDATES,
} from "@/api/handlers/case-law/ingestion/pipeline/types";
import { planSupplementComposition } from "@/api/handlers/case-law/ingestion/supplement-composition";
import type { SafeId } from "@/api/lib/branded-types";
import { resolveDecisionCourtId } from "@/api/lib/case-law/decision-court-identity";
import { sanitizeResult } from "@/api/lib/legal-search/ingestion-normalization";
import { logger } from "@/api/lib/observability/logger";

/** An ECLI's lookup spelling, or undefined when nothing searchable remains. */
const ecliComparisonKey = (ecli: string): string | undefined =>
  normalizeDecisionIdentifier({
    type: DECISION_IDENTIFIER_TYPES.ECLI,
    value: ecli,
  }) || undefined;

type CaseLawDecisionIdentityOptions = Pick<
  IngestionResult,
  "caseNumber" | "language" | "sourceDocumentId"
> & { sourceId: SafeId<"caseLawSource"> };

const NULL_SOURCE_DOCUMENT_ID_FILTER = { isNull: true } as const;

/** Match exactly the two partial unique indexes that define source identity. */
const caseLawDecisionIdentityWhere = ({
  caseNumber,
  language,
  sourceDocumentId,
  sourceId,
}: CaseLawDecisionIdentityOptions) =>
  sourceDocumentId
    ? { sourceId: { eq: sourceId }, sourceDocumentId }
    : {
        sourceId: { eq: sourceId },
        caseNumber,
        language,
        sourceDocumentId: NULL_SOURCE_DOCUMENT_ID_FILTER,
      };

/** The adapter's observation, sanitized, and the publisher identities it names. */
export type ObservedDecision = {
  observed: IngestionResult;
  /**
   * The decision date the row is written with: the observed date, null when
   * a stated date was unusable, undefined when none was stated.
   */
  persistedDecisionDate: string | null | undefined;
  exactSourceIdentityCandidates: string[];
  repairSourceIdentityCandidates: string[];
  sourceIdentityCandidates: string[];
};

type ObserveDecisionOptions = {
  input: IngestionResult;
  sourceId: SafeId<"caseLawSource">;
};

/**
 * Sanitize the adapter's observation and name the publisher identities that
 * may already own it. Logs a stated date the row cannot carry.
 */
export const observeDecision = ({
  input,
  sourceId,
}: ObserveDecisionOptions): ObservedDecision => {
  const observed = sanitizeResult(input);
  // An adapter maps its source's court to a directory id and rejects what the
  // directory does not admit before a result gets here. One that reaches the
  // write path unresolved is an adapter defect, and writing it would store a
  // court the index cannot partition, so the run stops on it.
  const courtId = resolveDecisionCourtId(observed);
  if (Result.isError(courtId)) {
    return panic(courtId.error.message, courtId.error);
  }
  const rejectedDecisionDate =
    observed.decisionDate === undefined ? input.decisionDate : undefined;
  if (rejectedDecisionDate !== undefined) {
    logger.warn(DECISION_DATE_OUT_OF_BOUNDS, {
      sourceId,
      caseNumber: observed.caseNumber,
      decisionDate: rejectedDecisionDate.slice(
        0,
        MAX_LOGGED_DECISION_DATE_LENGTH,
      ),
    });
  }
  // The column needs all three states an observation can carry, and an
  // update omits an undefined field: a usable date is written, a stated but
  // unusable one clears the column rather than leaving in place the value it
  // was meant to replace, and an unstated one leaves the row as it is.
  const persistedDecisionDate =
    rejectedDecisionDate === undefined ? observed.decisionDate : null;
  const exactSourceIdentityCandidates = (() => {
    if (!observed.sourceDocumentId) {
      return [];
    }
    const identities = [observed.sourceDocumentId];
    if (observed.sourceDocumentIdAliases !== undefined) {
      identities.push(...observed.sourceDocumentIdAliases);
    }
    return [...new Set(identities)].toSorted();
  })();
  const repairSourceIdentityCandidates =
    observed.sourceDocumentId &&
    observed.sourceDocumentIdRepairAliases !== undefined
      ? [
          ...new Set(
            observed.sourceDocumentIdRepairAliases.filter(
              (identity) => !exactSourceIdentityCandidates.includes(identity),
            ),
          ),
        ].toSorted()
      : [];
  const sourceIdentityCandidates = [
    ...exactSourceIdentityCandidates,
    ...repairSourceIdentityCandidates,
  ].toSorted();
  if (sourceIdentityCandidates.length > MAX_SOURCE_IDENTITY_CANDIDATES) {
    panic("Too many publisher identities for one decision");
  }
  return {
    observed,
    persistedDecisionDate,
    exactSourceIdentityCandidates,
    repairSourceIdentityCandidates,
    sourceIdentityCandidates,
  };
};

const IDENTITY_COLUMNS = {
  id: true,
  // The primary reference is derived from the payload, not the payload
  // itself: an unchanged source hash cannot say the reference or its kind
  // did not change.
  caseNumber: true,
  caseNumberType: true,
  // The three fields the candidate join filters on, read so a refresh can
  // tell whether it changes which citations may honestly point here.
  citationKey: true,
  country: true,
  decisionDate: true,
  sourceDocumentId: true,
  ecli: true,
  metadata: true,
  sourceHash: true,
  sourceObservedAt: true,
  sourceObservationHash: true,
  redactedAt: true,
  corpusMirrorStatus: true,
  // The write the row records for its canonical payload, so the corpus
  // upload can refuse re-PUTting objects a settled row already proved.
  contentHash: true,
  textS3Key: true,
  normalizedS3Key: true,
  astS3Key: true,
  sourceRawS3Key: true,
  sourceRawContentType: true,
  sourceUrl: true,
} as const;

type FindExistingDecisionOptions = Pick<
  ObservedDecision,
  | "exactSourceIdentityCandidates"
  | "observed"
  | "repairSourceIdentityCandidates"
> & {
  sourceId: SafeId<"caseLawSource">;
  /** The decision the exact publisher identities are reserved for, if any. */
  exactClaimedDecisionId: SafeId<"caseLawDecision"> | undefined;
  /** The one decision the repair-only identities are reserved for, if any. */
  repairClaimedDecisionId: SafeId<"caseLawDecision"> | undefined;
};

/**
 * The stored decision this observation is, and the decision its reserved
 * identities claim. Runs under the identity locks the caller took.
 */
const findExistingDecisionTx = async (
  tx: Transaction,
  {
    exactSourceIdentityCandidates,
    observed,
    repairSourceIdentityCandidates,
    sourceId,
    exactClaimedDecisionId: reservedExactClaimedDecisionId,
    repairClaimedDecisionId,
  }: FindExistingDecisionOptions,
) => {
  let exactClaimedDecisionId = reservedExactClaimedDecisionId;
  let provisionalClaimedDecisionId =
    exactClaimedDecisionId ?? repairClaimedDecisionId;
  let provisionalIdentified = await tx.query.caseLawDecisions.findFirst({
    where:
      provisionalClaimedDecisionId === undefined
        ? caseLawDecisionIdentityWhere({
            caseNumber: observed.caseNumber,
            language: observed.language,
            sourceDocumentId: observed.sourceDocumentId,
            sourceId,
          })
        : { id: { eq: provisionalClaimedDecisionId } },
    columns: IDENTITY_COLUMNS,
  });
  if (
    exactClaimedDecisionId !== undefined &&
    provisionalIdentified === undefined
  ) {
    // A task from the previous rollout can insert the decision after a new
    // task reserved its identities but before that reservation produced a
    // row. Reconcile the durable reservation to the decision-table winner;
    // otherwise every replay targets the abandoned UUID and loses the same
    // publisher-identity uniqueness race forever.
    const rolloutWinners = await tx.query.caseLawDecisions.findMany({
      where: {
        sourceId: { eq: sourceId },
        sourceDocumentId: { in: exactSourceIdentityCandidates },
      },
      columns: IDENTITY_COLUMNS,
      limit: MAX_SOURCE_IDENTITY_CANDIDATES,
    });
    const rolloutWinnerIds = [...new Set(rolloutWinners.map(({ id }) => id))];
    if (rolloutWinnerIds.length > 1) {
      panic("Publisher identities have conflicting decision rows");
    }
    const rolloutWinner = rolloutWinners.at(0);
    if (rolloutWinner !== undefined) {
      const abandonedDecisionId = exactClaimedDecisionId;
      // audit: skip — rolling-deployment identity convergence; public data
      await tx
        .update(caseLawDecisionSourceIdentities)
        .set({ decisionId: rolloutWinner.id })
        .where(
          and(
            eq(caseLawDecisionSourceIdentities.sourceId, sourceId),
            eq(caseLawDecisionSourceIdentities.decisionId, abandonedDecisionId),
            inArray(
              caseLawDecisionSourceIdentities.sourceDocumentId,
              exactSourceIdentityCandidates,
            ),
          ),
        );
      exactClaimedDecisionId = rolloutWinner.id;
      provisionalClaimedDecisionId = rolloutWinner.id;
      provisionalIdentified = rolloutWinner;
    }
  }
  // A repair-only claim is consumable only while the decision is still
  // stored under that degraded identity. Once upgraded, the retained audit
  // mapping must not let an unrelated row reuse the heuristic fingerprint.
  const repairClaimIsCurrent =
    exactClaimedDecisionId !== undefined ||
    repairClaimedDecisionId === undefined ||
    (provisionalIdentified?.sourceDocumentId !== null &&
      provisionalIdentified?.sourceDocumentId !== undefined &&
      repairSourceIdentityCandidates.includes(
        provisionalIdentified.sourceDocumentId,
      ));
  const claimedDecisionId = repairClaimIsCurrent
    ? provisionalClaimedDecisionId
    : undefined;
  const exactIdentified =
    claimedDecisionId === provisionalClaimedDecisionId
      ? provisionalIdentified
      : await tx.query.caseLawDecisions.findFirst({
          where: caseLawDecisionIdentityWhere({
            caseNumber: observed.caseNumber,
            language: observed.language,
            sourceDocumentId: observed.sourceDocumentId,
            sourceId,
          }),
          columns: IDENTITY_COLUMNS,
        });
  const identified =
    exactIdentified ??
    (claimedDecisionId === undefined && exactSourceIdentityCandidates.length > 1
      ? await tx.query.caseLawDecisions.findFirst({
          where: {
            sourceId: { eq: sourceId },
            sourceDocumentId: {
              in: exactSourceIdentityCandidates.filter(
                (identity) => identity !== observed.sourceDocumentId,
              ),
            },
          },
          columns: IDENTITY_COLUMNS,
        })
      : undefined);

  // Adapters that learned the publisher's document id after their first
  // release may adopt a legacy null-id row, but only after proving which
  // publisher document produced it. A docket can publish siblings, so
  // encounter order is not identity.
  const legacy =
    identified || !observed.sourceDocumentId || claimedDecisionId !== undefined
      ? undefined
      : await tx.query.caseLawDecisions.findFirst({
          where: {
            sourceId: { eq: sourceId },
            caseNumber: observed.caseNumber,
            language: observed.language,
            sourceDocumentId: { isNull: true },
          },
          columns: IDENTITY_COLUMNS,
        });
  // ECLIs compare the way identifiers are looked up: an adapter release
  // may spell the same identifier with different case or separators.
  // The legacy candidate is already pinned to this exact docket.
  const legacyEcliKey =
    legacy?.ecli === null || legacy?.ecli === undefined
      ? undefined
      : ecliComparisonKey(legacy.ecli);
  const incomingEcliKeys = [observed.ecli, observed.legacyEcli].flatMap(
    (ecli) => {
      const key = ecli === undefined ? undefined : ecliComparisonKey(ecli);
      return key === undefined ? [] : [key];
    },
  );
  const ecliMatches =
    legacyEcliKey !== undefined && incomingEcliKeys.includes(legacyEcliKey);
  const legacyEcliContradicts =
    legacyEcliKey !== undefined && incomingEcliKeys.length > 0 && !ecliMatches;
  const sourceUrlMatches =
    legacy !== undefined &&
    !legacyEcliContradicts &&
    legacy.sourceUrl !== null &&
    observed.legacySourceUrls?.includes(legacy.sourceUrl) === true;
  const legacyMatches = ecliMatches || sourceUrlMatches;
  const existing = identified ?? (legacyMatches ? legacy : undefined);
  return {
    claimedDecisionId,
    existing,
  };
};

type ResolveDecisionIdentityOptions = ObservedDecision & {
  sourceId: SafeId<"caseLawSource">;
  /** The id a decision nothing stored yet is inserted under. */
  proposedDecisionId: SafeId<"caseLawDecision">;
};

/**
 * Decide which decision this observation writes, and reserve its publisher
 * identities for it, in one transaction.
 *
 * Lock exact and repair-only identities before slow raw/corpus work. Exact
 * publisher aliases are reserved below. A heuristic repair alias may adopt
 * an existing owner, but is never claimed when absent: otherwise two normal
 * identified rows with the same degraded fingerprint could collapse.
 */
export const resolveDecisionIdentityTx = async (
  tx: Transaction,
  {
    observed,
    exactSourceIdentityCandidates,
    repairSourceIdentityCandidates,
    sourceIdentityCandidates,
    sourceId,
    proposedDecisionId,
  }: ResolveDecisionIdentityOptions,
) => {
  for (const identity of sourceIdentityCandidates) {
    // SAFETY: candidates are hard-capped at eight above; sorted sequential
    // acquisition prevents deadlocks between overlapping identity sets.
    // db-await-in-loop: bounded identity lock set must be sequential
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('case_law_source_identity'), hashtext(${`${sourceId}:${identity}`}))`,
    );
  }

  const claims =
    sourceIdentityCandidates.length === 0
      ? []
      : await tx.query.caseLawDecisionSourceIdentities.findMany({
          where: {
            sourceId: { eq: sourceId },
            sourceDocumentId: { in: sourceIdentityCandidates },
          },
          columns: { decisionId: true, sourceDocumentId: true },
          limit: MAX_SOURCE_IDENTITY_CANDIDATES,
        });
  const exactClaimedDecisionIds = [
    ...new Set(
      claims
        .filter(({ sourceDocumentId }) =>
          exactSourceIdentityCandidates.includes(sourceDocumentId),
        )
        .map(({ decisionId }) => decisionId),
    ),
  ];
  if (exactClaimedDecisionIds.length > 1) {
    panic("Publisher identities have conflicting decision owners");
  }
  const exactClaimedDecisionId = exactClaimedDecisionIds.at(0);
  const repairClaimedDecisionIds = [
    ...new Set(
      claims
        .filter(({ sourceDocumentId }) =>
          repairSourceIdentityCandidates.includes(sourceDocumentId),
        )
        .map(({ decisionId }) => decisionId),
    ),
  ];
  const repairClaimedDecisionId =
    repairClaimedDecisionIds.length === 1
      ? repairClaimedDecisionIds.at(0)
      : undefined;
  const { claimedDecisionId, existing } = await findExistingDecisionTx(tx, {
    exactSourceIdentityCandidates,
    observed,
    repairSourceIdentityCandidates,
    sourceId,
    exactClaimedDecisionId,
    repairClaimedDecisionId,
  });
  const decisionId = claimedDecisionId ?? existing?.id ?? proposedDecisionId;
  const existingIdentity = existing?.sourceDocumentId ?? undefined;
  const incomingSupersedesExisting =
    observed.sourceDocumentId !== undefined &&
    (existing?.sourceDocumentId === null ||
      existing?.sourceDocumentId === observed.sourceDocumentId ||
      (existingIdentity !== undefined &&
        (observed.sourceDocumentIdAliases?.includes(existingIdentity) ===
          true ||
          observed.sourceDocumentIdRepairAliases?.includes(existingIdentity) ===
            true)));
  const persistedSourceDocumentId = incomingSupersedesExisting
    ? observed.sourceDocumentId
    : (existingIdentity ?? observed.sourceDocumentId);

  if (
    existing &&
    incomingSupersedesExisting &&
    existing.sourceDocumentId !== persistedSourceDocumentId
  ) {
    // Bind a newly learned canonical identity before any partial or
    // tombstone fast return. An inverse fallback observation never replaces
    // a previously bound canonical ID; the registry resolves it instead.
    // audit: skip — background identity repair for public case-law data
    await tx
      .update(caseLawDecisions)
      .set({
        sourceDocumentId: persistedSourceDocumentId,
        updatedAt: sql`${caseLawDecisions.updatedAt}`,
      })
      .where(eq(caseLawDecisions.id, existing.id));
  }

  if (exactSourceIdentityCandidates.length > 0) {
    // audit: skip — background publisher-identity ownership; public data
    await tx
      .insert(caseLawDecisionSourceIdentities)
      .values(
        exactSourceIdentityCandidates.map((sourceDocumentId) => ({
          sourceId,
          sourceDocumentId,
          decisionId,
        })),
      )
      .onConflictDoNothing();
  }

  // The supplements this judgment's document takes in: none for nearly
  // every decision, which the docket index answers without a row. Read in
  // this transaction rather than a later one of its own; the row write
  // checks it again under the docket lock.
  const composition = await planSupplementComposition(tx, {
    sourceId,
    decisionId,
    observation: observed,
  });

  return { existing, decisionId, persistedSourceDocumentId, composition };
};

/** Which decision an observation writes, as identity resolution decided. */
export type DecisionIdentity = Awaited<
  ReturnType<typeof resolveDecisionIdentityTx>
>;

/** The stored row identity resolution matched, as it read it. */
export type ExistingDecision = NonNullable<DecisionIdentity["existing"]>;
