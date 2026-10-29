import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, getTableColumns, sql } from "drizzle-orm";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import type { SourceAdapter } from "@/api/handlers/case-law/ingestion/adapter";
import { processStoredReplayDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import { PROCESS_DECISION_STATUS } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import {
  STORED_REPLAY_COLUMNS,
  STORED_REPLAY_INPUT_TOKEN,
  STORED_REPLAY_METADATA_KEYS,
} from "@/api/handlers/case-law/ingestion/pipeline/stored-replay-write";
import {
  REPLAY_ROW_OUTCOME,
  replayCaseLawSource,
} from "@/api/handlers/case-law/ingestion/replay";
import { createSafeId } from "@/api/lib/branded-types";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { readS3ObjectIfPresent } from "@/api/lib/s3";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const WRITE_SAMPLES = 220;
const BODY = "The stored decision has a newly structured reasons paragraph.";
const RAW = "<html><body>The publisher document is immutable.</body></html>";
const RAW_KEY = "case-law/raw/fixture/stored-replay";

const ast = {
  version: 1,
  source: {
    system: ADAPTER_KEYS.EU_ECJ,
    documentId: "fixture",
    webUrl: "",
    printUrl: "",
  },
  metadata: {
    caseNumber: "C-1/26",
    ecli: null,
    court: "Fixture court",
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks: [
    {
      id: "reasons",
      anchorId: "reasons",
      type: "paragraph",
      role: "argumentation",
      inlines: [{ type: "text", text: BODY }],
      plainText: BODY,
    },
  ],
} satisfies DocumentAst;

const resultFor = (caseNumber: string) =>
  plainTextIngestionResult({
    caseNumber,
    court: "Fixture court",
    country: "EU",
    language: "en",
    // A parser returning a richer description must not replace publisher fields.
    decisionType: "parser description",
    metadata: { publisherField: "parser replacement" },
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    rawHash: "new-parser-derived-hash",
    fulltext: BODY,
    documentAst: ast,
    parserVersion: 2,
  });

const adapter = {
  key: ADAPTER_KEYS.EU_ECJ,
  name: "stored replay fixture",
  country: "EU",
  language: "en",
  documentStage: "inline",
  minRequestIntervalMs: 0,
  sourceFields: { status: "declared", fields: {}, listSourceFields: () => [] },
  sourceSurfaces: { surfaces: {} },
  observeDocumentStage: async ({ fetchPage }) => await fetchPage(),
  fetchPage: async () => panic("Stored replay contacted the publisher"),
  getTotalCount: async () => panic("Stored replay contacted the publisher"),
  reconciliation: {
    firstSlice: "1970-01-01",
    sliceOf: () => "1970-01-01",
    nextSlice: () => null,
    previousSlice: () => null,
    tipWindowDays: 1,
    revisionOf: (payload) => payload,
    listSlicePage: async () => panic("Stored replay listed publisher records"),
    buildDecision: async () => panic("Stored replay fetched a decision"),
  },
  reparseStoredRaw: ({ caseNumber }) => ({
    type: "parsed",
    result: resultFor(caseNumber),
  }),
} satisfies SourceAdapter;

const columnMap = getTableColumns(caseLawDecisions);
const allowedSqlColumns = STORED_REPLAY_COLUMNS.map(
  (key) => columnMap[key].name,
);
const officialSnapshot = sql`jsonb_build_object(
  'columns', to_jsonb(${caseLawDecisions}) - ARRAY[${sql.join(
    allowedSqlColumns.map((column) => sql`${column}`),
    sql`, `,
  )}]::text[],
  'metadata', coalesce(${caseLawDecisions.metadata}, '{}'::jsonb) - ARRAY[${sql.join(
    STORED_REPLAY_METADATA_KEYS.map((key) => sql`${key}`),
    sql`, `,
  )}]::text[]
)`;

const percentile = (values: readonly number[], fraction: number) =>
  values
    .toSorted((left, right) => left - right)
    .at(Math.ceil(values.length * fraction) - 1) ??
  panic("Stored replay benchmark did not collect samples");

if (!databaseUrl || !enabled) {
  describe.skip("stored replay persistence contract and measured write cost", () => {
    test("requires explicitly enabled real Postgres", () => {
      expect(enabled && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("stored replay persistence contract and measured write cost", () => {
    // 220 complete pipeline writes include transactions and index intents;
    // the timeout bounds CI execution, while assertions use rows/columns.
    // timeout: 220 sequential complete pipeline writes each own transactions and projection work; the test awaits every write rather than waiting on a timer.
    test("stored replay writes only derived columns and reports per-row write cost", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const writes: string[] = [];
        let captureWrites = false;
        const { db } = openClient({
          logger: {
            logQuery: (query) => {
              if (
                captureWrites &&
                /^update "case_law_decisions"/iu.test(query)
              ) {
                writes.push(query);
              }
            },
          },
        });
        const scopedDb: ScopedDb = async (callback) =>
          await db.transaction(callback);
        const sourceId = createSafeId<"caseLawSource">();
        const fake = startFakeS3();
        try {
          fake.put(envBase.S3_BUCKET, RAW_KEY, RAW, "text/html");
          await db.insert(caseLawSources).values({
            id: sourceId,
            adapterKey: `stored-replay-${sourceId}`,
            name: "Stored replay fixture",
          });
          const ids = Array.from({ length: WRITE_SAMPLES + 2 }, () =>
            createSafeId<"caseLawDecision">(),
          );
          await db.insert(caseLawDecisions).values(
            ids.map((id, index) => ({
              id,
              sourceId,
              caseNumber: `C-${index + 1}/26`,
              court: "Fixture court",
              country: "EU",
              language: "en",
              decisionType: "publisher description",
              metadata: { publisherField: "original" },
              sourceHash: "publisher-source-hash",
              sourceHashVersion: 0,
              sourceRawS3Key: RAW_KEY,
              sourceRawContentType: "text/html",
              parserVersion: 1,
              sourceObservedAt: new Date("2026-01-01T00:00:00Z"),
              sourceObservationOrder: 7n,
              sourceObservationHash: "publisher-observation-hash",
            })),
          );
          const snapshot = async () =>
            await db
              .select({ id: caseLawDecisions.id, official: officialSnapshot })
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.sourceId, sourceId))
              .orderBy(caseLawDecisions.id);
          const before = await snapshot();
          const tokens = new Map(
            (
              await db
                .select({
                  id: caseLawDecisions.id,
                  token: STORED_REPLAY_INPUT_TOKEN,
                })
                .from(caseLawDecisions)
                .where(eq(caseLawDecisions.sourceId, sourceId))
            ).map(({ id, token }) => [id, token] as const),
          );
          const writeMs: number[] = [];
          captureWrites = true;
          for (const [index, decisionId] of ids
            .slice(0, WRITE_SAMPLES)
            .entries()) {
            const started = performance.now();
            // db-await-in-loop: per-row write latency is the explicit benchmark subject
            const result = await processStoredReplayDecision({
              decisionId,
              sourceId,
              sourceRawS3Key: RAW_KEY,
              updateToken:
                tokens.get(decisionId) ?? panic("Missing replay input token"),
              scopedDb,
              input: resultFor(`C-${index + 1}/26`),
            });
            writeMs.push(performance.now() - started);
            expect(result.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
          }
          expect(await snapshot()).toEqual(before);
          expect(writes.length).toBeGreaterThanOrEqual(WRITE_SAMPLES);
          for (const query of writes) {
            const set =
              query.match(
                /^update "case_law_decisions" set (?<assignments>.*?) where /isu,
              )?.groups?.["assignments"] ??
              panic("Cannot inspect stored replay SQL write set");
            const columns = [
              ...set.matchAll(/(?:^|, )"(?<column>[^"]+)" =/gu),
            ].map(
              (match) =>
                match.groups?.["column"] ?? panic("Missing update column"),
            );
            expect(columns.length).toBeGreaterThan(0);
            expect(
              columns.every((column) => allowedSqlColumns.includes(column)),
            ).toBe(true);
          }

          const exactId =
            ids.at(WRITE_SAMPLES) ?? panic("Missing exact replay fixture");
          const untouchedId =
            ids.at(WRITE_SAMPLES + 1) ?? panic("Missing neighbour fixture");
          const readNeighbour = async () =>
            await db
              .select()
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.id, untouchedId));
          const neighbourBefore = await readNeighbour();
          const lease = await acquireCaseLawSourceIngestionLease({
            scopedDb,
            sourceId,
          });
          if (lease === null) {
            panic("Stored replay fixture could not claim source lease");
          }
          try {
            const replay = await replayCaseLawSource({
              adapter,
              scopedDb,
              sourceId,
              sourceLease: lease,
              scope: { type: "decision", decisionId: exactId },
              bound: { type: "at-most", limit: 1 },
              pageSize: 1,
              readStoredRaw: async (key) => {
                const raw = await readS3ObjectIfPresent(
                  key,
                  AbortSignal.timeout(5000),
                );
                return raw === null ? null : new Uint8Array(raw);
              },
            });
            if (replay.type !== "ran") {
              panic("Expected exact decision replay to run");
            }
            expect(replay.report.visited).toBe(1);
            expect(replay.report.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(1);
            expect(await readNeighbour()).toEqual(neighbourBefore);
            expect(await snapshot()).toEqual(before);
            expect(fake.requests.some(({ method }) => method === "PUT")).toBe(
              false,
            );
          } finally {
            await lease.release();
          }
          process.stdout.write(
            `${JSON.stringify({
              event: "stored_replay_write_benchmark",
              samples: writeMs.length,
              p50Ms: percentile(writeMs, 0.5),
              p95Ms: percentile(writeMs, 0.95),
              scope:
                "processStoredReplayDecision including transactions and projection work; excludes raw read and adapter parse",
            })}\n`,
          );
        } finally {
          captureWrites = false;
          fake.stop();
          await db
            .delete(caseLawSources)
            .where(eq(caseLawSources.id, sourceId));
        }
      });
    }, 120_000);
  });
}
