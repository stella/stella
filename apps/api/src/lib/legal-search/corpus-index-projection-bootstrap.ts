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
      /** Most rows the page may seed, from 1 to `limit`; defaults to `limit`. */
      seedLimit?: number;
      afterEntityId?: SafeId<"caseLawDecision">;
    }
  | {
      family: "legislation";
      generation: string;
      limit: number;
      /** Most rows the page may seed, from 1 to `limit`; defaults to `limit`. */
      seedLimit?: number;
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

/**
 * How many of the page's gaps it may seed. A caller that reserves its I/O
 * before the call bounds the page's writes with this; the page still walks
 * `limit` ids, so it cannot exceed them.
 */
const validateBootstrapSeedLimit = (
  seedLimit: number | undefined,
  limit: number,
): number => {
  if (seedLimit === undefined) {
    return limit;
  }
  if (!Number.isSafeInteger(seedLimit) || seedLimit < 1 || seedLimit > limit) {
    return panic(
      `Corpus projection bootstrap seed limit must be an integer from 1 to the page limit ${limit}`,
    );
  }
  return seedLimit;
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

type SeededEntityIdQuery = {
  family: CorpusIndexProjectionSubject["family"];
  generation: string;
  entityIds: string[];
};

/**
 * Which of the page's canonical ids already carry a desired state. The read is
 * a primary-key lookup bounded by the page, so it never widens with the number
 * of rows seeded so far.
 */
const selectSeededEntityIds = async (
  tx: Transaction,
  { family, generation, entityIds }: SeededEntityIdQuery,
): Promise<ReadonlySet<string>> => {
  const rows = await tx
    .select({ entityId: corpusIndexProjectionStates.entityId })
    .from(corpusIndexProjectionStates)
    .where(
      and(
        eq(corpusIndexProjectionStates.family, family),
        eq(corpusIndexProjectionStates.generation, generation),
        inArray(corpusIndexProjectionStates.entityId, entityIds),
      ),
    );
  return new Set(rows.map(({ entityId }) => entityId));
};

type CorpusBootstrapCandidate<TEntityId extends string> = {
  documentId: TEntityId;
  sourceId: string;
  sourceDescriptor: Parameters<typeof isRedistributable>[0];
};

/** One page's rows to insert; a family builds them with or without a query. */
type CorpusBootstrapDesiredState =
  (typeof corpusIndexProjectionStates.$inferInsert)[];

type CorpusBootstrapRow<TEntityId extends string> = {
  documentId: TEntityId;
  sourceId: string;
};

/** What a page did, before it is dressed in its family's branded envelope. */
type CorpusBootstrapPage<TEntityId extends string> =
  | { status: "complete" | "range_complete" | "busy" }
  | {
      status: "advanced";
      claimedCount: number;
      seededCount: number;
      entityIds: TEntityId[];
      nextAfterEntityId: TEntityId;
    };

type CorpusBootstrapPageOptions<
  TEntityId extends string,
  TRow extends CorpusBootstrapRow<TEntityId>,
> = {
  tx: Transaction;
  family: CorpusIndexProjectionSubject["family"];
  generation: string;
  /** Most of the page's gaps this batch may lock and seed. */
  seedLimit: number;
  afterEntityId: TEntityId | undefined;
  /** The page: the next `limit` canonical ids after the cursor, seeded or not. */
  selectCandidates: () => Promise<CorpusBootstrapCandidate<TEntityId>[]>;
  lockUnseededRows: (unseededIds: TEntityId[]) => Promise<TRow[]>;
  claimProjectionEpochs: (entityIds: TEntityId[]) => Promise<void>;
  buildDesiredStateValues: (input: {
    rows: TRow[];
    entityIds: TEntityId[];
    manifest: CorpusIndexManifest;
    descriptorOf: (
      sourceId: string,
    ) => CorpusBootstrapCandidate<TEntityId>["sourceDescriptor"];
  }) => CorpusBootstrapDesiredState | Promise<CorpusBootstrapDesiredState>;
};

/**
 * The page sequence both families share: read an id range, find which of its
 * ids still need a desired state, lock up to `seedLimit` of those, and seed
 * the prefix the batch can account for. Every read is bounded by the page, so
 * the cost of a page does not grow with the number of rows already seeded.
 */
const runCorpusBootstrapPage = async <
  TEntityId extends string,
  TRow extends CorpusBootstrapRow<TEntityId>,
>({
  tx,
  family,
  generation,
  seedLimit,
  afterEntityId,
  selectCandidates,
  lockUnseededRows,
  claimProjectionEpochs,
  buildDesiredStateValues,
}: CorpusBootstrapPageOptions<TEntityId, TRow>): Promise<
  CorpusBootstrapPage<TEntityId>
> => {
  const candidates = await selectCandidates();
  if (candidates.length === 0) {
    // The id range is exhausted. Whether the generation is fully seeded is a
    // question about every page of a sweep, so the caller owns it.
    return {
      status: afterEntityId === undefined ? "complete" : "range_complete",
    };
  }

  const candidateIds = candidates.map(({ documentId }) => documentId);
  const seededEntityIds = await selectSeededEntityIds(tx, {
    family,
    generation,
    entityIds: candidateIds,
  });
  const unseededIds = candidateIds.filter(
    (candidateId) => !seededEntityIds.has(candidateId),
  );
  // The page reads its whole id range but writes at most `seedLimit` rows, so
  // a caller that reserved its I/O up front can bound what a fresh region of
  // the corpus costs it.
  const seedableIds = unseededIds.slice(0, seedLimit);
  const lockedRows: TRow[] =
    seedableIds.length === 0 ? [] : await lockUnseededRows(seedableIds);
  const lockedById = new Map(lockedRows.map((row) => [row.documentId, row]));
  // Advance only across the contiguous prefix this batch accounts for: a row
  // that already has a desired state needs nothing, a locked row is ours, and
  // the first row another worker holds ends the page, because skipping past it
  // would make a keyset cursor strand it indefinitely.
  const rows: TRow[] = [];
  let pageEndEntityId: TEntityId | undefined;
  for (const candidate of candidates) {
    if (!seededEntityIds.has(candidate.documentId)) {
      if (rows.length === seedLimit) {
        // The seed budget is spent and this id is still a gap. The cursor
        // stops at the last id the batch accounted for, so the rest of the
        // range is met by the next page rather than stranded behind it.
        break;
      }
      const row = lockedById.get(candidate.documentId);
      if (row === undefined) {
        break;
      }
      rows.push(row);
    }
    pageEndEntityId = candidate.documentId;
  }
  if (pageEndEntityId === undefined) {
    return { status: "busy" };
  }
  if (rows.length === 0) {
    return {
      status: "advanced",
      claimedCount: 0,
      seededCount: 0,
      entityIds: [],
      nextAfterEntityId: pageEndEntityId,
    };
  }

  const entityIds = rows.map(({ documentId }) => documentId);
  const descriptors = new Map(
    candidates.map(({ sourceId, sourceDescriptor }) => [
      sourceId,
      sourceDescriptor,
    ]),
  );
  // Recheck the generation after claiming canonical rows. Retirement waits on
  // this mutation fence, and a changed status rolls back the bounded claim.
  const manifest = await lockActiveCorpusProjectionManifestForMutation(
    tx,
    family,
    generation,
  );
  await claimProjectionEpochs(entityIds);

  const values = await buildDesiredStateValues({
    rows,
    entityIds,
    manifest,
    // A source with no descriptor is a policy the corpus allows; a source the
    // page never read is a bug in the candidate query.
    descriptorOf: (sourceId) =>
      descriptors.has(sourceId)
        ? descriptors.get(sourceId)
        : panic(
            `Corpus projection bootstrap lost source descriptor for ${family} source ${sourceId}`,
          ),
  });
  const inserted = await tx
    .insert(corpusIndexProjectionStates)
    .values(values)
    .returning({ entityId: corpusIndexProjectionStates.entityId });
  if (inserted.length !== rows.length) {
    return panic(
      `Corpus projection bootstrap inserted ${inserted.length} of ${rows.length} ${family} states`,
    );
  }
  return {
    status: "advanced",
    claimedCount: rows.length,
    seededCount: inserted.length,
    entityIds,
    nextAfterEntityId: pageEndEntityId,
  };
};

/** The validated options one family's page runs on. */
type FamilyBootstrapOptions<TEntityId extends string> = {
  tx: Transaction;
  generation: string;
  limit: number;
  seedLimit: number;
  afterEntityId: TEntityId | undefined;
};

const bootstrapCaseLaw = async ({
  tx,
  generation,
  limit,
  seedLimit,
  afterEntityId,
}: FamilyBootstrapOptions<SafeId<"caseLawDecision">>): Promise<
  CorpusBootstrapPage<SafeId<"caseLawDecision">>
> => {
  const projectionConditions = [
    eq(corpusIndexProjectionStates.family, "case_law"),
    eq(corpusIndexProjectionStates.generation, generation),
    eq(corpusIndexProjectionStates.entityId, caseLawDecisions.id),
  ];
  return await runCorpusBootstrapPage({
    tx,
    family: "case_law",
    generation,
    seedLimit,
    afterEntityId,
    selectCandidates: async () =>
      await tx
        .select({
          documentId: caseLawDecisions.id,
          sourceId: caseLawDecisions.sourceId,
          sourceDescriptor: caseLawSources.descriptor,
        })
        .from(caseLawDecisions)
        .innerJoin(
          caseLawSources,
          eq(caseLawSources.id, caseLawDecisions.sourceId),
        )
        .where(
          afterEntityId === undefined
            ? undefined
            : gt(caseLawDecisions.id, afterEntityId),
        )
        .orderBy(asc(caseLawDecisions.id))
        .limit(limit)
        // Canonical mutations lock source policy before the decision. Bootstrap
        // uses the same order; a short policy update may delay this bounded claim.
        .for("share", { of: caseLawSources }),
    lockUnseededRows: async (unseededIds) =>
      await tx
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
          metadata: caseLawDecisions.metadata,
          projectionEpoch: caseLawDecisions.projectionEpoch,
        })
        .from(caseLawDecisions)
        .leftJoin(corpusIndexProjectionStates, and(...projectionConditions))
        .where(
          and(
            isNull(corpusIndexProjectionStates.entityId),
            inArray(caseLawDecisions.id, unseededIds),
          ),
        )
        .orderBy(asc(caseLawDecisions.id))
        .limit(seedLimit)
        .for("update", { of: caseLawDecisions, skipLocked: true }),
    claimProjectionEpochs: async (entityIds) =>
      await setZeroCaseLawProjectionEpochs(tx, entityIds),
    buildDesiredStateValues: async ({
      rows,
      entityIds,
      manifest,
      descriptorOf,
    }) => {
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
      if (
        identifiers.length >
        entityIds.length * DECISION_IDENTIFIER_MAX_COUNT
      ) {
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
      return rows.map((row) =>
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
              descriptorOf(row.sourceId),
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
            metadata: row.metadata,
          }),
        }),
      );
    },
  });
};

