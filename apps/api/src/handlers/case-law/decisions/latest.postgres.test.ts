import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import {
  createLatestDecisionsCache,
  readLatestDecisionsByCourt,
} from "@/api/handlers/case-law/decisions/latest";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { caseLawPublishedDecisionsFixtureSql } from "@/api/tests/helpers/case-law-publication-view-fixture";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("latest decisions publication checks (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  test("latest decisions apply current publication to each cached response", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const statements: { query: string; params: unknown[] }[] = [];
      const { db } = openClient({
        logger: {
          logQuery: (query, params) => statements.push({ query, params }),
        },
      });
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`CREATE TEMP TABLE case_law_sources (LIKE public.case_law_sources INCLUDING DEFAULTS) ON COMMIT DROP`,
        );
        await tx.execute(
          sql`CREATE TEMP TABLE case_law_decisions (LIKE public.case_law_decisions INCLUDING DEFAULTS) ON COMMIT DROP`,
        );
        await tx.execute(caseLawPublishedDecisionsFixtureSql);
        const sourceId = createSafeId<"caseLawSource">();
        const retainedId = createSafeId<"caseLawDecision">();
        const firstId = createSafeId<"caseLawDecision">();
        const secondId = createSafeId<"caseLawDecision">();
        const alternateId = createSafeId<"caseLawDecision">();
        const court = "Publication court";
        await tx.insert(caseLawSources).values({
          id: sourceId,
          adapterKey: "latest-publication-test",
          name: "Publication test",
        });
        await tx.insert(caseLawDecisions).values(
          [retainedId, firstId, secondId, alternateId].map((id) => ({
            id,
            sourceId,
            court,
            country: "CZE",
            language: id === alternateId ? "en" : "cs",
            languageGroupKey:
              id === alternateId || id === retainedId
                ? "latest-publication-group"
                : null,
            caseNumber: `Rozhodnutí ${id}`,
            decisionDate: "2026-10-10",
            metadata: { headnote: "Právní věta" },
            createdAt: new Date(
              id === alternateId
                ? "2026-10-12T12:00:00Z"
                : "2026-10-11T12:00:00Z",
            ),
          })),
        );
        const caseLawDb = asTestRaw<CaseLawPublicReadDb>(
          async <Value>(
            read: (readerTx: CaseLawPublicReadTransaction) => Promise<Value>,
          ) => await read(asTestRaw<CaseLawPublicReadTransaction>(tx)),
        );
        let loads = 0;
        const read = createLatestDecisionsCache(async () => {
          loads += 1;
          const courts = await readLatestDecisionsByCourt({
            caseLawDb,
            country: "CZE",
            courts: [{ court, tierLabel: "supreme" }],
          });
          statements.length = 0;
          return Result.ok({ country: "CZE", courts });
        });
        const query = { caseLawDb, country: "CZE", excludedSourceIds: [] };
        const warm = await read(query);
        if (Result.isError(warm)) {
          throw warm.error;
        }
        expect(statements).toHaveLength(1);
        expect(statements.at(0)?.params).toHaveLength(5);
        expect(
          warm.value.courts
            .flatMap(({ decisions }) => decisions.map(({ id }) => id))
            .toSorted(),
        ).toEqual([retainedId, firstId, secondId].toSorted());
        expect(
          warm.value.courts.flatMap(({ decisions }) =>
            decisions.flatMap(({ languageAlternates }) =>
              languageAlternates.map(({ id }) => id),
            ),
          ),
        ).toContain(alternateId);
        await tx
          .update(caseLawDecisions)
          .set({ redactedAt: new Date("2026-10-13T12:00:00Z") })
          .where(eq(caseLawDecisions.id, firstId));
        await tx
          .update(caseLawDecisions)
          .set({
            metadata: { _stellaPartialObservation: { isListingOnly: true } },
          })
          .where(eq(caseLawDecisions.id, secondId));
        await tx
          .update(caseLawDecisions)
          .set({ redactedAt: new Date("2026-10-13T12:00:00Z") })
          .where(eq(caseLawDecisions.id, alternateId));
        statements.length = 0;
        const current = await read(query);
        if (Result.isError(current)) {
          throw current.error;
        }
        expect(loads).toBe(1);
        expect(
          current.value.courts.flatMap(({ decisions }) =>
            decisions.map(({ id }) => id),
          ),
        ).toEqual([retainedId]);
        expect(
          current.value.courts.flatMap(({ decisions }) =>
            decisions.flatMap(({ languageAlternates }) =>
              languageAlternates.map(({ id }) => id),
            ),
          ),
        ).not.toContain(alternateId);
        expect(statements).toHaveLength(1);
        const statement = statements.at(0);
        expect(statement?.query).toContain('"case_law_published_decisions"');
        expect(statement?.query).toContain(" limit ");
        expect(statement?.params).toEqual(
          expect.arrayContaining([
            retainedId,
            firstId,
            secondId,
            alternateId,
            4,
          ]),
        );
        // Admission produces a response without changing the stored candidates.
        expect(
          warm.value.courts.flatMap(({ decisions }) => decisions),
        ).toHaveLength(3);
      });
    });
  });
}
