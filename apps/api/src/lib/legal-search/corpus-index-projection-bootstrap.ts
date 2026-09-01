import { panic } from "better-result";
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";

import { DECISION_IDENTIFIER_MAX_COUNT } from "@stll/legal-ast/decision-identifier";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
  corpusIndexProjectionStates,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { deriveCorpusIndexProjectionDescriptor } from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import {
  buildCorpusIndexProjectionDesiredStateValues,
  lockActiveCorpusProjectionManifestForMutation,
  type CorpusIndexProjectionSubject,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { isRedistributable } from "@/api/lib/legal-search/corpus-source";

/**
 * Upper bound for one bootstrap transaction. This bounds row locks and the
 * in-memory descriptor set; Plane chooses how often to call the primitive.
 */
export const CORPUS_INDEX_PROJECTION_BOOTSTRAP_MAX_BATCH_SIZE = 1000;

export type CorpusIndexProjectionBootstrapOptions =
  | {
      family: "case_law";
      generation: string;
      limit: number;
      afterEntityId?: SafeId<"caseLawDecision">;
    }
  | {
      family: "legislation";
      generation: string;
      limit: number;
      afterEntityId?: SafeId<"legislationDocument">;
    };

export type CorpusIndexProjectionBootstrapResult =
  | {
      status: "advanced";
      family: "case_law";
      generation: string;
      claimedCount: number;
      seededCount: number;
      entityIds: readonly SafeId<"caseLawDecision">[];
      nextAfterEntityId: SafeId<"caseLawDecision">;
    }
  | {
      status: "advanced";
      family: "legislation";
      generation: string;
      claimedCount: number;
      seededCount: number;
      entityIds: readonly SafeId<"legislationDocument">[];
      nextAfterEntityId: SafeId<"legislationDocument">;
    }
  | {
      status: "complete" | "busy" | "range_complete";
      family: CorpusIndexProjectionSubject["family"];
      generation: string;
      claimedCount: 0;
      seededCount: 0;
      entityIds: readonly [];
    };

const emptyBootstrapResult = (
  status: "complete" | "busy" | "range_complete",
  family: CorpusIndexProjectionSubject["family"],
  generation: string,
): CorpusIndexProjectionBootstrapResult => ({
  status,
  family,
  generation,
  claimedCount: 0,
  seededCount: 0,
  entityIds: [],
});

const validateBootstrapLimit = (limit: number): number => {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > CORPUS_INDEX_PROJECTION_BOOTSTRAP_MAX_BATCH_SIZE
  ) {
    return panic(
      `Corpus projection bootstrap limit must be an integer from 1 to ${CORPUS_INDEX_PROJECTION_BOOTSTRAP_MAX_BATCH_SIZE}`,
    );
  }
  return limit;
};

type BootstrapCaseLawRow = {
  documentId: SafeId<"caseLawDecision">;
  sourceId: SafeId<"caseLawSource">;
  jurisdiction: string;
  language: string;
  documentType: string | null;
  contentHash: string | null;
  redactedAt: Date | null;
  caseNumber: string;
  court: string;
  decisionDate: string | null;
  ecli: string | null;
  projectionEpoch: bigint;
};

type BootstrapLegislationRow = {
  documentId: SafeId<"legislationDocument">;
  sourceId: SafeId<"legislationSource">;
  jurisdiction: string;
  language: string;
  documentType: string | null;
  contentHash: string | null;
  title: string;
  status: string;
  effectiveDate: string | null;
  versionValidFrom: string | null;
  versionValidTo: string | null;
  eli: string;
  projectionEpoch: bigint;
};

const setZeroCaseLawProjectionEpochs = async (
  tx: Transaction,
  entityIds: readonly SafeId<"caseLawDecision">[],
): Promise<void> => {
  if (entityIds.length === 0) {
    return;
  }
  await tx
    .update(caseLawDecisions)
    .set({ projectionEpoch: 1n })
    .where(
      and(
        inArray(caseLawDecisions.id, entityIds),
        eq(caseLawDecisions.projectionEpoch, 0n),
      ),
    );
};

