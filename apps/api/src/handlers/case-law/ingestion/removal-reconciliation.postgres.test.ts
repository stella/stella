/**
 * Publisher removal crosses Postgres, derived projections, and object storage.
 * Run only against the migrated Postgres test database; skipped elsewhere.
 */
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawBrowseFacetCounts,
  caseLawCitationDoctrineReviews,
  caseLawCitationReviews,
  caseLawCitations,
  caseLawCorpusPackRefs,
  caseLawCorpusTombstones,
  caseLawCorpusUploadIntents,
  caseLawCoverageSummaries,
  caseLawDecisionAliases,
  caseLawDecisionAliasMovedIdentities,
  caseLawDecisionCitationStats,
  caseLawDecisionCitationStatsState,
  caseLawDecisionIdentifiers,
  caseLawDecisionJudges,
  caseLawDecisions,
  caseLawDecisionSourceIdentities,
  caseLawDecisionSupplements,
  caseLawIndexJobs,
  caseLawJudges,
  caseLawProvisionCitations,
  caseLawProvisionExtractions,
  caseLawRawSweeps,
  caseLawReconciliationItems,
  caseLawSearchDocumentPreviewPassages,
  caseLawSearchDocuments,
  caseLawSitemapShardCounts,
  caseLawSitemapShards,
  caseLawSourceArrivals,
  caseLawSources,
  caseLawStatuteCitationCounts,
  publishedCaseLawDecisions,
} from "@/api/db/schema";
import { createIngestionDb, markRlsDatabase } from "@/api/db/scoped";
import { redactCaseLawDecision } from "@/api/handlers/case-law/erasure";
import {
  reconcilePublisherRemovals,
  REMOVAL_RECONCILIATION_CONFIG_KEY,
  REMOVAL_SWEEP_INTERVAL_MS,
} from "@/api/handlers/case-law/ingestion/removal-reconciliation";
import type { PublisherRemovalRead } from "@/api/handlers/case-law/ingestion/removal-reconciliation";
import { redactCaseLawDecisionWithSupplementHolders } from "@/api/handlers/case-law/ingestion/supplement-erasure";
import { CITATION_REVIEW_ORIGIN } from "@/api/handlers/case-law/polarity/consts";
import { removePublisherDecision } from "@/api/handlers/case-law/publisher-removal";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { formatCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import {
  corpusKeys,
  deleteCorpusDocument,
} from "@/api/lib/legal-search/corpus-storage";
import type { RemovalCheckpoint } from "@/api/lib/legal-search/removal-reconciliation-state";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("publisher removal reconciliation (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("publisher removal reconciliation (postgres)", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    const ingestionDb = createIngestionDb(markRlsDatabase(db));
    const scopedDb: ScopedDb = async (callback) => await ingestionDb(callback);
    const sourceId = createSafeId<"caseLawSource">();
    const siblingSourceId = createSafeId<"caseLawSource">();
    const decisionId = createSafeId<"caseLawDecision">();
    const retiredAliasId = createSafeId<"caseLawDecision">();
    const siblingId = createSafeId<"caseLawDecision">();
    const judgeId = createSafeId<"caseLawJudge">();
    const previewGeneration = Bun.randomUUIDv7();
    const packKey = `legal-corpus/packs/jurisdiction=GBR/${decisionId}.stlpack`;
    const packedAst = formatCorpusLocation({
      type: "packed",
      packKey,
      offset: 0,
      length: 16,
      sha256: "d".repeat(64),
    });
    const corpusKeysForDecision = {
      ...corpusKeys({
        documentId: decisionId,
        jurisdiction: "GBR",
        contentHash: "b".repeat(64),
      }),
      astKey: packedAst,
    };
    const reservedKeys = corpusKeys({
      documentId: decisionId,
      jurisdiction: "GBR",
      contentHash: "c".repeat(64),
    });
    const corpusObjects = new Set([
      corpusKeysForDecision.textKey,
      corpusKeysForDecision.sectionsKey,
      ...Object.values(reservedKeys),
    ]);
    const failedCorpusKey = corpusKeysForDecision.sectionsKey;
    let failCorpusDeleteOnce = true;
    const deleteCorpusWithLocalObjects: typeof deleteCorpusDocument = async (
      keys,
      options,
    ) =>
      await deleteCorpusDocument(keys, {
        ...options,
        deleteObject: async (key) => {
          if (key === failedCorpusKey && failCorpusDeleteOnce) {
            failCorpusDeleteOnce = false;
            throw new Error("simulated corpus delete failure");
          }
          corpusObjects.delete(key);
        },
      });
    const sourceKey = `removal-test-${sourceId}`;
    const cycleNow = new Date("2026-10-27T12:00:00.000Z");
    let rawSweeps = 0;

    let originalSitemapCounts: (typeof caseLawSitemapShardCounts.$inferSelect)[] =
      [];
    let originalSitemapShards: (typeof caseLawSitemapShards.$inferSelect)[] =
      [];
    let originalCoverageSummary:
      typeof caseLawCoverageSummaries.$inferSelect | undefined;
    let snapshotsCaptured = false;

    const enabledRemovalConfig = {
      [REMOVAL_RECONCILIATION_CONFIG_KEY]: { status: "enabled" },
    };

    const setCheckpoint = async (state: RemovalCheckpoint) => {
      await db
        .update(caseLawSources)
        .set({ removalCheckpoint: state })
        .where(eq(caseLawSources.id, sourceId));
    };

    const startCycle = async () =>
      await setCheckpoint({
        status: "running",
        cursor: null,
        ceiling: decisionId,
      });

    const redactWithLocalRawSweep = async (options: {
      scopedDb: ScopedDb;
      decisionId: SafeId<"caseLawDecision">;
    }) =>
      await redactCaseLawDecisionWithSupplementHolders({
        ...options,
        redactDecision: async (redactOptions) =>
          await redactCaseLawDecision({
            ...redactOptions,
            deleteCorpus: deleteCorpusWithLocalObjects,
            sweepRaw: async () => {
              rawSweeps++;
              return { type: "swept", legacy: "none" };
            },
          }),
      });

    const removeWithLocalRawSweep = async (options: {
      scopedDb: ScopedDb;
      decisionId: SafeId<"caseLawDecision">;
    }) =>
      await removePublisherDecision({
        ...options,
        redact: redactWithLocalRawSweep,
      });

    const reconcile = async (options: {
      probe: (
        identity: string,
        signal: AbortSignal,
      ) => Promise<PublisherRemovalRead>;
      remove?: typeof removeWithLocalRawSweep;
    }) =>
      await reconcilePublisherRemovals({
        scopedDb,
        sourceId,
        signal: AbortSignal.timeout(10_000),
        now: () => cycleNow,
        ...options,
      });

    cleanUp(async () => {
      await db
        .delete(caseLawDecisionAliases)
        .where(eq(caseLawDecisionAliases.retiredDecisionId, retiredAliasId));
      await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
      await db
        .delete(caseLawSources)
        .where(eq(caseLawSources.id, siblingSourceId));
      if (snapshotsCaptured) {
        await db
          .delete(caseLawSitemapShardCounts)
          .where(eq(caseLawSitemapShardCounts.country, "GBR"));
        await db
          .delete(caseLawSitemapShards)
          .where(eq(caseLawSitemapShards.country, "GBR"));
        await db
          .delete(caseLawCoverageSummaries)
          .where(eq(caseLawCoverageSummaries.key, "current"));
        if (originalSitemapCounts.length > 0) {
          await db
            .insert(caseLawSitemapShardCounts)
            .values(originalSitemapCounts);
        }
        if (originalSitemapShards.length > 0) {
          await db.insert(caseLawSitemapShards).values(originalSitemapShards);
        }
        if (originalCoverageSummary !== undefined) {
          await db
            .insert(caseLawCoverageSummaries)
            .values(originalCoverageSummary);
        }
      }
    });

    test("an absent UK decision is erased from public stores and keeps its citation sibling", async () => {
      originalSitemapCounts = await db
        .select()
        .from(caseLawSitemapShardCounts)
        .where(eq(caseLawSitemapShardCounts.country, "GBR"));
      originalSitemapShards = await db
        .select()
        .from(caseLawSitemapShards)
        .where(eq(caseLawSitemapShards.country, "GBR"));
      originalCoverageSummary = (
        await db
          .select()
          .from(caseLawCoverageSummaries)
          .where(eq(caseLawCoverageSummaries.key, "current"))
          .limit(1)
      ).at(0);
      snapshotsCaptured = true;
      await db
        .delete(caseLawSitemapShardCounts)
        .where(eq(caseLawSitemapShardCounts.country, "GBR"));
      await db
        .delete(caseLawSitemapShards)
        .where(eq(caseLawSitemapShards.country, "GBR"));
      await db
        .delete(caseLawCoverageSummaries)
        .where(eq(caseLawCoverageSummaries.key, "current"));

      await db.insert(caseLawSources).values([
        caseLawSourceRow({
          id: sourceId,
          adapterKey: sourceKey,
          name: "Publisher removal source",
          config: enabledRemovalConfig,
          storedTotal: 1,
          storedTotalAsOf: cycleNow,
          storedTotalAttemptedAt: cycleNow,
          storedTotalNextRefreshAt: new Date(cycleNow.getTime() + 60_000),
        }),
        caseLawSourceRow({
          id: siblingSourceId,
          adapterKey: `removal-sibling-${siblingSourceId}`,
          name: "Publisher removal sibling source",
        }),
      ]);
      await db.insert(caseLawDecisions).values([
        {
          id: decisionId,
          sourceId,
          sourceDocumentId: "uksc/2024/900001",
          caseNumber: "[2024] UKSC 900001",
          country: "GBR",
          court: "UKSC",
          language: "en",
          fulltext: "publisher decision text",
          sourceRaw: "publisher raw response",
          sourceRawS3Key: `case-law/raw/${sourceId}/documents/${decisionId}/raw.xml`,
          sourceRawContentType: "application/xml",
          analysis: {
            version: 2,
            generatedAt: cycleNow.toISOString(),
            model: "test-model",
            inputFingerprint: "decision-input-fingerprint",
            tree: [],
          },
          metadata: { publisher: "National Archives" },
          sourceHash: "a".repeat(64),
          contentHash: "b".repeat(64),
          textS3Key: corpusKeysForDecision.textKey,
          normalizedS3Key: corpusKeysForDecision.sectionsKey,
          astS3Key: corpusKeysForDecision.astKey,
        },
        {
          id: siblingId,
          sourceId: siblingSourceId,
          sourceDocumentId: "uksc/2024/900002",
          caseNumber: "[2024] UKSC 900002",
          country: "GBR",
          court: "UKSC",
          language: "en",
          fulltext: "sibling decision text",
        },
        {
          id: retiredAliasId,
          sourceId,
          sourceDocumentId: "uksc/2024/900001-retired",
          caseNumber: "[2024] UKSC 900001-R",
          country: "GBR",
          court: "UKSC",
          language: "en",
          fulltext: "retired alias source row",
        },
      ]);
      await db.insert(caseLawDecisionAliases).values({
        retiredDecisionId: retiredAliasId,
        canonicalDecisionId: decisionId,
      });
      await db.insert(caseLawDecisionAliasMovedIdentities).values({
        retiredDecisionId: retiredAliasId,
        sourceId,
        sourceDocumentId: "uksc/2024/retired-alias-identity",
      });
      await db
        .delete(caseLawDecisions)
        .where(eq(caseLawDecisions.id, retiredAliasId));
      await db.insert(caseLawDecisionIdentifiers).values({
        decisionId,
        type: "neutral-citation",
        value: "[2024] UKSC 900001",
        normalizedValue: "2024uksc900001",
      });
      await db.insert(caseLawJudges).values({
        id: judgeId,
        country: "GBR",
        court: "UKSC",
        fullName: "Alex Example",
        nameKey: "alex example",
      });
      await db.insert(caseLawDecisionJudges).values({
        decisionId,
        judgeId,
        nameAsPrinted: "Lady Example",
        nameKey: "lady example",
        role: "rapporteur",
        position: 0,
      });
      await db.insert(caseLawDecisionSourceIdentities).values({
        sourceId,
        sourceDocumentId: "uksc/2024/900001",
        decisionId,
        sourceRawS3Key: `case-law/raw/${sourceId}/documents/${decisionId}/identity.xml`,
        sourceRawContentType: "application/xml",
      });
      await db
        .insert(caseLawCorpusPackRefs)
        .values({ decisionId, kind: "ast", packKey, location: packedAst })
        .onConflictDoNothing();
      await db.insert(caseLawCorpusUploadIntents).values({
        decisionId,
        textS3Key: reservedKeys.textKey,
        normalizedS3Key: reservedKeys.sectionsKey,
        astS3Key: reservedKeys.astKey,
        leaseExpiresAt: new Date("2032-01-01T00:00:00Z"),
      });
      await db.insert(caseLawReconciliationItems).values({
        sourceId,
        slice: "2024",
        identityKey: "document:uksc/2024/900001",
        payload: { document: "publisher decision text" },
        nextAttemptAt: cycleNow,
      });
      await db.insert(caseLawRawSweeps).values({
        decisionId,
        sourceId,
        settleAfter: cycleNow,
        nextAttemptAt: cycleNow,
      });
      await db.insert(caseLawDecisionCitationStatsState).values([
        { decisionId, status: "exact" },
        { decisionId: siblingId, status: "exact" },
      ]);
      await db.insert(caseLawCitations).values([
        {
          id: createSafeId<"caseLawCitation">(),
          citingDecisionId: decisionId,
          citedDecisionId: siblingId,
          citationText: "[2024] UKSC 900002",
        },
        {
          id: createSafeId<"caseLawCitation">(),
          citingDecisionId: siblingId,
          citedDecisionId: decisionId,
          citationText: "[2024] UKSC 900001",
        },
      ]);
      await db.insert(caseLawCitationReviews).values({
        id: createSafeId<"caseLawCitationReview">(),
        citingDecisionId: decisionId,
        citationKey: "reviewed-citation-key",
        polarity: "negative",
        reviewRef: "publisher-removal-review",
        origin: CITATION_REVIEW_ORIGIN.HUMAN_REVIEW,
      });
      await db.insert(caseLawCitationDoctrineReviews).values({
        id: createSafeId<"caseLawCitationDoctrineReview">(),
        citingDecisionId: decisionId,
        citationKey: "reviewed-citation-key",
        doctrinalTreatment: "distinguishes",
        evidenceQuote: "The facts materially differ.",
        reviewRef: "publisher-removal-doctrine-review",
        origin: CITATION_REVIEW_ORIGIN.HUMAN_REVIEW,
      });
      await db.execute(
        sql`SELECT refresh_decision_citation_stats(${decisionId}::uuid)`,
      );
      await db.execute(
        sql`SELECT refresh_decision_citation_stats(${siblingId}::uuid)`,
      );
      expect(
        await db
          .select({ decisionId: caseLawDecisionCitationStats.decisionId })
          .from(caseLawDecisionCitationStats)
          .where(eq(caseLawDecisionCitationStats.decisionId, siblingId)),
      ).not.toEqual([]);
      await db.insert(caseLawSearchDocuments).values({
        decisionId,
        title: "[2024] UKSC 900001",
        searchableText: "publisher decision text",
        language: "en",
        regconfig: "english",
      });
      await db.insert(caseLawSearchDocumentPreviewPassages).values({
        decisionId,
        generation: previewGeneration,
        ordinal: 0,
        content: "publisher decision text",
        tsv: sql`to_tsvector('simple', 'publisher decision text')`,
      });
      await db.insert(caseLawProvisionCitations).values({
        id: createSafeId<"caseLawProvisionCitation">(),
        decisionId,
        jurisdiction: "GBR",
        workIdentifier: "ukpga/2010/1",
        workNumber: 1,
        workYear: 2010,
        workCollection: "ukpga",
        workEli: "/ukpga/2010/1",
        unit: "section",
        section: 1,
        anchor: "section/1",
        sentenceText: "section 1",
        spanStart: 0,
        spanEnd: 9,
        confidence: 1,
      });
      await db
        .insert(caseLawProvisionExtractions)
        .values({
          decisionId,
          jurisdiction: "GBR",
          desiredInputDigest: Buffer.alloc(32),
          lane: "repair",
          dueAt: cycleNow,
          enqueueReason: "input",
        })
        .onConflictDoNothing();
      const ast = {
        version: 1,
        source: {
          system: "test",
          documentId: "uksc/2024/900001",
          webUrl: "https://example.test/decision",
          printUrl: "https://example.test/decision.xml",
        },
        metadata: {
          caseNumber: "[2024] UKSC 900001",
          ecli: null,
          court: "UKSC",
          decisionDate: null,
          decisionType: null,
          keywords: [],
          statutes: [],
        },
        blocks: [],
      } satisfies DocumentAst;
      await db.insert(caseLawDecisionSupplements).values({
        sourceId,
        sourceDocumentId: "uksc/2024/900001-reasons",
        kind: "reasons",
        caseNumber: "[2024] UKSC 900001",
        court: "UKSC",
        language: "en",
        judgmentDecisionTypes: [],
        documentAst: ast,
        sourceHash: "c".repeat(64),
        metadata: {},
        decisionId,
        mergedSourceHash: "merged-hash",
        observedAt: cycleNow,
      });
      expect(
        await db
          .select({ workEli: caseLawStatuteCitationCounts.workEli })
          .from(caseLawStatuteCitationCounts)
          .where(
            and(
              eq(caseLawStatuteCitationCounts.sourceId, sourceId),
              eq(caseLawStatuteCitationCounts.workEli, "/ukpga/2010/1"),
            ),
          ),
      ).not.toEqual([]);
      await db.insert(caseLawBrowseFacetCounts).values({
        kind: "country",
        country: "GBR",
        sourceId,
        value: "GBR",
        total: 1,
      });
      await db.insert(caseLawSourceArrivals).values({
        sourceId,
        addedLastWeek: 1,
        countedAt: cycleNow,
      });
      await db.insert(caseLawSitemapShardCounts).values({
        country: "GBR",
        months: {},
        pages: 1,
        countedAt: cycleNow,
      });
      await db.insert(caseLawSitemapShards).values({
        country: "GBR",
        year: "2024",
        month: "01",
        bucket: "all",
        total: 1,
        lastModifiedAt: cycleNow,
      });
      await db.insert(caseLawCoverageSummaries).values({
        key: "current",
        sourcePolicy: "[]",
        answer: { sources: [sourceId] },
        generatedAt: cycleNow,
      });
      await startCycle();

      rawSweeps = 0;
      const failedCorpusDelete = await reconcile({
        probe: async () => ({
          type: "absent",
          evidence: "publisher-typed-absence",
        }),
        remove: removeWithLocalRawSweep,
      });
      expect(failedCorpusDelete.unwrap()).toEqual({
        type: "retry",
        checked: 1,
      });
      expect(corpusObjects).toEqual(new Set([failedCorpusKey]));
      expect(
        (
          await db
            .select({
              textS3Key: caseLawDecisions.textS3Key,
              normalizedS3Key: caseLawDecisions.normalizedS3Key,
              astS3Key: caseLawDecisions.astS3Key,
            })
            .from(caseLawDecisions)
            .where(eq(caseLawDecisions.id, decisionId))
        ).at(0),
      ).toEqual({
        textS3Key: corpusKeysForDecision.textKey,
        normalizedS3Key: corpusKeysForDecision.sectionsKey,
        astS3Key: corpusKeysForDecision.astKey,
      });
      expect(
        await db
          .select({
            status: caseLawIndexJobs.status,
            errorMessage: caseLawIndexJobs.errorMessage,
          })
          .from(caseLawIndexJobs)
          .where(
            and(
              eq(caseLawIndexJobs.decisionId, decisionId),
              eq(caseLawIndexJobs.operation, "redact"),
            ),
          ),
      ).toMatchObject([
        { status: "failed", errorMessage: "simulated corpus delete failure" },
      ]);

      const crashedAfterRemoval = await reconcile({
        probe: async (identity) => {
          expect(identity).toBe("uksc/2024/900001");
          return { type: "absent", evidence: "publisher-typed-absence" };
        },
        remove: async (options) =>
          await removeWithLocalRawSweep(options).then((outcome) => {
            if (outcome.isOk() && outcome.value.type === "removed") {
              throw new Error("simulated crash before removal checkpoint");
            }
            return outcome;
          }),
      });

      expect(
        crashedAfterRemoval.isErr()
          ? Bun.inspect(crashedAfterRemoval.error)
          : "unexpected success",
      ).toContain("simulated crash before removal checkpoint");
      expect(
        (
          await db
            .select({ removalCheckpoint: caseLawSources.removalCheckpoint })
            .from(caseLawSources)
            .where(eq(caseLawSources.id, sourceId))
        ).at(0)?.removalCheckpoint,
      ).toMatchObject({
        status: "running",
        cursor: null,
        ceiling: decisionId,
      });

      let replayProbes = 0;
      const removed = await reconcile({
        probe: async () => {
          replayProbes++;
          return { type: "present", value: null };
        },
        remove: removeWithLocalRawSweep,
      });

      expect(removed.unwrap()).toEqual({ type: "complete", checked: 1 });
      expect(replayProbes).toBe(0);
      expect(rawSweeps).toBe(3);
      expect(corpusObjects).toEqual(new Set());
      expect(
        await db
          .select({ location: caseLawCorpusTombstones.location })
          .from(caseLawCorpusTombstones)
          .where(eq(caseLawCorpusTombstones.decisionId, decisionId)),
      ).toEqual([{ location: packedAst }]);
      expect(
        await db
          .select({ location: caseLawCorpusPackRefs.location })
          .from(caseLawCorpusPackRefs)
          .where(eq(caseLawCorpusPackRefs.decisionId, decisionId)),
      ).toEqual([]);
      expect(
        await db
          .select({ id: caseLawCorpusUploadIntents.id })
          .from(caseLawCorpusUploadIntents)
          .where(eq(caseLawCorpusUploadIntents.decisionId, decisionId)),
      ).toEqual([]);
      expect(
        await db
          .select({ id: caseLawReconciliationItems.id })
          .from(caseLawReconciliationItems)
          .where(eq(caseLawReconciliationItems.sourceId, sourceId)),
      ).toEqual([]);
      expect(
        await db
          .select({ status: caseLawIndexJobs.status })
          .from(caseLawIndexJobs)
          .where(
            and(
              eq(caseLawIndexJobs.decisionId, decisionId),
              eq(caseLawIndexJobs.operation, "redact"),
            ),
          ),
      ).toContainEqual({ status: "succeeded" });
      expect(
        await db
          .select({ id: publishedCaseLawDecisions.id })
          .from(publishedCaseLawDecisions)
          .where(eq(publishedCaseLawDecisions.id, decisionId)),
      ).toEqual([]);
      expect(
        await db
          .select({ id: publishedCaseLawDecisions.id })
          .from(publishedCaseLawDecisions)
          .where(eq(publishedCaseLawDecisions.id, siblingId)),
      ).toHaveLength(1);
      expect(
        await db
          .select({ citationId: caseLawCitations.id })
          .from(caseLawCitations)
          .where(
            and(
              eq(caseLawCitations.citingDecisionId, siblingId),
              eq(caseLawCitations.citedDecisionId, decisionId),
            ),
          ),
      ).toEqual([]);
      expect(
        await db
          .select({ id: caseLawCitations.id })
          .from(caseLawCitations)
          .where(eq(caseLawCitations.citingDecisionId, decisionId)),
      ).toEqual([]);
      expect(
        await db
          .select({ decisionId: caseLawDecisionIdentifiers.decisionId })
          .from(caseLawDecisionIdentifiers)
          .where(eq(caseLawDecisionIdentifiers.decisionId, decisionId)),
      ).toEqual([]);
      expect(
        await db
          .select({
            retiredDecisionId: caseLawDecisionAliases.retiredDecisionId,
            canonicalDecisionId: caseLawDecisionAliases.canonicalDecisionId,
          })
          .from(caseLawDecisionAliases)
          .where(eq(caseLawDecisionAliases.retiredDecisionId, retiredAliasId)),
      ).toEqual([
        { retiredDecisionId: retiredAliasId, canonicalDecisionId: decisionId },
      ]);
      expect(
        await db
          .select({
            retiredDecisionId:
              caseLawDecisionAliasMovedIdentities.retiredDecisionId,
            sourceDocumentId:
              caseLawDecisionAliasMovedIdentities.sourceDocumentId,
          })
          .from(caseLawDecisionAliasMovedIdentities)
          .where(
            eq(
              caseLawDecisionAliasMovedIdentities.retiredDecisionId,
              retiredAliasId,
            ),
          ),
      ).toEqual([
        {
          retiredDecisionId: retiredAliasId,
          sourceDocumentId: "uksc/2024/retired-alias-identity",
        },
      ]);
      expect(
        await db
          .select({ decisionId: caseLawRawSweeps.decisionId })
          .from(caseLawRawSweeps)
          .where(eq(caseLawRawSweeps.decisionId, decisionId)),
      ).toEqual([{ decisionId }]);
      expect(
        await db
          .select({ decisionId: caseLawDecisionJudges.decisionId })
          .from(caseLawDecisionJudges)
          .where(eq(caseLawDecisionJudges.decisionId, decisionId)),
      ).toEqual([]);
      expect(
        await db
          .select({ decisionId: caseLawProvisionCitations.decisionId })
          .from(caseLawProvisionCitations)
          .where(eq(caseLawProvisionCitations.decisionId, decisionId)),
      ).toEqual([]);
      expect(
        await db
          .select({ decisionId: caseLawProvisionExtractions.decisionId })
          .from(caseLawProvisionExtractions)
          .where(eq(caseLawProvisionExtractions.decisionId, decisionId)),
      ).toHaveLength(1);
      expect(
        await db
          .select({
            lane: caseLawProvisionExtractions.lane,
            workStatus: caseLawProvisionExtractions.workStatus,
            dueAt: caseLawProvisionExtractions.dueAt,
            enqueueReason: caseLawProvisionExtractions.enqueueReason,
          })
          .from(caseLawProvisionExtractions)
          .where(eq(caseLawProvisionExtractions.decisionId, decisionId)),
      ).toMatchObject([
        {
          lane: "repair",
          workStatus: "eligible",
          enqueueReason: "scope_retired",
        },
      ]);
      expect(
        await db
          .select({ decisionId: caseLawCitationReviews.citingDecisionId })
          .from(caseLawCitationReviews)
          .where(eq(caseLawCitationReviews.citingDecisionId, decisionId)),
      ).toEqual([]);
      expect(
        await db
          .select({
            decisionId: caseLawCitationDoctrineReviews.citingDecisionId,
          })
          .from(caseLawCitationDoctrineReviews)
          .where(
            eq(caseLawCitationDoctrineReviews.citingDecisionId, decisionId),
          ),
      ).toEqual([]);
      expect(
        await db
          .select({ decisionId: caseLawDecisionCitationStats.decisionId })
          .from(caseLawDecisionCitationStats)
          .where(eq(caseLawDecisionCitationStats.decisionId, siblingId)),
      ).toEqual([]);
      expect(
        await db
          .select({ decisionId: caseLawDecisionCitationStatsState.decisionId })
          .from(caseLawDecisionCitationStatsState)
          .where(eq(caseLawDecisionCitationStatsState.decisionId, decisionId)),
      ).toEqual([]);
      expect(
        await db
          .select({ workEli: caseLawStatuteCitationCounts.workEli })
          .from(caseLawStatuteCitationCounts)
          .where(
            and(
              eq(caseLawStatuteCitationCounts.sourceId, sourceId),
              eq(caseLawStatuteCitationCounts.workEli, "/ukpga/2010/1"),
            ),
          ),
      ).toEqual([]);
      const removedDecision = (
        await db
          .select({
            analysis: caseLawDecisions.analysis,
            metadata: caseLawDecisions.metadata,
            sourceHash: caseLawDecisions.sourceHash,
            sourceRaw: caseLawDecisions.sourceRaw,
            sourceRawS3Key: caseLawDecisions.sourceRawS3Key,
          })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.id, decisionId))
      ).at(0);
      expect(removedDecision).toEqual({
        analysis: null,
        metadata: {},
        sourceHash: null,
        sourceRaw: null,
        sourceRawS3Key: null,
      });
      expect(
        (
          await db
            .select({
              textS3Key: caseLawDecisions.textS3Key,
              normalizedS3Key: caseLawDecisions.normalizedS3Key,
              astS3Key: caseLawDecisions.astS3Key,
            })
            .from(caseLawDecisions)
            .where(eq(caseLawDecisions.id, decisionId))
        ).at(0),
      ).toEqual({ textS3Key: null, normalizedS3Key: null, astS3Key: null });
      expect(
        await db
          .select({
            decisionId: caseLawDecisionSourceIdentities.decisionId,
            key: caseLawDecisionSourceIdentities.sourceRawS3Key,
          })
          .from(caseLawDecisionSourceIdentities)
          .where(eq(caseLawDecisionSourceIdentities.decisionId, decisionId)),
      ).toMatchObject([{ decisionId, key: null }]);
      expect(
        await db
          .select({ decisionId: caseLawDecisionSupplements.decisionId })
          .from(caseLawDecisionSupplements)
          .where(eq(caseLawDecisionSupplements.decisionId, decisionId)),
      ).toEqual([]);
      expect(
        await db
          .select({ decisionId: caseLawSearchDocuments.decisionId })
          .from(caseLawSearchDocuments)
          .where(eq(caseLawSearchDocuments.decisionId, decisionId)),
      ).toEqual([]);
      expect(
        await db
          .select({
            decisionId: caseLawSearchDocumentPreviewPassages.decisionId,
          })
          .from(caseLawSearchDocumentPreviewPassages)
          .where(
            eq(caseLawSearchDocumentPreviewPassages.decisionId, decisionId),
          ),
      ).toEqual([]);
      expect(
        await db
          .select({ sourceId: caseLawBrowseFacetCounts.sourceId })
          .from(caseLawBrowseFacetCounts)
          .where(eq(caseLawBrowseFacetCounts.sourceId, sourceId)),
      ).toEqual([]);
      expect(
        await db
          .select({ sourceId: caseLawSourceArrivals.sourceId })
          .from(caseLawSourceArrivals)
          .where(eq(caseLawSourceArrivals.sourceId, sourceId)),
      ).toEqual([]);
      expect(
        await db
          .select({ country: caseLawSitemapShardCounts.country })
          .from(caseLawSitemapShardCounts)
          .where(eq(caseLawSitemapShardCounts.country, "GBR")),
      ).toEqual([]);
      expect(
        await db
          .select({ country: caseLawSitemapShards.country })
          .from(caseLawSitemapShards)
          .where(eq(caseLawSitemapShards.country, "GBR")),
      ).toEqual([]);
      expect(await db.select().from(caseLawCoverageSummaries)).toEqual([]);
      expect(
        await db
          .select({
            storedTotal: caseLawSources.storedTotal,
            storedTotalAsOf: caseLawSources.storedTotalAsOf,
            storedTotalNextRefreshAt: caseLawSources.storedTotalNextRefreshAt,
          })
          .from(caseLawSources)
          .where(eq(caseLawSources.id, sourceId)),
      ).toMatchObject([{ storedTotal: null, storedTotalAsOf: null }]);
      expect(
        await db
          .select({ removalCheckpoint: caseLawSources.removalCheckpoint })
          .from(caseLawSources)
          .where(eq(caseLawSources.id, sourceId)),
      ).toMatchObject([{ removalCheckpoint: { status: "waiting" } }]);
    });

    test("a refused publisher probe leaves the checkpoint and decision unchanged", async () => {
      const id = createSafeId<"caseLawDecision">();
      const isolatedSourceId = createSafeId<"caseLawSource">();
      await db.insert(caseLawSources).values(
        caseLawSourceRow({
          id: isolatedSourceId,
          adapterKey: `removal-refused-${isolatedSourceId}`,
          name: "Refused removal source",
          config: enabledRemovalConfig,
          removalCheckpoint: { status: "running", cursor: null, ceiling: id },
        }),
      );
      await db.insert(caseLawDecisions).values({
        id,
        sourceId: isolatedSourceId,
        sourceDocumentId: "uksc/2024/900003",
        caseNumber: "[2024] UKSC 900003",
        country: "GBR",
        court: "UKSC",
        language: "en",
        fulltext: "still present",
      });

      const outcome = await reconcilePublisherRemovals({
        scopedDb,
        sourceId: isolatedSourceId,
        signal: AbortSignal.timeout(10_000),
        now: () => cycleNow,
        probe: async () => ({
          type: "refused",
          status: 403,
          scope: "document",
          cause: { kind: "http-status", retryAfter: null },
        }),
      });

      expect(outcome.isOk() && outcome.value).toEqual({
        type: "retry",
        checked: 1,
      });
      const transient = await reconcilePublisherRemovals({
        scopedDb,
        sourceId: isolatedSourceId,
        signal: AbortSignal.timeout(10_000),
        now: () => cycleNow,
        probe: async () => ({
          type: "unavailable",
          cause: { kind: "thrown", error: "publisher timed out" },
        }),
      });
      expect(transient.isOk() && transient.value).toEqual({
        type: "retry",
        checked: 1,
      });
      expect(
        (
          await db
            .select({
              redactedAt: caseLawDecisions.redactedAt,
              fulltext: caseLawDecisions.fulltext,
            })
            .from(caseLawDecisions)
            .where(eq(caseLawDecisions.id, id))
        ).at(0),
      ).toEqual({ redactedAt: null, fulltext: "still present" });
      expect(
        (
          await db
            .select({ removalCheckpoint: caseLawSources.removalCheckpoint })
            .from(caseLawSources)
            .where(eq(caseLawSources.id, isolatedSourceId))
        ).at(0)?.removalCheckpoint,
      ).toMatchObject({ status: "running", cursor: null, ceiling: id });
      await db
        .delete(caseLawSources)
        .where(eq(caseLawSources.id, isolatedSourceId));
    });

    test("a missing removal configuration disables the probe", async () => {
      const disabledSourceId = createSafeId<"caseLawSource">();
      await db.insert(caseLawSources).values(
        caseLawSourceRow({
          id: disabledSourceId,
          adapterKey: `removal-disabled-${disabledSourceId}`,
          name: "Disabled removal source",
          config: {},
        }),
      );
      let probes = 0;

      const outcome = await reconcilePublisherRemovals({
        scopedDb,
        sourceId: disabledSourceId,
        signal: AbortSignal.timeout(10_000),
        probe: async () => {
          probes++;
          return { type: "absent", evidence: "publisher-typed-absence" };
        },
      });

      expect(outcome.isOk() && outcome.value).toEqual({
        type: "disabled",
        checked: 0,
      });
      expect(probes).toBe(0);
      await db
        .delete(caseLawSources)
        .where(eq(caseLawSources.id, disabledSourceId));
    });

    test("a bounded sweep resumes from its durable cursor and waits for the next cycle", async () => {
      const pagedSourceId = createSafeId<"caseLawSource">();
      await db.insert(caseLawSources).values(
        caseLawSourceRow({
          id: pagedSourceId,
          adapterKey: `removal-budget-${pagedSourceId}`,
          name: "Budgeted removal source",
          config: enabledRemovalConfig,
        }),
      );
      const ids = Array.from({ length: 101 }, () =>
        createSafeId<"caseLawDecision">(),
      );
      await db.insert(caseLawDecisions).values(
        ids.map((id, index) => ({
          id,
          sourceId: pagedSourceId,
          sourceDocumentId: `uksc/2024/budget-${index}`,
          caseNumber: `[2024] UKSC budget-${index}`,
          country: "GBR",
          court: "UKSC",
          language: "en",
          fulltext: "still available",
        })),
      );
      const orderedIds = (
        await db
          .select({ id: caseLawDecisions.id })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.sourceId, pagedSourceId))
          .orderBy(caseLawDecisions.id)
      ).map(({ id }) => id);
      let probes = 0;
      const run = async (now: Date) =>
        await reconcilePublisherRemovals({
          scopedDb,
          sourceId: pagedSourceId,
          signal: AbortSignal.timeout(10_000),
          now: () => now,
          probe: async () => {
            probes++;
            return { type: "present", value: null };
          },
        });

      const firstPage = await run(cycleNow);
      expect(firstPage.unwrap()).toEqual({ type: "budget", checked: 100 });
      expect(probes).toBe(100);
      expect(
        (
          await db
            .select({ removalCheckpoint: caseLawSources.removalCheckpoint })
            .from(caseLawSources)
            .where(eq(caseLawSources.id, pagedSourceId))
        ).at(0)?.removalCheckpoint,
      ).toMatchObject({
        status: "running",
        cursor: orderedIds.at(99),
        ceiling: orderedIds.at(-1),
      });

      const secondPage = await run(cycleNow);
      expect(secondPage.unwrap()).toEqual({ type: "complete", checked: 1 });
      expect(probes).toBe(101);
      expect((await run(cycleNow)).unwrap()).toEqual({
        type: "not-due",
        checked: 0,
      });
      const nextCycle = await run(
        new Date(cycleNow.getTime() + REMOVAL_SWEEP_INTERVAL_MS + 1),
      );
      expect(nextCycle.unwrap()).toEqual({ type: "budget", checked: 100 });
      expect(probes).toBe(201);
      await db
        .delete(caseLawSources)
        .where(eq(caseLawSources.id, pagedSourceId));
    });
  });
}
