/* eslint-disable typescript-eslint/promise-function-async -- fetch mock callbacks return Promise.resolve without being async */
/**
 * What happens to the rows a source already has when its adapter learns the
 * publisher's document id.
 *
 * Four sources keyed their rows on `(caseNumber, language)`, which names a
 * docket rather than a document: a docket that publishes several documents —
 * a plenary decision's separate opinions, a judgment and an order under one
 * case number, two courts numbering their files alike — kept one row, and
 * each document stored replaced the last one silently.
 *
 * The migration has to hold two things at once, and neither is provable from
 * the adapter alone:
 *
 *   1. A row already stored under the docket, with a null document id, is
 *      re-keyed by the next observation of the document that wrote it. It
 *      must be the same row — a new one beside it would double the corpus and
 *      leave the old row unreachable.
 *   2. Two documents under one docket become two rows from then on.
 *
 * So every case here runs the adapter's own build path against a stubbed
 * publisher and feeds what it produces to the real pipeline. A hand-written
 * `IngestionResult` would prove only that the pipeline works on the fields
 * this file chose to give it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawSources, relations } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { AdapterKey } from "@/api/handlers/case-law/consts";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { buildCzNsDecision } from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import { buildCzNssDecision } from "@/api/handlers/case-law/ingestion/adapters/cz-nss";
import type { ParsedRow } from "@/api/handlers/case-law/ingestion/adapters/cz-nss";
import { euEcjAdapter } from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import { buildSkUsDecision } from "@/api/handlers/case-law/ingestion/adapters/sk-us";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline";
import type { SafeId } from "@/api/lib/branded-types";
import { isRecord } from "@/api/lib/type-guards";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

// ── Publisher stubs ──────────────────────────────────────

/** A payload that opens like a real PDF; its body is not a parseable one. */
const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\n");

const NS_DETAIL_PAGE = `<html><body>
  <div>Rozsudek Nejvyššího soudu ze dne 28. 5. 2026, sp. zn. 30 Cdo 3000/2025.</div>
</body></html>`;

const NSS_SESSION_PAGE = `<html><body><form>
  <input type="hidden" name="__RequestVerificationToken" value="identity-test" />
</form></body></html>`;

const NSS_DOCUMENT_PAGE = `<html><body>
  <p>Nejvyšší správní soud rozhodl v senátě o kasační stížnosti.</p>
  <p>Kasační stížnost se zamítá.</p>
</body></html>`;

const nssDetailPage = (ecli: string): string => `<html><body>
  <div id="ecli"><span class="det-textval" title="${ecli}">${ecli}</span></div>
  <div id="datumvydanirozhodnuti"><span class="det-textval">10.06.2026</span></div>
</body></html>`;

/**
 * One stub for every publisher these cases touch, dispatching on the host each
 * adapter builds its own URLs from. Bodies are the shortest thing each build
 * path accepts: what is under test is which identity the result carries, not
 * how well its document parses.
 */
const installPublisherStub = (): (() => void) => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = asFetchMock(
    (input: string | URL | Request): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.startsWith("/docDownload/")) {
        return Promise.resolve(
          new Response(PDF_BYTES, {
            headers: { "Content-Type": "application/pdf" },
          }),
        );
      }
      if (url.pathname.includes("/WebPrint/")) {
        // The print page is enrichment; without it the decision still carries
        // the detail page's metadata, which is all these cases read.
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      if (url.pathname.includes("/WebSearch/")) {
        return Promise.resolve(
          new Response(NS_DETAIL_PAGE, {
            headers: { "Content-Type": "text/html" },
          }),
        );
      }
      if (url.pathname.startsWith("/DokumentDetail/Index/")) {
        const documentId = url.pathname.split("/").at(-1) ?? "";
        return Promise.resolve(
          new Response(nssDetailPage(`ECLI:CZ:NSS:2026:${documentId}`), {
            headers: { "Content-Type": "text/html" },
          }),
        );
      }
      if (url.pathname.startsWith("/DokumentOriginal/")) {
        return Promise.resolve(
          new Response(NSS_DOCUMENT_PAGE, {
            headers: { "Content-Type": "text/html" },
          }),
        );
      }
      if (url.hostname === "vyhledavac.nssoud.cz") {
        return Promise.resolve(
          new Response(NSS_SESSION_PAGE, {
            headers: { "Content-Type": "text/html" },
          }),
        );
      }
      return Promise.resolve(
        new Response(`unexpected request: ${url.toString()}`, { status: 500 }),
      );
    },
  );

  return () => {
    globalThis.fetch = originalFetch;
  };
};

// ── Per-source documents ─────────────────────────────────

const NSS_SESSION = {
  cookies: "",
  token: "identity-test",
  formFields: new Map<string, string>(),
};

