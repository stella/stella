import { Result } from "better-result";
import { eq, sql } from "drizzle-orm";

import type { fetchWithTimeout } from "@stll/fetch";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  softLawSources,
  softLawIngestionAttempts,
  softLawDocuments,
} from "@/api/db/schema";
import { runSoftLawIngestion } from "@/api/handlers/soft-law/ingestion";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { rawSourcePayloadKey } from "@/api/lib/legal-search/raw-source-storage";
import type { WriteRawSourcePayload } from "@/api/lib/legal-search/raw-source-storage";
import type {
  SoftLawEntry,
  SoftLawDocumentInput,
  SoftLawSourceAdapter,
} from "@/api/lib/legal-search/soft-law-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

export const entry = (
  url = "https://uoou.gov.cz/a",
  title = "Doporučení",
  reference = "02/2024",
): SoftLawEntry => ({
  url,
  metadata: {
    title,
    kind: "recommendation",
    statedReference: { state: "stated", value: reference },
    issuedOn: { state: "not_stated" },
    validity: { state: "not_stated", basis: "source_stated" },
  },
  sourceDates: {},
});
export const document = (
  item: SoftLawEntry,
  content = "original",
): SoftLawDocumentInput => ({
  metadata: item.metadata,
  raw: [
    {
      role: "document",
      bytes: new TextEncoder().encode(content),
      contentType: "text/html",
    },
  ],
  text: content,
  extractionQuality: "html",
  sourceDates: item.sourceDates,
});
export const adapter = (
  entries: readonly SoftLawEntry[],
  content = "original",
) =>
  ({
    key: "soft-law-test",
    authority: "cz-uoou",
    access: {
      publisherGate: "uoou-cz",
      userAgent: "Stella/1.0 (+https://stella.example/contact)",
      window: { type: "any_time" },
    },
    discover: async () => ({ entries, nextCursor: null }),
    fetchDocument: async (item) => Result.ok(document(item, content)),
    getTotalCount: async () => ({ type: "no-count-endpoint" }),
    sliceWalk: { type: "unsupported", reason: "Complete listing" },
    sourceFields: {
      status: "declared",
      fields: {},
      listSourceFields: () => [],
    },
    sourceSurfaces: { surfaces: {} },
  }) as const satisfies SoftLawSourceAdapter;

type TestRunOptions = {
  request?: typeof fetchWithTimeout;
  now?: () => Date;
  scopedDb?: ScopedDb;
  writeRaw?: WriteRawSourcePayload;
};
export const withSource = async (
  url: string,
  fn: (options: {
    db: GatedTestDb;
    sourceId: SafeId<"softLawSource">;
    run: (
      sourceAdapter: SoftLawSourceAdapter,
      options?: TestRunOptions,
    ) => ReturnType<typeof runSoftLawIngestion>;
  }) => Promise<void>,
) =>
  await withGatedTestClients(url, async ({ openClient }) => {
    const { db } = openClient({ max: 3 });
    const sourceId = createSafeId<"softLawSource">();
    await db.insert(softLawSources).values({
      id: sourceId,
      adapterKey: `soft-law-test-${sourceId}`,
      descriptor: {
        license: "public-domain",
        attribution: null,
        allowsRedistribution: true,
        allowsDerivedAi: true,
      },
    });
    const run = async (
      sourceAdapter: SoftLawSourceAdapter,
      options: TestRunOptions = {},
    ) =>
      await runSoftLawIngestion({
        sourceId,
        adapter: { ...sourceAdapter, key: `soft-law-test-${sourceId}` },
        scopedDb:
          options.scopedDb ?? (async (work) => await db.transaction(work)),
        signal: new AbortController().signal,
        writeRaw:
          options.writeRaw ??
          (async (rawOptions) => rawSourcePayloadKey(rawOptions)),
        accessDependencies: {
          reserve: async () => undefined,
          ...(options.request ? { request: options.request } : {}),
          ...(options.now ? { now: options.now } : {}),
        },
      });
    try {
      await fn({ db, sourceId, run });
    } finally {
      await db
        .delete(softLawIngestionAttempts)
        .where(eq(softLawIngestionAttempts.sourceId, sourceId));
      await db.execute(
        sql`DELETE FROM soft_law_document_locators WHERE document_id IN (SELECT id FROM soft_law_documents WHERE source_id = ${sourceId})`,
      );
      await db.execute(
        sql`DELETE FROM soft_law_document_versions WHERE document_id IN (SELECT id FROM soft_law_documents WHERE source_id = ${sourceId})`,
      );
      await db
        .delete(softLawDocuments)
        .where(eq(softLawDocuments.sourceId, sourceId));
      await db.delete(softLawSources).where(eq(softLawSources.id, sourceId));
    }
  });
