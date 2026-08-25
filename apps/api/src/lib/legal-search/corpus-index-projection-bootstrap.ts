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
import type { CorpusIndexManifest } from "@/api/lib/legal-search/corpus-index-manifest";
import { deriveCorpusIndexProjectionDescriptor } from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import {
  buildCorpusIndexProjectionDesiredStateValues,
  readActiveCorpusProjectionManifest,
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
  manifest: CorpusIndexManifest,
): Promise<CorpusIndexProjectionBootstrapResult> => {
  const conditions = [
    isNull(corpusIndexProjectionStates.entityId),
    ...(afterEntityId === undefined
      ? []
      : [gt(caseLawDecisions.id, afterEntityId)]),
  ];
  const rows = await tx
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
    .leftJoin(
      corpusIndexProjectionStates,
      and(
        eq(corpusIndexProjectionStates.family, "case_law"),
        eq(corpusIndexProjectionStates.generation, generation),
        eq(corpusIndexProjectionStates.entityId, caseLawDecisions.id),
      ),
    )
    .where(and(...conditions))
    .orderBy(asc(caseLawDecisions.id))
    .limit(limit)
    .for("update", { of: caseLawDecisions, skipLocked: true });
  if (rows.length === 0) {
    if (afterEntityId !== undefined) {
      return emptyBootstrapResult("range_complete", "case_law", generation);
    }
    return emptyBootstrapResult(
      (await hasUnseededCaseLawRows(tx, generation)) ? "busy" : "complete",
      "case_law",
      generation,
    );
  }

  const entityIds = rows.map(({ documentId }) => documentId);
  const sourceIds = [...new Set(rows.map(({ sourceId }) => sourceId))];
  const sourceRows = await tx
    .select({ id: caseLawSources.id, descriptor: caseLawSources.descriptor })
    .from(caseLawSources)
    .where(inArray(caseLawSources.id, sourceIds))
    .orderBy(asc(caseLawSources.id))
    .limit(sourceIds.length)
    // A source-policy writer may already hold this row after another worker
    // claimed one of its decisions. Do not wait in the opposite lock order;
    // retry the bounded claim instead.
    .for("share", { skipLocked: true });
  const descriptors = new Map(
    sourceRows.map(({ id, descriptor }) => [id, descriptor]),
  );
  if (descriptors.size !== sourceIds.length) {
    return emptyBootstrapResult("busy", "case_law", generation);
  }

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
  // this share lock, and a changed status rolls back the whole bounded claim.
  await readActiveCorpusProjectionManifest(tx, "case_law", generation, true);
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
          descriptors.get(row.sourceId) ??
            panic(
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
  manifest: CorpusIndexManifest,
): Promise<CorpusIndexProjectionBootstrapResult> => {
  const conditions = [
    isNull(corpusIndexProjectionStates.entityId),
    ...(afterEntityId === undefined
      ? []
      : [gt(legislationDocuments.id, afterEntityId)]),
  ];
  const rows = await tx
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
    .leftJoin(
      corpusIndexProjectionStates,
      and(
        eq(corpusIndexProjectionStates.family, "legislation"),
        eq(corpusIndexProjectionStates.generation, generation),
        eq(corpusIndexProjectionStates.entityId, legislationDocuments.id),
      ),
    )
    .where(and(...conditions))
    .orderBy(asc(legislationDocuments.id))
    .limit(limit)
    .for("update", { of: legislationDocuments, skipLocked: true });
  if (rows.length === 0) {
    if (afterEntityId !== undefined) {
      return emptyBootstrapResult("range_complete", "legislation", generation);
    }
    return emptyBootstrapResult(
      (await hasUnseededLegislationRows(tx, generation)) ? "busy" : "complete",
      "legislation",
      generation,
    );
  }

  const entityIds = rows.map(({ documentId }) => documentId);
  const sourceIds = [...new Set(rows.map(({ sourceId }) => sourceId))];
  const sourceRows = await tx
    .select({
      id: legislationSources.id,
      descriptor: legislationSources.descriptor,
    })
    .from(legislationSources)
    .where(inArray(legislationSources.id, sourceIds))
    .orderBy(asc(legislationSources.id))
    .limit(sourceIds.length)
    // Keep source-policy updates from deadlocking a decision-first claim.
    .for("share", { skipLocked: true });
  const descriptors = new Map(
    sourceRows.map(({ id, descriptor }) => [id, descriptor]),
  );
  if (descriptors.size !== sourceIds.length) {
    return emptyBootstrapResult("busy", "legislation", generation);
  }

  await readActiveCorpusProjectionManifest(tx, "legislation", generation, true);
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
          descriptors.get(row.sourceId) ??
            panic(
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
  const manifest = await readActiveCorpusProjectionManifest(
    tx,
    options.family,
    options.generation,
    false,
  );
  switch (options.family) {
    case "case_law":
      return await bootstrapCaseLaw(
        tx,
        options.generation,
        limit,
        options.afterEntityId,
        manifest,
      );
    case "legislation":
      return await bootstrapLegislation(
        tx,
        options.generation,
        limit,
        options.afterEntityId,
        manifest,
      );
    default:
      return options satisfies never;
  }
};
