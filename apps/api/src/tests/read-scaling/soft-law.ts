import { panic } from "better-result";
import { sql } from "drizzle-orm";

import readSoftLaw from "@/api/handlers/soft-law/get";
import searchSoftLaw from "@/api/handlers/soft-law/search";
import { createSafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import {
  readSoftLawDocument,
  searchSoftLawDocuments,
} from "@/api/lib/legal-search/soft-law-read";
import { SOFT_LAW_READ_SURFACE } from "@/api/lib/legal-search/soft-law-serving";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { SOFT_LAW_TOOL_SET } from "@/api/mcp/soft-law-tools";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import type { seedEntityReadScaling } from "@/api/tests/read-scaling/entity-fixture";

type ReadFixture = Awaited<ReturnType<typeof seedEntityReadScaling>>;

const SCALING_TERM = "zqxscalingterm";
const SCALING_PAGE = 10;

const METADATA = JSON.stringify({
  title: "Scaling guideline",
  kind: "guideline",
  statedReference: { state: "not_stated" },
  issuedOn: { state: "stated", value: "2025-03-01" },
  validity: { state: "not_stated", basis: "source_stated" },
});

/** Served guidance rows for one fixture size, removed again by the returned cleanup. */
const seedServedGuidance = async (db: GatedTestDb, size: number) => {
  const sourceId = createSafeId<"softLawSource">();
  const runId = createSafeId<"systemScriptRun">();
  await db.execute(sql`INSERT INTO soft_law_sources (id, adapter_key, descriptor)
    VALUES (${sourceId}::uuid, ${`soft-law-scaling-${sourceId}`}, '{"license":"public-domain","attribution":null,"allowsRedistribution":true,"allowsDerivedAi":true}'::jsonb)`);
  await db.execute(sql`INSERT INTO soft_law_documents (
      id, source_id, identity_key, jurisdiction, authority, kind, title,
      stated_reference_state, issued_on, issued_on_state, listing_state,
      validity_state, validity_basis, first_seen_at, last_seen_at, last_seen_run
    )
    SELECT gen_random_uuid(), ${sourceId}::uuid, 'scaling-' || n, 'EU', 'eu-edpb',
      'guideline', ${`Guideline ${SCALING_TERM} `} || lpad(n::text, 6, '0'),
      'not_stated', DATE '2025-03-01', 'stated', 'listed', 'not_stated',
      'source_stated', now(), now(), ${runId}::uuid
    FROM generate_series(1, ${size}) n`);
  await db.execute(sql`INSERT INTO soft_law_document_versions (
      id, document_id, sequence, content_hash, raw_objects, metadata,
      extracted_text, extraction_quality, source_dates, observed_from
    )
    SELECT gen_random_uuid(), d.id, 1, 'scaling', '[]'::jsonb, ${METADATA}::text::jsonb,
      ${`Body of the guideline about ${SCALING_TERM}.`}, 'html', '{}'::jsonb, now()
    FROM soft_law_documents d WHERE d.source_id = ${sourceId}::uuid`);
  await db.execute(sql`INSERT INTO soft_law_document_locators (
      id, source_id, document_id, url, first_seen_at, last_seen_at,
      last_seen_run, state
    )
    SELECT gen_random_uuid(), d.source_id, d.id,
      'https://publisher.example/' || d.identity_key, now(), now(), ${runId}::uuid,
      'current'
    FROM soft_law_documents d WHERE d.source_id = ${sourceId}::uuid`);
  const rows = await db.execute(sql`SELECT id FROM soft_law_documents
    WHERE source_id = ${sourceId}::uuid ORDER BY identity_key LIMIT 1`);
  const [first] = [...rows];
  const documentId =
    isRecord(first) && typeof first["id"] === "string"
      ? first["id"]
      : panic("Soft-law scaling requires a seeded document");
  return {
    documentId,
    cleanup: async () => {
      await db.execute(sql`DELETE FROM soft_law_document_locators
        WHERE source_id = ${sourceId}::uuid`);
      await db.execute(sql`DELETE FROM soft_law_document_versions
        WHERE document_id IN (SELECT id FROM soft_law_documents WHERE source_id = ${sourceId}::uuid)`);
      await db.execute(sql`DELETE FROM soft_law_documents
        WHERE source_id = ${sourceId}::uuid`);
      await db.execute(sql`DELETE FROM soft_law_sources
        WHERE id = ${sourceId}::uuid`);
    },
  };
};

type HandlerMeasurementOptions = { size: number; db: GatedTestDb };

const brandedDocumentId = (documentId: string) =>
  asTestRaw<Parameters<typeof readSoftLawDocument>[1]["documentId"]>(
    documentId,
  );

/** One page of search while the corpus holds more matches than a page shows. */
export const softLawSearchScalingScenario = {
  name: "regulator guidance search",
  definition: searchSoftLaw,
  measure: async ({ size, db }: HandlerMeasurementOptions) => {
    const seeded = await seedServedGuidance(db, size);
    try {
      return await runWithMeasuredQueryCounter(async (counter) => {
        const page = await db.transaction(
          async (tx) =>
            await searchSoftLawDocuments(tx, {
              query: SCALING_TERM,
              surface: SOFT_LAW_READ_SURFACE.people,
              limit: SCALING_PAGE,
              offset: 0,
            }),
        );
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(page)),
          rows: page.items.length,
        };
      });
    } finally {
      await seeded.cleanup();
    }
  },
};

