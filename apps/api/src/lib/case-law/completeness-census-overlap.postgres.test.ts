import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { count, eq } from "drizzle-orm";
import * as v from "valibot";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { readCompletenessCensusQuery } from "@/api/lib/case-law/completeness-census";
import { sourceCensusSchema } from "@/api/lib/case-law/completeness-census-contract";
import { recordCompletenessCensus } from "@/api/lib/case-law/completeness-census-writer";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("overlapping publisher slices (postgres)", () => {
  test("source and year totals identify slice memberships while each college gates completeness", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("Postgres census test requires DATABASE_URL");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const sourceId = createSafeId<"caseLawSource">();
      const leaseToken = createSafeId<"caseLawSourceIngestionLease">();
      const scope = {
        first: "2026-a-buntet",
        last: "2026-b-gazd",
        expectedSlices: 2,
      };
      const observedAt = new Date("2026-10-16T12:00:00Z");
      const scopedDb: ScopedDb = async (callback) =>
        await db.transaction(callback);
      await db.insert(caseLawSources).values({
        id: sourceId,
        adapterKey: "hu-bhgy",
        name: "Overlapping colleges fixture",
        ingestionLeaseToken: leaseToken,
        ingestionLeaseExpiresAt: new Date(Date.now() + 3_600_000),
      });
      try {
        await db.insert(caseLawDecisions).values({
          sourceId,
          sourceDocumentId: "shared",
          caseNumber: "shared",
          country: "HUN",
          court: "Fixture",
          language: "hu",
          fulltext: "Decision text",
        });
        const observation = {
          sourceId,
          leaseToken,
          adapterKey: "hu-bhgy",
          scope,
          identities: [
            { type: "document" as const, sourceDocumentId: "shared" },
          ],
          listed: 1,
          publisherCount: 1,
          observedAt,
        };
        await recordCompletenessCensus(scopedDb, {
          ...observation,
          slice: scope.first,
        });
        await recordCompletenessCensus(scopedDb, {
          ...observation,
          slice: scope.last,
        });
        expect(
          await db
            .select({ decisions: count() })
            .from(caseLawDecisions)
            .where(eq(caseLawDecisions.sourceId, sourceId)),
        ).toEqual([{ decisions: 1 }]);
        const read = async () => {
          const rows = await readCompletenessCensusQuery(db, [
            { id: sourceId, scope },
          ]);
          return (
            rows.get(String(sourceId)) ?? panic("Overlapping census is absent")
          );
        };
        const complete = await read();
        expect(complete).toMatchObject({
          aggregateUnit: "slice-memberships",
          verdict: "complete",
          publisher: 2,
          stored: 2,
          withText: 2,
          years: [
            { year: 2026, slices: 2, publisher: 2, stored: 2, withText: 2 },
          ],
        });
        expect(v.parse(sourceCensusSchema, complete).aggregateUnit).toBe(
          "slice-memberships",
        );
        await db
          .update(caseLawDecisions)
          .set({ fulltext: "" })
          .where(eq(caseLawDecisions.sourceId, sourceId));
        await recordCompletenessCensus(scopedDb, {
          ...observation,
          slice: scope.last,
          observedAt: new Date(observedAt.getTime() + 1),
        });
        expect(await read()).toMatchObject({
          aggregateUnit: "slice-memberships",
          verdict: "incomplete",
          shortSlices: 1,
          worstSlices: [{ slice: scope.last, stored: 1, withText: 0 }],
        });
      } finally {
        await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
      }
    });
  });
});
