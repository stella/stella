import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import type { ScopedDb } from "@/api/db";
import { authRelationsPart } from "@/api/db/auth-schema";
import {
  auditLogs,
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import { ADAPTER_KEYS, PARSER_VERSION } from "@/api/handlers/case-law/consts";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline";
import type { SafeId } from "@/api/lib/branded-types";

type JsonbStorageRow = {
  storageType: string;
  version: string | null;
};

const databaseUrl = process.env["DATABASE_URL"];

const documentAst = {
  version: 1,
  source: {
    system: ADAPTER_KEYS.CZ_NS,
    documentId: "jsonb-regression",
    webUrl: "https://example.test/web",
    printUrl: "https://example.test/print",
  },
  metadata: {
    caseNumber: "28 Cdo 5171/2008",
    court: "Nejvyšší soud",
    ecli: "ECLI:CZ:NS:2009:28.CDO.5171.2008.1",
    decisionDate: "2009-08-26",
    decisionType: "rozsudek",
    keywords: [],
    statutes: [],
  },
  blocks: [
    {
      id: "b1",
      anchorId: "p1",
      type: "paragraph",
      role: "holding",
      inlines: [{ type: "text", text: "Adapter output must stay JSONB." }],
      plainText: "Adapter output must stay JSONB.",
    },
  ],
} satisfies DocumentAst;

const ingestionResult = {
  caseNumber: "28 Cdo 5171/2008",
  ecli: "ECLI:CZ:NS:2009:28.CDO.5171.2008.1",
  court: "Nejvyšší soud",
  country: "CZE",
  language: "cs",
  decisionDate: "2009-08-26",
  decisionType: "rozsudek",
  fulltext: "Adapter output must stay JSONB.",
  sourceUrl: "https://example.test/web",
  documentUrl: "https://example.test/print",
  metadata: { source: "regression" },
  rawHash: "jsonb-regression-hash",
  documentAst,
  parserVersion: PARSER_VERSION,
} satisfies IngestionResult;

if (!databaseUrl) {
  describe.skip("case-law ingestion JSONB persistence", () => {
    test("requires DATABASE_URL for the Bun SQL/Postgres regression", () => {
      expect(databaseUrl).toBeUndefined();
    });
  });
} else {
  describe("case-law ingestion JSONB persistence", () => {
    const adapterKey = `jsonb-regression-cz-ns-${Bun.randomUUIDv7()}`;
    const db = drizzle(databaseUrl, {
      relations: { ...relations, ...authRelationsPart },
      schema: {
        ...relations,
        ...authRelationsPart,
        auditLogs,
        caseLawSources,
        caseLawDecisions,
        caseLawCitations,
      },
    });
    const scopedDb: ScopedDb = async (callback) =>
      await db.transaction(async (tx) => await callback(tx));
    let sourceId: SafeId<"caseLawSource">;

    beforeAll(async () => {
      const [source] = await db
        .insert(caseLawSources)
        .values({
          adapterKey,
          name: "JSONB regression source",
          enabled: false,
        })
        .returning({ id: caseLawSources.id });

      if (!source) {
        throw new Error("expected source row");
      }

      sourceId = source.id;
    });

    afterAll(async () => {
      if (!sourceId) {
        return;
      }

      await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
    });

    test("stores adapter documentAst output as a jsonb object", async () => {
      await processDecision(ingestionResult, sourceId, scopedDb);

      const [row] = await db.execute(sql<JsonbStorageRow>`
        SELECT
          jsonb_typeof(document_ast) AS "storageType",
          document_ast ->> 'version' AS "version"
        FROM case_law_decisions
        WHERE source_id = ${sourceId}
          AND case_number = ${ingestionResult.caseNumber}
          AND language = ${ingestionResult.language}
      `);

      expect(row).toBeDefined();
      expect(row?.["storageType"]).toBe("object");
      expect(row?.["version"]).toBe("1");
    });

    test("keeps adapter documentAst as an object when refreshing a decision", async () => {
      await processDecision(ingestionResult, sourceId, scopedDb);
      await processDecision(
        {
          ...ingestionResult,
          rawHash: "jsonb-regression-hash-refresh",
          metadata: { source: "regression-refresh" },
        },
        sourceId,
        scopedDb,
      );

      const [row] = await db.execute(sql<JsonbStorageRow>`
        SELECT
          jsonb_typeof(document_ast) AS "storageType",
          document_ast ->> 'version' AS "version"
        FROM case_law_decisions
        WHERE source_id = ${sourceId}
          AND case_number = ${ingestionResult.caseNumber}
          AND language = ${ingestionResult.language}
      `);

      expect(row).toBeDefined();
      expect(row?.["storageType"]).toBe("object");
      expect(row?.["version"]).toBe("1");
    });
  });
}
