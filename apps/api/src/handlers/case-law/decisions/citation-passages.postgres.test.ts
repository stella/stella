import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { CITATION_KIND } from "@/api/handlers/case-law/citation-kind";
import { POLARITY } from "@/api/handlers/case-law/polarity/consts";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { GRAPH_DIRECTION } from "@/api/lib/case-law/citation-vocabulary";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import type { PublicLawReadOptions } from "@/api/lib/public-law-read-db";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";

import { listDecisionCitationsHandler } from "./citation-graph";
import { prepareDecisionCitations } from "./citation-passages";

const databaseUrl = process.env["DATABASE_URL"];
const enabled =
  process.env["STELLA_RUN_POSTGRES_TESTS"] === "true" && Boolean(databaseUrl);

if (!databaseUrl || !enabled) {
  describe.skip("citation passage snapshot (postgres)", () => {
    test("requires the gated PostgreSQL runner", () => {
      expect(true).toBe(true);
    });
  });
} else {
  test("a citation refresh after paging keeps its evidence in the same snapshot", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db: ownerDb } = openClient();
      const { db: readerDb } = openClient();
      const { db: writerDb } = openClient();
      const sourceId = createSafeId<"caseLawSource">();
      const citingDecisionId = createSafeId<"caseLawDecision">();
      const citedDecisionId = createSafeId<"caseLawDecision">();
      const originalCitationId = createSafeId<"caseLawCitation">();
      const refreshedCitationId = createSafeId<"caseLawCitation">();
      const pageRead = Promise.withResolvers<undefined>();
      const allowEvidenceRead = Promise.withResolvers<undefined>();
      const source = caseLawSourceRow({
        adapterKey: `citation-snapshot-${Bun.randomUUIDv7()}`,
        id: sourceId,
        name: `Citation snapshot ${Bun.randomUUIDv7()}`,
      });
      const readDb: CaseLawPublicReadDb = Object.assign(
        async <T>(
          fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
          options?: PublicLawReadOptions,
        ): Promise<T> =>
          await readerDb.transaction(async (tx) => {
            if (options?.isolation === "repeatable-read") {
              await tx.execute(
                sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`,
              );
            }
            // This fixture isolates snapshot behavior from the public-role
            // grant rollout for the newer citation evidence columns.
            return await fn(tx);
          }),
        caseLawPublicReadDb,
      );
      try {
        await ownerDb.insert(caseLawSources).values(source);
        await ownerDb.insert(caseLawDecisions).values([
          {
            id: citingDecisionId,
            sourceId,
            country: "CZE",
            court: "Synthetic court",
            language: "en",
            caseNumber: "citation-snapshot-citing",
          },
          {
            id: citedDecisionId,
            sourceId,
            country: "CZE",
            court: "Synthetic court",
            language: "en",
            caseNumber: "citation-snapshot-cited",
          },
        ]);
        await ownerDb.insert(caseLawCitations).values({
          id: originalCitationId,
          citingDecisionId,
          citedDecisionId,
          citationText: "original authority",
          kind: CITATION_KIND.PRECEDENT,
          polarity: POLARITY.NEGATIVE,
          polaritySource: "review",
          citedPart: "dissent",
        });

        const preparedPromise = withRedistributableSubject(
          readDb,
          { kind: "id", id: citingDecisionId },
          async (subject) => {
            const page = await listDecisionCitationsHandler({
              subject,
              query: { direction: GRAPH_DIRECTION.cites },
            });
            if (!("items" in page)) {
              panic("Expected a citation page before refresh");
            }
            expect(page.items.map(({ id }) => id)).toEqual([
              originalCitationId,
            ]);
            pageRead.resolve(undefined);
            await allowEvidenceRead.promise;
            return await prepareDecisionCitations({
              subject,
              cursor: undefined,
              direction: "cites",
              limit: 10,
            });
          },
        );

        try {
          const pageReached = await Promise.race([
            pageRead.promise.then(() => "page" as const),
            preparedPromise.then(() => "finished" as const),
          ]);
          expect(pageReached).toBe("page");
          await writerDb.transaction(async (tx) => {
            await tx
              .delete(caseLawCitations)
              .where(eq(caseLawCitations.id, originalCitationId));
            await tx.insert(caseLawCitations).values({
              id: refreshedCitationId,
              citingDecisionId,
              citedDecisionId,
              citationText: "refreshed authority",
              kind: CITATION_KIND.PRECEDENT,
              polarity: POLARITY.POSITIVE,
              polaritySource: "rule",
              citedPart: "majority",
            });
          });
        } finally {
          allowEvidenceRead.resolve(undefined);
          await Promise.allSettled([preparedPromise]);
        }

        const prepared = await preparedPromise;
        if (prepared?.type !== "page" || prepared.evidence.type !== "ready") {
          panic("Expected a prepared citation page with evidence");
        }
        expect(prepared.page.items.map(({ id }) => id)).toEqual([
          originalCitationId,
        ]);
        expect(prepared.evidence.rows).toMatchObject([
          {
            id: originalCitationId,
            source: "review",
            citedPart: "dissent",
          },
        ]);
        expect(prepared.evidence.rows).toHaveLength(1);
        const current = await ownerDb
          .select({ id: caseLawCitations.id })
          .from(caseLawCitations)
          .where(eq(caseLawCitations.citingDecisionId, citingDecisionId));
        expect(current.map(({ id }) => id)).toEqual([refreshedCitationId]);
      } finally {
        allowEvidenceRead.resolve(undefined);
        await ownerDb
          .delete(caseLawCitations)
          .where(eq(caseLawCitations.citingDecisionId, citingDecisionId));
        await ownerDb
          .delete(caseLawDecisions)
          .where(eq(caseLawDecisions.sourceId, sourceId));
        await ownerDb
          .delete(caseLawSources)
          .where(eq(caseLawSources.id, sourceId));
      }
    });
  });
}