const setZeroLegislationProjectionEpochs = async (
  tx: Transaction,
  entityIds: readonly SafeId<"legislationDocument">[],
): Promise<void> => {
  if (entityIds.length === 0) {
    return;
  }
  await tx
    .update(legislationDocuments)
    .set({ projectionEpoch: 1n })
    .where(
      and(
        inArray(legislationDocuments.id, entityIds),
        eq(legislationDocuments.projectionEpoch, 0n),
      ),
    );
};

const hasUnseededCaseLawRows = async (
  tx: Transaction,
  generation: string,
): Promise<boolean> => {
  const rows = await tx
    .select({ documentId: caseLawDecisions.id })
    .from(caseLawDecisions)
    .leftJoin(
      corpusIndexProjectionStates,
      and(
        eq(corpusIndexProjectionStates.family, "case_law"),
        eq(corpusIndexProjectionStates.generation, generation),
        eq(corpusIndexProjectionStates.entityId, caseLawDecisions.id),
      ),
    )
    .where(isNull(corpusIndexProjectionStates.entityId))
    .limit(1);
  return rows.length > 0;
};

const hasUnseededLegislationRows = async (
  tx: Transaction,
  generation: string,
): Promise<boolean> => {
  const rows = await tx
    .select({ documentId: legislationDocuments.id })
    .from(legislationDocuments)
    .leftJoin(
      corpusIndexProjectionStates,
      and(
        eq(corpusIndexProjectionStates.family, "legislation"),
        eq(corpusIndexProjectionStates.generation, generation),
        eq(corpusIndexProjectionStates.entityId, legislationDocuments.id),
      ),
    )
    .where(isNull(corpusIndexProjectionStates.entityId))
    .limit(1);
  return rows.length > 0;
};

