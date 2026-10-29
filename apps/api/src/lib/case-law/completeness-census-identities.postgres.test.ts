import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisionAliases,
  caseLawDecisions,
  caseLawDecisionSourceIdentities,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { readCompletenessCensusQuery } from "@/api/lib/case-law/completeness-census";
import { recordCompletenessCensus } from "@/api/lib/case-law/completeness-census-writer";
import type { ListingIdentity } from "@/api/lib/legal-search/ingestion-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("retained publisher identities (postgres)", () => {
  test("two publisher identities held by one canonical decision each count with text within their source", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("Postgres census test requires DATABASE_URL");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const sourceId = createSafeId<"caseLawSource">();
      const otherSourceId = createSafeId<"caseLawSource">();
      const canonicalId = createSafeId<"caseLawDecision">();
      const retiredId = createSafeId<"caseLawDecision">();
      const foreignId = createSafeId<"caseLawDecision">();
      const leaseToken = createSafeId<"caseLawSourceIngestionLease">();
      const scope = { first: "2026", last: "2026", expectedSlices: 1 };
      const scopedDb: ScopedDb = async (callback) =>
        await db.transaction(callback);
      await db.insert(caseLawSources).values(
        [sourceId, otherSourceId].map((id) => ({
          id,
          adapterKey: `census-identity-${id}`,
          name: "Retained publisher identity fixture",
          ingestionLeaseToken: leaseToken,
          ingestionLeaseExpiresAt: new Date(Date.now() + 3_600_000),
        })),
      );
      try {
        await db.insert(caseLawDecisions).values([
          {
            id: canonicalId,
            sourceId,
            sourceDocumentId: "survivor",
            caseNumber: "survivor",
            country: "CZE",
            court: "Fixture",
            language: "cs",
            fulltext: "Canonical decision text",
          },
          {
            id: foreignId,
            sourceId: otherSourceId,
            sourceDocumentId: "foreign",
            caseNumber: "foreign",
            country: "CZE",
            court: "Fixture",
            language: "cs",
            fulltext: "Other source text",
          },
        ]);
        await db.insert(caseLawDecisionSourceIdentities).values(
          ["publisher-first", "publisher-second"].map((sourceDocumentId) => ({
            sourceId,
            sourceDocumentId,
            decisionId: canonicalId,
          })),
        );
        const record = async (offset: number) => {
          await recordCompletenessCensus(scopedDb, {
            sourceId,
            leaseToken,
            adapterKey: "cz-ns",
            slice: "2026",
            scope,
            identities: ["publisher-first", "publisher-second"].map(
              (sourceDocumentId) => ({
                type: "document" as const,
                sourceDocumentId,
              }),
            ),
            listed: 2,
            publisherCount: 2,
            observedAt: new Date(Date.UTC(2026, 9, 16, 12, 0, 0, offset)),
          });
          const rows = await readCompletenessCensusQuery(db, [
            { id: sourceId, scope },
          ]);
          return (
            rows.get(String(sourceId)) ??
            panic("Retained identity census is absent")
          );
        };
        expect(await record(0)).toMatchObject({
          verdict: "complete",
          publisher: 2,
          stored: 2,
          withText: 2,
        });
        await db.insert(caseLawDecisions).values({
          id: retiredId,
          sourceId,
          sourceDocumentId: "retired",
          caseNumber: "retired",
          country: "CZE",
          court: "Fixture",
          language: "cs",
          fulltext: "Retired duplicate",
        });
        await db.insert(caseLawDecisionAliases).values({
          retiredDecisionId: retiredId,
          canonicalDecisionId: canonicalId,
        });
        await db
          .delete(caseLawDecisions)
          .where(eq(caseLawDecisions.id, retiredId));
        const secondIdentity = and(
          eq(caseLawDecisionSourceIdentities.sourceId, sourceId),
          eq(
            caseLawDecisionSourceIdentities.sourceDocumentId,
            "publisher-second",
          ),
        );
        await db
          .update(caseLawDecisionSourceIdentities)
          .set({ decisionId: retiredId })
          .where(secondIdentity);
        expect(await record(1)).toMatchObject({
          verdict: "complete",
          stored: 2,
          withText: 2,
        });
        await db
          .update(caseLawDecisions)
          .set({ fulltext: "" })
          .where(eq(caseLawDecisions.id, canonicalId));
        expect(await record(2)).toMatchObject({
          verdict: "incomplete",
          stored: 2,
          withText: 0,
        });
        await db
          .update(caseLawDecisionSourceIdentities)
          .set({ decisionId: foreignId })
          .where(secondIdentity);
        expect(await record(3)).toMatchObject({
          verdict: "incomplete",
          stored: 1,
          withText: 0,
        });
        await db
          .update(caseLawDecisionSourceIdentities)
          .set({ decisionId: createSafeId<"caseLawDecision">() })
          .where(secondIdentity);
        expect(await record(4)).toMatchObject({
          verdict: "incomplete",
          stored: 1,
          withText: 0,
        });
        await db.delete(caseLawDecisionSourceIdentities).where(secondIdentity);
        await db.insert(caseLawDecisionSourceIdentities).values({
          sourceId: otherSourceId,
          sourceDocumentId: "publisher-second",
          decisionId: foreignId,
        });
        expect(await record(5)).toMatchObject({
          verdict: "incomplete",
          stored: 1,
          withText: 0,
        });
      } finally {
        await db
          .delete(caseLawDecisionAliases)
          .where(eq(caseLawDecisionAliases.retiredDecisionId, retiredId));
        await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
        await db
          .delete(caseLawSources)
          .where(eq(caseLawSources.id, otherSourceId));
      }
    });
  });

  test("a case-number listing entry counts a stored decision whose detail supplied a document id, once per stored row", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("Postgres census test requires DATABASE_URL");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const sourceId = createSafeId<"caseLawSource">();
      const leaseToken = createSafeId<"caseLawSourceIngestionLease">();
      const scope = { first: "2026", last: "2026", expectedSlices: 1 };
      const scopedDb: ScopedDb = async (callback) =>
        await db.transaction(callback);
      await db.insert(caseLawSources).values({
        id: sourceId,
        adapterKey: `census-case-number-${sourceId}`,
        name: "Case-number listing fixture",
        ingestionLeaseToken: leaseToken,
        ingestionLeaseExpiresAt: new Date(Date.now() + 3_600_000),
      });
      try {
        await db.insert(caseLawDecisions).values({
          id: createSafeId<"caseLawDecision">(),
          sourceId,
          sourceDocumentId: "detail-only-id",
          caseNumber: "12 C 3/2026",
          country: "CZE",
          court: "Fixture",
          language: "cs",
          fulltext: "Decision text stored from the detail page",
        });
        const record = async (
          offset: number,
          identities: readonly ListingIdentity[],
        ) => {
          await recordCompletenessCensus(scopedDb, {
            sourceId,
            leaseToken,
            adapterKey: "cz-ns",
            slice: "2026",
            scope,
            identities,
            listed: identities.length,
            publisherCount: identities.length,
            observedAt: new Date(Date.UTC(2026, 9, 19, 12, 0, 0, offset)),
          });
          const rows = await readCompletenessCensusQuery(db, [
            { id: sourceId, scope },
          ]);
          return (
            rows.get(String(sourceId)) ?? panic("Case-number census is absent")
          );
        };
        const caseNumber = {
          type: "case-number" as const,
          caseNumber: "12 C 3/2026",
          language: "cs",
        };
        expect(await record(0, [caseNumber])).toMatchObject({
          verdict: "complete",
          publisher: 1,
          stored: 1,
          withText: 1,
        });
        // The same listing also names that row by its document id: the
        // case-number entry is then a second decision, and it is missing.
        expect(
          await record(1, [
            { type: "document" as const, sourceDocumentId: "detail-only-id" },
            caseNumber,
          ]),
        ).toMatchObject({
          verdict: "incomplete",
          publisher: 2,
          stored: 1,
          withText: 1,
        });
        // The writer reads identities in batches of 500: the claim made in the
        // first batch must still hold for the case number in the second.
        const unstored = Array.from({ length: 499 }, (_, index) => ({
          type: "document" as const,
          sourceDocumentId: `unstored-${index}`,
        }));
        expect(
          await record(2, [
            { type: "document" as const, sourceDocumentId: "detail-only-id" },
            ...unstored,
            caseNumber,
          ]),
        ).toMatchObject({
          verdict: "incomplete",
          publisher: 501,
          stored: 1,
          withText: 1,
        });
      } finally {
        await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
      }
    });
  });
});