const bootstrapLegislation = async ({
  tx,
  generation,
  limit,
  seedLimit,
  afterEntityId,
}: FamilyBootstrapOptions<SafeId<"legislationDocument">>): Promise<
  CorpusBootstrapPage<SafeId<"legislationDocument">>
> => {
  const projectionConditions = [
    eq(corpusIndexProjectionStates.family, "legislation"),
    eq(corpusIndexProjectionStates.generation, generation),
    eq(corpusIndexProjectionStates.entityId, legislationDocuments.id),
  ];
  return await runCorpusBootstrapPage({
    tx,
    family: "legislation",
    generation,
    seedLimit,
    afterEntityId,
    selectCandidates: async () =>
      await tx
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
        .where(
          afterEntityId === undefined
            ? undefined
            : gt(legislationDocuments.id, afterEntityId),
        )
        .orderBy(asc(legislationDocuments.id))
        .limit(limit)
        .for("share", { of: legislationSources }),
    lockUnseededRows: async (unseededIds) =>
      await tx
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
        .where(
          and(
            isNull(corpusIndexProjectionStates.entityId),
            inArray(legislationDocuments.id, unseededIds),
          ),
        )
        .orderBy(asc(legislationDocuments.id))
        .limit(seedLimit)
        .for("update", { of: legislationDocuments, skipLocked: true }),
    claimProjectionEpochs: async (entityIds) =>
      await setZeroLegislationProjectionEpochs(tx, entityIds),
    buildDesiredStateValues: ({ rows, manifest, descriptorOf }) =>
      rows.map((row) =>
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
              descriptorOf(row.sourceId),
            ),
            title: row.title,
            status: row.status,
            effectiveDate: row.effectiveDate,
            versionValidFrom: row.versionValidFrom,
            versionValidTo: row.versionValidTo,
            eli: row.eli,
          }),
        }),
      ),
  });
};