const bootstrapCaseLaw = async (
  tx: Transaction,
  generation: string,
  limit: number,
  afterEntityId: SafeId<"caseLawDecision"> | undefined,
): Promise<CorpusIndexProjectionBootstrapResult> => {
  const conditions = [
    isNull(corpusIndexProjectionStates.entityId),
    ...(afterEntityId === undefined
      ? []
      : [gt(caseLawDecisions.id, afterEntityId)]),
  ];
  const projectionConditions = [
    eq(corpusIndexProjectionStates.family, "case_law"),
    eq(corpusIndexProjectionStates.generation, generation),
    eq(corpusIndexProjectionStates.entityId, caseLawDecisions.id),
    ...(afterEntityId === undefined
      ? []
      : [gt(corpusIndexProjectionStates.entityId, afterEntityId)]),
  ];
  const candidates = await tx
    .select({
      documentId: caseLawDecisions.id,
      sourceId: caseLawDecisions.sourceId,
      sourceDescriptor: caseLawSources.descriptor,
    })
    .from(caseLawDecisions)
    .innerJoin(caseLawSources, eq(caseLawSources.id, caseLawDecisions.sourceId))
    .leftJoin(corpusIndexProjectionStates, and(...projectionConditions))
    .where(and(...conditions))
    .orderBy(asc(caseLawDecisions.id))
    .limit(limit)
    // Canonical mutations lock source policy before the decision. Bootstrap
    // uses the same order; a short policy update may delay this bounded claim.
    .for("share", { of: caseLawSources });
  if (candidates.length === 0) {
    if (afterEntityId !== undefined) {
      return emptyBootstrapResult("range_complete", "case_law", generation);
    }
    return emptyBootstrapResult(
      (await hasUnseededCaseLawRows(tx, generation)) ? "busy" : "complete",
      "case_law",
      generation,
    );
  }

  const candidateIds = candidates.map(({ documentId }) => documentId);
  const lockedRows = await tx
    .select({
      documentId: caseLawDecisions.id,
      sourceId: caseLawDecisions.sourceId,
      jurisdiction: caseLawDecisions.country,
      language: caseLawDecisions.language,
      documentType: caseLawDecisions.decisionType,
      contentHash: caseLawDecisions.contentHash,
      redactedAt: caseLawDecisions.redactedAt,
      caseNumber: caseLawDecisions.caseNumber,
      court: caseLawDecisions.court,
      decisionDate: caseLawDecisions.decisionDate,
      ecli: caseLawDecisions.ecli,
      projectionEpoch: caseLawDecisions.projectionEpoch,
    })
    .from(caseLawDecisions)
    .leftJoin(corpusIndexProjectionStates, and(...projectionConditions))
    .where(and(...conditions, inArray(caseLawDecisions.id, candidateIds)))
    .orderBy(asc(caseLawDecisions.id))
    .limit(limit)
    .for("update", { of: caseLawDecisions, skipLocked: true });
  const lockedById = new Map(lockedRows.map((row) => [row.documentId, row]));
  // Advance only across the contiguous prefix actually locked. Skipping past
  // an earlier busy row would make a keyset cursor strand it indefinitely.
  const rows: BootstrapCaseLawRow[] = [];
  for (const candidate of candidates) {
    const row = lockedById.get(candidate.documentId);
    if (row === undefined) {
      break;
    }
    rows.push(row);
  }
  if (rows.length === 0) {
    return emptyBootstrapResult("busy", "case_law", generation);
  }

  const entityIds = rows.map(({ documentId }) => documentId);
  const descriptors = new Map(
    candidates.map(({ sourceId, sourceDescriptor }) => [
      sourceId,
      sourceDescriptor,
    ]),
  );

  const identifiers = await tx
    .select({
      decisionId: caseLawDecisionIdentifiers.decisionId,
      type: caseLawDecisionIdentifiers.type,
      value: caseLawDecisionIdentifiers.value,
    })
    .from(caseLawDecisionIdentifiers)
    .where(inArray(caseLawDecisionIdentifiers.decisionId, entityIds))
    .orderBy(
      asc(caseLawDecisionIdentifiers.decisionId),
      asc(caseLawDecisionIdentifiers.type),
      asc(caseLawDecisionIdentifiers.value),
    )
    .limit(entityIds.length * DECISION_IDENTIFIER_MAX_COUNT + 1)
    .for("share");
  if (identifiers.length > entityIds.length * DECISION_IDENTIFIER_MAX_COUNT) {
    return panic(
      `Corpus projection bootstrap identifier count exceeds ${DECISION_IDENTIFIER_MAX_COUNT} per decision`,
    );
  }
  const identifiersByDecision = new Map<
    string,
    { type: string; value: string }[]
  >(entityIds.map((entityId) => [entityId, []]));
  for (const identifier of identifiers) {
    const values = identifiersByDecision.get(identifier.decisionId);
    if (values === undefined) {
      return panic(
        `Corpus projection bootstrap loaded an identifier for unclaimed decision ${identifier.decisionId}`,
      );
    }
    if (values.length >= DECISION_IDENTIFIER_MAX_COUNT) {
      return panic(
        `Corpus projection bootstrap decision exceeds ${DECISION_IDENTIFIER_MAX_COUNT} identifiers: ${identifier.decisionId}`,
      );
    }
    values.push({ type: identifier.type, value: identifier.value });
  }

  // Recheck the generation after claiming canonical rows. Retirement waits on
  // this mutation fence, and a changed status rolls back the bounded claim.
  const manifest = await lockActiveCorpusProjectionManifestForMutation(
    tx,
    "case_law",
    generation,
  );
  await setZeroCaseLawProjectionEpochs(tx, entityIds);

  const values = rows.map((row: BootstrapCaseLawRow) =>
    buildCorpusIndexProjectionDesiredStateValues({
      subject: { family: "case_law", entityId: row.documentId },
      generation,
      epoch: row.projectionEpoch === 0n ? 1n : row.projectionEpoch,
      descriptor: deriveCorpusIndexProjectionDescriptor(manifest, {
        family: "case_law",
        documentId: row.documentId,
        sourceId: row.sourceId,
        jurisdiction: row.jurisdiction,
        language: row.language,
        documentType: row.documentType,
        contentHash: row.contentHash,
        redistributionEligible: isRedistributable(
          descriptors.has(row.sourceId)
            ? (descriptors.get(row.sourceId) ?? null)
            : panic(
                `Corpus projection bootstrap lost source descriptor for case-law source ${row.sourceId}`,
              ),
        ),
        redacted: row.redactedAt !== null,
        caseNumber: row.caseNumber,
        identifiers:
          identifiersByDecision.get(row.documentId) ??
          panic(
            `Corpus projection bootstrap lost identifier state for decision ${row.documentId}`,
          ),
        court: row.court,
        decisionDate: row.decisionDate,
        ecli: row.ecli,
      }),
    }),
  );
  const inserted = await tx
    .insert(corpusIndexProjectionStates)
    .values(values)
    .returning({ entityId: corpusIndexProjectionStates.entityId });
  if (inserted.length !== rows.length) {
    return panic(
      `Corpus projection bootstrap inserted ${inserted.length} of ${rows.length} case-law states`,
    );
  }
  const lastEntityId = rows.at(-1)?.documentId;
  if (lastEntityId === undefined) {
    return panic("Corpus projection bootstrap claimed no case-law row");
  }
  return {
    status: "advanced",
    family: "case_law",
    generation,
    claimedCount: rows.length,
    seededCount: inserted.length,
    entityIds,
    nextAfterEntityId: lastEntityId,
  };
};

