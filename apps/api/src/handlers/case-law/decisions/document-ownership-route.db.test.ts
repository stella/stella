import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import Elysia, { t } from "elysia";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import {
  readThroughDeferredDocument,
  type OnDemandDocumentDeps,
} from "@/api/handlers/case-law/decisions/document-on-demand";
import { createSafePublicSubjectFollowUpHandler } from "@/api/handlers/case-law/decisions/public-subject";
import { ACCOUNT_ACCESS } from "@/api/lib/api-handlers";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { tSafeId } from "@/api/lib/custom-schema";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import type { PendingDocument } from "@/api/lib/legal-search/sk-document-backfill";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("document ownership read route", () => {
    test("requires the Postgres test lane", () => {
      expect(enabled && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("document ownership read route", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    const sourceIds: SafeId<"caseLawSource">[] = [];
    const decisionIds: SafeId<"caseLawDecision">[] = [];
    cleanUp(async () => {
      if (decisionIds.length > 0) {
        await db
          .delete(caseLawDecisions)
          .where(inArray(caseLawDecisions.id, decisionIds));
      }
      if (sourceIds.length > 0) {
        await db
          .delete(caseLawSources)
          .where(inArray(caseLawSources.id, sourceIds));
      }
    });

    for (const ownership of ["busy", "lost"] as const) {
      test(`ownership ${ownership} returns HTTP 200 with decision metadata`, async () => {
        const sourceId = createSafeId<"caseLawSource">();
        const decisionId = createSafeId<"caseLawDecision">();
        await db.insert(caseLawSources).values({
          id: sourceId,
          adapterKey: `document-route-${Bun.randomUUIDv7()}`,
          name: "Document route fixture",
          enabled: false,
        });
        sourceIds.push(sourceId);
        const decision: PendingDocument = {
          id: decisionId,
          caseNumber: "1/2026",
          ecli: null,
          court: "Court",
          country: "CZE",
          decisionDate: "2026-01-01",
          decisionType: null,
          documentUrl: "https://example.test/document.pdf",
        };
        await db.insert(caseLawDecisions).values({
          ...decision,
          sourceId,
          language: "cs",
          fulltext: null,
        });
        decisionIds.push(decisionId);
        const reasons: {
          decisionId: SafeId<"caseLawDecision">;
          reason: string;
        }[] = [];
        let fetches = 0;
        const deps: OnDemandDocumentDeps = {
          recordRequest: async () =>
            panic("anonymous route must not record demand"),
          recordPacingOutcome: (id, reason) => {
            reasons.push({ decisionId: id, reason });
          },
          withFetchBudget: async (_adapterKey, operation) => ({
            status: "completed",
            value: await operation(),
          }),
          fetchDocument: async () => {
            fetches += 1;
            return { status: ownership };
          },
        };
        const definition = createSafePublicSubjectFollowUpHandler({
          config: {
            accountAccess: ACCOUNT_ACCESS.sandbox,
            mcp: { type: "internal", reason: "public_indexing" },
            cache: { kind: "none" },
            params: t.Object({ decisionId: tSafeId("caseLawDecision") }),
          },
          caseLawDb: caseLawPublicReadDb,
          locate: ({ params }) => ({ kind: "id", id: params.decisionId }),
          read: async (subject) => {
            const row = (
              await subject.tx
                .select({
                  id: caseLawDecisions.id,
                  caseNumber: caseLawDecisions.caseNumber,
                  court: caseLawDecisions.court,
                  fulltext: caseLawDecisions.fulltext,
                })
                .from(caseLawDecisions)
                .where(eq(caseLawDecisions.id, subject.id))
            ).at(0);
            return row ?? panic("read fixture missing");
          },
          followUp: async (metadata) => {
            const document = await readThroughDeferredDocument({
              decision,
              adapterKey: ADAPTER_KEYS.SK_COURTS,
              recordDemand: false,
              deps,
            });
            return {
              ...metadata,
              documentPending: document === null,
              hasDocument: document !== null,
            };
          },
        });
        const app = new Elysia().get(
          "/case/decisions/:decisionId",
          definition.handler,
          { params: definition.config.params },
        );
        const response = await app.handle(
          new Request(`http://localhost/case/decisions/${decisionId}`),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          id: decisionId,
          caseNumber: decision.caseNumber,
          court: decision.court,
          fulltext: null,
          documentPending: true,
          hasDocument: false,
        });
        expect(fetches).toBe(1);
        expect(reasons).toEqual([
          { decisionId, reason: `ownership-${ownership}` },
        ]);
        expect(
          await db.query.caseLawDecisions.findFirst({
            where: { id: { eq: decisionId } },
            columns: { fulltext: true, documentFetchAttempts: true },
          }),
        ).toEqual({ fulltext: null, documentFetchAttempts: 0 });
      });
    }
  });
}