export const softLawReadScalingScenario = {
  name: "regulator guidance read",
  definition: readSoftLaw,
  measure: async ({ size, db }: HandlerMeasurementOptions) => {
    const seeded = await seedServedGuidance(db, size);
    try {
      return await runWithMeasuredQueryCounter(async (counter) => {
        const document = await db.transaction(
          async (tx) =>
            await readSoftLawDocument(tx, {
              documentId: brandedDocumentId(seeded.documentId),
              surface: SOFT_LAW_READ_SURFACE.people,
            }),
        );
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(document)),
          rows: document === null ? 0 : 1,
        };
      });
    } finally {
      await seeded.cleanup();
    }
  },
};

const toolPayload = (response: unknown, tool: string) => {
  const payload: unknown =
    isRecord(response) && response["status"] === "success"
      ? response["data"]
      : undefined;
  return isRecord(payload)
    ? payload
    : panic(`${tool} scaling requires a successful response`);
};

export const measureSearchGuidanceTool = async ({ db, size }: ReadFixture) => {
  const seeded = await seedServedGuidance(db, size);
  try {
    return await runWithMeasuredQueryCounter(async (counter) => {
      const response: unknown =
        await SOFT_LAW_TOOL_SET.handlers.search_guidance({
          args: { query: SCALING_TERM, limit: SCALING_PAGE },
          context: asTestRaw<
            Parameters<
              typeof SOFT_LAW_TOOL_SET.handlers.search_guidance
            >[0]["context"]
          >({
            testDependencies: {
              searchServedSoftLaw: async (
                options: Parameters<typeof searchSoftLawDocuments>[1],
              ) =>
                await db.transaction(
                  async (tx) => await searchSoftLawDocuments(tx, options),
                ),
            },
          }),
        });
      const payload = toolPayload(response, "search_guidance");
      const results = payload["results"];
      if (!isUnknownArray(results)) {
        return panic("search_guidance scaling requires a results array");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(payload)),
        rows: results.length,
      };
    });
  } finally {
    await seeded.cleanup();
  }
};

export const measureReadGuidanceTool = async ({ db, size }: ReadFixture) => {
  const seeded = await seedServedGuidance(db, size);
  try {
    return await runWithMeasuredQueryCounter(async (counter) => {
      const response: unknown = await SOFT_LAW_TOOL_SET.handlers.read_guidance({
        args: { document_id: seeded.documentId },
        context: asTestRaw<
          Parameters<
            typeof SOFT_LAW_TOOL_SET.handlers.read_guidance
          >[0]["context"]
        >({
          testDependencies: {
            readServedSoftLaw: async (
              options: Parameters<typeof readSoftLawDocument>[1],
            ) =>
              await db.transaction(
                async (tx) => await readSoftLawDocument(tx, options),
              ),
          },
        }),
      });
      const payload = toolPayload(response, "read_guidance");
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(payload)),
        rows: isRecord(payload["guidance"]) ? 1 : 0,
      };
    });
  } finally {
    await seeded.cleanup();
  }
};