const czNssRow = (documentId: string) =>
  ({
    caseNumber: "1 Az 4/2026",
    publishedCaseNumber: "1 Az 4/2026-79",
    decisionDate: "10.06.2026",
    decisionType: "Rozsudek",
    outcome: undefined,
    documentUrl: `https://vyhledavac.nssoud.cz/DokumentDetail/Index/${documentId}`,
    documentId,
  }) as const satisfies ParsedRow;

const ECJ_MANIFESTATION = new TextEncoder().encode(
  "<html><body><p>The Court (First Chamber) rules as follows.</p></body></html>",
);

/** Rebuild one CJEU variant from a stored manifestation, as a re-parse does. */
const ecjDecision = async (celex: string): Promise<IngestionResult> => {
  const outcome = await euEcjAdapter.reparseStoredRaw?.({
    raw: ECJ_MANIFESTATION,
    contentType: "application/xhtml+xml",
    caseNumber: "C-128/21",
    sourceDocumentId: null,
    language: "en",
    court: "Court of Justice",
    ecli: `ECLI:EU:C:2024:${celex.slice(-3)}`,
    decisionDate: "2024-01-18",
    decisionType: "judgment",
    sourceUrl: `https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX:${celex}`,
    documentUrl: null,
    metadata: { celex },
  });
  if (outcome?.type !== "parsed") {
    throw new Error(`eu-ecj re-parse rejected ${celex}`);
  }
  return outcome.result;
};

const skUsDocument = (documentId: string, ecli: string) => ({
  documentId,
  mkDocumentType: "Rozhodnutie - Nález",
  mkRSAPNumberOfFile: "PL. ÚS 4/2020",
  mkECLI: ecli,
  mkDateOfDecision: "03/12/2020 00:00:00",
  mkFormOfDecision: "Nález",
});

/**
 * Two documents one publisher files under one docket, built through the
 * adapter that ingests them. The pair is the point: keyed on the docket they
 * were one row, and the first of them is what the stored row was written from.
 */
type SourceCase = {
  readonly adapterKey: AdapterKey;
  readonly documents: readonly [
    () => Promise<IngestionResult>,
    () => Promise<IngestionResult>,
  ];
};

const built = async (outcome: {
  type: string;
  decision?: IngestionResult;
}): Promise<IngestionResult> => {
  if (outcome.decision === undefined) {
    throw new Error(`adapter produced no decision: ${outcome.type}`);
  }
  return await Promise.resolve(outcome.decision);
};

const SOURCE_CASES = [
  {
    adapterKey: ADAPTER_KEYS.SK_US,
    documents: [
      async () =>
        await built(
          await buildSkUsDecision(
            skUsDocument(
              "7964d54e-6708-48e9-92cc-5cc400aab1e3",
              "ECLI:SK:USSR:2020:PL.US.4.2020.1",
            ),
          ),
        ),
      async () =>
        await built(
          await buildSkUsDecision(
            skUsDocument(
              "2d6903ee-0dd6-4281-8edc-8c814a52b0b1",
              "ECLI:SK:USSR:2020:PL.US.4.2020.2",
            ),
          ),
        ),
    ],
  },
  {
    adapterKey: ADAPTER_KEYS.CZ_NS,
    documents: [
      async () =>
        await built(
          await buildCzNsDecision({
            unid: "05D11F4FB3ACC585C1258E27004D2F09",
            caseNumber: "30 Cdo 3000/2025",
          }),
        ),
      async () =>
        await built(
          await buildCzNsDecision({
            unid: "137FECBC92321C61C1258E27004D2ECB",
            caseNumber: "30 Cdo 3000/2025",
          }),
        ),
    ],
  },
  {
    adapterKey: ADAPTER_KEYS.CZ_NSS,
    documents: [
      async () =>
        await built(
          await buildCzNssDecision({
            row: czNssRow("784237"),
            session: NSS_SESSION,
            signal: AbortSignal.timeout(30_000),
          }),
        ),
      async () =>
        await built(
          await buildCzNssDecision({
            row: czNssRow("783863"),
            session: NSS_SESSION,
            signal: AbortSignal.timeout(30_000),
          }),
        ),
    ],
  },
  {
    adapterKey: ADAPTER_KEYS.EU_ECJ,
    documents: [
      async () => await ecjDecision("62021CJ0128"),
      async () => await ecjDecision("62021CO0128"),
    ],
  },
] as const satisfies readonly SourceCase[];

/**
 * The raw payload is dropped before storing: object storage is not what these
 * cases are about, and a failed upload would only add noise to them.
 */
const withoutRawPayload = (decision: IngestionResult): IngestionResult => ({
  ...decision,
  sourceRaw: undefined,
  sourceRawBytes: undefined,
  sourceRawContentType: undefined,
});

/**
 * The row this adapter used to write for that document: everything it writes
 * today, minus the identity it did not yet state.
 */
const asLegacyRow = (
  decision: IngestionResult,
  keepEcli: boolean,
): IngestionResult => ({
  ...withoutRawPayload(decision),
  legacySourceUrls: undefined,
  sourceDocumentId: undefined,
  ...(keepEcli ? {} : { ecli: undefined }),
});