/**
 * Seed one active final generation in a bounded, replay-safe batch. A page is
 * the next `limit` canonical ids after the keyset cursor, and only the ids in
 * that page that still lack a desired state are locked and seeded, so a page
 * costs its limit however much of the corpus is already seeded. The cursor
 * crosses the whole page even when it seeds nothing. Rows skipped because
 * another worker owns them remain eligible for a later null-cursor sweep;
 * callers reset the cursor after range_complete. A busy result never advances
 * the cursor.
 *
 * `seedLimit` bounds the writes as `limit` bounds the reads: a caller that
 * reserves its I/O before the call needs a page over a fresh region to cost
 * no more than it reserved. The page still walks `limit` ids; when its seed
 * budget runs out with gaps left in the range, the cursor advances only to
 * the last id it accounted for, and the next page meets the rest.
 *
 * Every page reads only its own id range, so no page can tell that a
 * generation is fully seeded; complete means the corpus holds no rows at all.
 * A caller concludes a generation is seeded from a whole sweep that claimed
 * nothing and met no busy page.
 */
export const bootstrapCorpusProjectionDesiredStateBatchTx = async (
  tx: Transaction,
  options: CorpusIndexProjectionBootstrapOptions,
): Promise<CorpusIndexProjectionBootstrapResult> => {
  const limit = validateBootstrapLimit(options.limit);
  const seedLimit = validateBootstrapSeedLimit(options.seedLimit, limit);
  const { generation } = options;
  switch (options.family) {
    case "case_law": {
      const page = await bootstrapCaseLaw({
        tx,
        generation,
        limit,
        seedLimit,
        afterEntityId: options.afterEntityId,
      });
      if (page.status !== "advanced") {
        return emptyBootstrapResult(page.status, "case_law", generation);
      }
      return {
        status: "advanced",
        family: "case_law",
        generation,
        claimedCount: page.claimedCount,
        seededCount: page.seededCount,
        entityIds: page.entityIds,
        nextAfterEntityId: page.nextAfterEntityId,
      };
    }
    case "legislation": {
      const page = await bootstrapLegislation({
        tx,
        generation,
        limit,
        seedLimit,
        afterEntityId: options.afterEntityId,
      });
      if (page.status !== "advanced") {
        return emptyBootstrapResult(page.status, "legislation", generation);
      }
      return {
        status: "advanced",
        family: "legislation",
        generation,
        claimedCount: page.claimedCount,
        seededCount: page.seededCount,
        entityIds: page.entityIds,
        nextAfterEntityId: page.nextAfterEntityId,
      };
    }
    default:
      options satisfies never;
      return panic(`Unhandled options: ${String(options)}`);
  }
};