const bootstrapLegislation = async (
  tx: Transaction,
  generation: string,
  limit: number,
  afterEntityId: SafeId<"legislationDocument"> | undefined,
): Promise<CorpusIndexProjectionBootstrapResult> => {
  const conditions = [
    isNull(corpusIndexProjectionStates.entityId),
    ...(afterEntityId === undefined
      ? []
      : [gt(legislationDocuments.id, afterEntityId)]),
  ];
  const projectionConditions = [
    eq(corpusIndexProjectionStates.family, "legislation"),
    eq(corpusIndexProjectionStates.generation, generation),
    eq(corpusIndexProjectionStates.entityId, legislationDocuments.id),
    ...(afterEntityId === undefined
      ? []
      : [gt(corpusIndexProjectionStates.entityId, afterEntityId)]),
  ];
  const candidates = await tx
    .select({
      documentId: legislationDocuments.id,
      sourceId: legislationDocuments.sourceId,
      sourceDescriptor: legislationSources.descriptor,
    })
    .from(legislationDocuments)
    .innerJoin(
      legislationSources,
      eq(legislationSources.id, legislationDocuments.sourceId),
    )
    .leftJoin(corpusIndexProjectionStates, and(...projectionConditions))
    .where(and(...conditions))
    .orderBy(asc(legislationDocuments.id))
    .limit(limit)
    .for("share", { of: legislationSources });
  if (candidates.length === 0) {
    if (afterEntityId !== undefined) {
      return emptyBootstrapResult("range_complete", "legislation", generation);
    }
    return emptyBootstrapResult(
      (await hasUnseededLegislationRows(tx, generation)) ? "busy" : "complete",
      "legislation",
      generation,
    );
  }

  const candidateIds = candidates.map(({ documentId }) => documentId);
  const lockedRows = await tx
    .select({
      documentId: legislationDocuments.id,
      sourceId: legislationDocuments.sourceId,
      jurisdiction: legislationDocuments.country,
      language: legislationDocuments.language,
      documentType: legislationDocuments.documentType,
      contentHash: legislationDocuments.contentHash,
      title: legislationDocuments.title,
      status: legislationDocuments.status,
      effectiveDate: legislationDocuments.effectiveDate,
      versionValidFrom: legislationDocuments.versionValidFrom,
      versionValidTo: legislationDocuments.versionValidTo,
      eli: legislationDocuments.eli,
      projectionEpoch: legislationDocuments.projectionEpoch,
    })
    .from(legislationDocuments)
    .leftJoin(corpusIndexProjectionStates, and(...projectionConditions))
    .where(and(...conditions, inArray(legislationDocuments.id, candidateIds)))
    .orderBy(asc(legislationDocuments.id))
    .limit(limit)
    .for("update", { of: legislationDocuments, skipLocked: true });
  const lockedById = new Map(lockedRows.map((row) => [row.documentId, row]));
  // See the case-law path: the cursor may cross only a fully claimed prefix.
  const rows: BootstrapLegislationRow[] = [];
  for (const candidate of candidates) {
    const row = lockedById.get(candidate.documentId);
    if (row === undefined) {
      break;
    }
    rows.push(row);
  }
  if (rows.length === 0) {
    return emptyBootstrapResult("busy", "legislation", generation);
  }

  const entityIds = rows.map(({ documentId }) => documentId);
  const descriptors = new Map(
    candidates.map(({ sourceId, sourceDescriptor }) => [
      sourceId,
      sourceDescriptor,
    ]),
  );

  const manifest = await lockActiveCorpusProjectionManifestForMutation(
    tx,
    "legislation",
    generation,
  );
  await setZeroLegislationProjectionEpochs(tx, entityIds);

  const values = rows.map((row: BootstrapLegislationRow) =>
    buildCorpusIndexProjectionDesiredStateValues({
      subject: { family: "legislation", entityId: row.documentId },
      generation,
      epoch: row.projectionEpoch === 0n ? 1n : row.projectionEpoch,
      descriptor: deriveCorpusIndexProjectionDescriptor(manifest, {
        family: "legislation",
        documentId: row.documentId,
        sourceId: row.sourceId,
        jurisdiction: row.jurisdiction,
        language: row.language,
        documentType: row.documentType,
        contentHash: row.contentHash,
        redistributionEligible: isRedistributable(
          descriptors.has(row.sourceId)
            ? (descriptors.get(row.sourceId) ?? null)
            : panic(
                `Corpus projection bootstrap lost source descriptor for legislation source ${row.sourceId}`,
              ),
        ),
        title: row.title,
        status: row.status,
        effectiveDate: row.effectiveDate,
        versionValidFrom: row.versionValidFrom,
        versionValidTo: row.versionValidTo,
        eli: row.eli,
      }),
    }),
  );
  const inserted = await tx
    .insert(corpusIndexProjectionStates)
    .values(values)
    .returning({ entityId: corpusIndexProjectionStates.entityId });
  if (inserted.length !== rows.length) {
    return panic(
      `Corpus projection bootstrap inserted ${inserted.length} of ${rows.length} legislation states`,
    );
  }
  const lastEntityId = rows.at(-1)?.documentId;
  if (lastEntityId === undefined) {
    return panic("Corpus projection bootstrap claimed no legislation row");
  }
  return {
    status: "advanced",
    family: "legislation",
    generation,
    claimedCount: rows.length,
    seededCount: inserted.length,
    entityIds,
    nextAfterEntityId: lastEntityId,
  };
};

/**
 * Seed one active final generation in a bounded, replay-safe batch. The query
 * uses a keyset cursor so a large seeded prefix is not rescanned on every
 * batch. Rows skipped because another worker owns them remain eligible for a
 * later null-cursor sweep; callers reset the cursor after range_complete.
 * A busy result never advances the cursor.
 */
export const bootstrapCorpusProjectionDesiredStateBatchTx = async (
  tx: Transaction,
  options: CorpusIndexProjectionBootstrapOptions,
): Promise<CorpusIndexProjectionBootstrapResult> => {
  const limit = validateBootstrapLimit(options.limit);
  switch (options.family) {
    case "case_law":
      return await bootstrapCaseLaw(
        tx,
        options.generation,
        limit,
        options.afterEntityId,
      );
    case "legislation":
      return await bootstrapLegislation(
        tx,
        options.generation,
        limit,
        options.afterEntityId,
      );
    default:
      return options satisfies never;
  }
};