type StoredRow = { id: string; sourceDocumentId: string | null };

if (!databaseUrl || !runPostgresTests) {
  describe.skip("publisher document identity migration", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("publisher document identity migration", () => {
    const db = drizzle(databaseUrl, {
      relations: { ...relations, ...authRelationsPart },
    });
    const scopedDb: ScopedDb = async (callback) =>
      await db.transaction(async (tx) => await callback(tx));
    const createdSourceIds: SafeId<"caseLawSource">[] = [];
    let restoreFetch: (() => void) | undefined;

    beforeAll(() => {
      restoreFetch = installPublisherStub();
    });

    afterAll(async () => {
      restoreFetch?.();
      for (const sourceId of createdSourceIds) {
        // oxlint-disable-next-line no-await-in-loop -- test teardown of a handful of source rows
        await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
      }
    });

    const createSource = async (
      adapterKey: AdapterKey,
    ): Promise<SafeId<"caseLawSource">> => {
      const [source] = await db
        .insert(caseLawSources)
        .values({
          adapterKey: `${adapterKey}-identity-${Bun.randomUUIDv7()}`,
          name: `${adapterKey} identity migration`,
          enabled: false,
        })
        .returning({ id: caseLawSources.id });
      if (!source) {
        throw new Error("expected source row");
      }
      createdSourceIds.push(source.id);
      return source.id;
    };

    const storedRows = async (
      sourceId: SafeId<"caseLawSource">,
    ): Promise<StoredRow[]> => {
      const rows = await db.execute(sql`
        SELECT id::text AS id, source_document_id AS "sourceDocumentId"
        FROM case_law_decisions
        WHERE source_id = ${sourceId}
        ORDER BY source_document_id
      `);
      const list = Array.isArray(rows) ? rows : [];
      return list.map((row) => ({
        id: isRecord(row) ? String(row["id"]) : "",
        sourceDocumentId:
          isRecord(row) && typeof row["sourceDocumentId"] === "string"
            ? row["sourceDocumentId"]
            : null,
      }));
    };

    const store = async (
      sourceId: SafeId<"caseLawSource">,
      input: IngestionResult,
      order: bigint,
    ): Promise<void> => {
      await processDecision({
        input,
        observationOrder: order,
        sourceId,
        scopedDb,
        observedAt: new Date(`2026-08-11T12:00:0${String(order)}.000Z`),
      });
    };

    for (const { adapterKey, documents } of SOURCE_CASES) {
      // Both shapes a stored docket-keyed row comes in. The ECLI gives the
      // pipeline a second way to recognise the document that wrote the row, so
      // the row without one is what proves the adapter's URL hint carries the
      // migration on its own.
      for (const keepEcli of [true, false]) {
        test(`${adapterKey}: a docket-keyed row is re-keyed by its own document${keepEcli ? "" : ", ECLI or no ECLI"}`, async () => {
          const sourceId = await createSource(adapterKey);
          const [firstDocument, secondDocument] = documents;
          const first = withoutRawPayload(await firstDocument());
          const second = withoutRawPayload(await secondDocument());

          expect(first.sourceDocumentId).toBeDefined();
          expect(second.sourceDocumentId).not.toBe(first.sourceDocumentId);
          // The premise of the collapse: one docket, two published documents.
          expect(second.caseNumber).toBe(first.caseNumber);
          expect(second.language).toBe(first.language);

          await store(sourceId, asLegacyRow(first, keepEcli), 1n);
          const legacy = await storedRows(sourceId);
          expect(legacy).toHaveLength(1);
          expect(legacy.at(0)?.sourceDocumentId).toBeNull();

          await store(sourceId, first, 2n);
          const rekeyed = await storedRows(sourceId);
          // Same row, now carrying the publisher's id: a second row here would
          // double every docket in the corpus and orphan the first.
          expect(rekeyed).toHaveLength(1);
          expect(rekeyed.at(0)?.id).toBe(legacy.at(0)?.id ?? "");
          expect(rekeyed.at(0)?.sourceDocumentId).toBe(
            first.sourceDocumentId ?? "",
          );

          await store(sourceId, second, 3n);
          const both = await storedRows(sourceId);
          // And the docket's other document is now a row of its own, which is
          // the collapse being undone.
          expect(both).toHaveLength(2);
          expect(both.map(({ sourceDocumentId }) => sourceDocumentId)).toEqual(
            [
              first.sourceDocumentId ?? "",
              second.sourceDocumentId ?? "",
            ].sort(),
          );
          expect(both.map(({ id }) => id)).toContain(legacy.at(0)?.id ?? "");

          // Re-observing either document changes nothing: the crawl and the
          // reconciliation both walk this source repeatedly.
          await store(sourceId, first, 4n);
          await store(sourceId, second, 5n);
          expect(await storedRows(sourceId)).toEqual(both);
        }, 60_000);
      }
    }
  });
}
