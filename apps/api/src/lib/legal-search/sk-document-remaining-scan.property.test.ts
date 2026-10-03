import { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import { EMPTY_CORPUS_CONTENT_HASHES } from "@/api/lib/legal-search/corpus-content-hash";
import {
  loadRemainingDocuments,
  MAX_DOCUMENT_FETCH_ATTEMPTS,
  MAX_PRIORITY_FETCH_ATTEMPTS,
  remainingDocumentCandidateQuery,
} from "@/api/lib/legal-search/sk-document-backfill";
import { createPendingDocumentQueue } from "@/api/lib/legal-search/sk-document-queue";
import {
  DOCUMENT_SCAN_PAGE_LIMIT,
  createRemainingDocumentScan,
} from "@/api/lib/legal-search/sk-document-remaining-scan";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const SOURCE_ID = asTestRaw<SafeId<"caseLawSource">>(
  "remaining-property-source",
);
const STATES = [
  "ready",
  "cooled",
  "cooling",
  "parked",
  "requested",
  "retriedRequest",
  "completed",
  "noUrl",
  "redacted",
  "corpusServed",
  "ast",
  "emptyHash",
] as const;
const rowArbitrary = fc.record({
  state: fc.constantFrom(...STATES),
  decisionDate: fc.constantFrom(null, "2026-05-03", "2026-05-02", "2026-05-01"),
  otherSource: fc.boolean(),
});

// Every run contains both exclusions and duplicate/NULL date boundaries;
// random rows then vary their interleaving, source scope and page cuts.
const fixtureArbitrary = fc.record({
  extra: fc.array(rowArbitrary, { maxLength: 24 }),
  pageSize: fc.integer({ min: 2, max: 7 }),
  completedClaim: fc.boolean(),
});

const TABLE_SQL = `CREATE TABLE case_law_decisions (
  id text PRIMARY KEY, source_id text NOT NULL, case_number text NOT NULL,
  ecli text, court text NOT NULL, country text NOT NULL, decision_date date,
  decision_type text, document_url text, fulltext text, redacted_at timestamptz,
  content_hash varchar(64), document_ast jsonb,
  document_fetch_attempts integer NOT NULL, document_fetch_attempted_at timestamptz,
  document_fetch_requested_at timestamptz
)`;

const INSERT_SQL = `INSERT INTO case_law_decisions
  (id, source_id, case_number, court, country, decision_date, document_url,
   fulltext, redacted_at, content_hash, document_ast, document_fetch_attempts,
   document_fetch_attempted_at, document_fetch_requested_at)
SELECT
  id, CASE WHEN "otherSource" THEN 'other-source' ELSE $2 END,
  id, 'Okresný súd', 'SVK', "decisionDate"::date,
  CASE WHEN state = 'noUrl' THEN NULL ELSE 'https://example.test/decision.pdf' END,
  CASE WHEN state = 'completed' THEN 'completed text' ELSE NULL END,
  CASE WHEN state = 'redacted' THEN now() ELSE NULL END,
  CASE WHEN state IN ('corpusServed', 'ast') THEN repeat('a', 64)
       WHEN state = 'emptyHash' THEN $3 ELSE NULL END,
  CASE WHEN state = 'ast' THEN '{}'::jsonb ELSE NULL END,
  CASE WHEN state = 'parked' THEN $4::integer
       WHEN state = 'retriedRequest' THEN $5::integer
       WHEN state IN ('cooled', 'cooling') THEN 1 ELSE 0 END,
  CASE WHEN state = 'cooling' THEN now()
       WHEN state IN ('cooled', 'retriedRequest') THEN now() - interval '30 days'
       ELSE NULL END,
  CASE WHEN state IN ('requested', 'retriedRequest') THEN now() ELSE NULL END
FROM jsonb_to_recordset($1::text::jsonb)
  AS rows(id text, state text, "decisionDate" text, "otherSource" boolean)`;

test("sk-document.remaining-scan.database-equivalence-and-crash-replay", async () => {
  await using client = await PGlite.create();
  await client.exec(TABLE_SQL);
  const db = drizzle({ client });
  // These production builders use only select/from/where/orderBy/limit;
  // PGlite implements that Drizzle surface without the service-backed pool.
  const tx = asTestRaw<Transaction>(db);
  const scopedDb: ScopedDb = async (callback) => await callback(tx);

  await assertProperty(
    "sk-document.remaining-scan.database-equivalence-and-crash-replay",
    fc.asyncProperty(
      fixtureArbitrary,
      async ({ extra, pageSize, completedClaim }) => {
        const seeds = [
          ...STATES.map((state, index) => ({
            state,
            decisionDate: index % 3 === 0 ? null : "2026-05-03",
            otherSource: false,
          })),
          ...extra,
        ];
        const rows = seeds.map(
          ({ state, decisionDate, otherSource }, index) => ({
            state,
            decisionDate,
            otherSource,
            id: `decision-${String(index).padStart(3, "0")}`,
          }),
        );
        await client.exec("TRUNCATE case_law_decisions");
        await client.query(INSERT_SQL, [
          JSON.stringify(rows),
          SOURCE_ID,
          EMPTY_CORPUS_CONTENT_HASHES.at(0),
          MAX_DOCUMENT_FETCH_ATTEMPTS,
          MAX_PRIORITY_FETCH_ATTEMPTS,
        ]);
        const expected = await loadRemainingDocuments({
          scopedDb,
          sourceId: SOURCE_ID,
          limit: rows.length + 1,
        });
        expect(expected.length).toBeGreaterThan(0);

        let pageCalls = 0;
        let examined = 0;
        const newScan = () =>
          createRemainingDocumentScan({
            now: () => 0,
            loadPage: async (options) => {
              const page = await remainingDocumentCandidateQuery({
                tx,
                sourceId: SOURCE_ID,
                ...options,
              });
              pageCalls += 1;
              examined += page.length;
              expect(page.length).toBeLessThanOrEqual(DOCUMENT_SCAN_PAGE_LIMIT);
              return page;
            },
          });
        const drain = async (
          scan: ReturnType<typeof createRemainingDocumentScan>,
        ) => {
          const selected = [];
          const queue = createPendingDocumentQueue({
            loaders: { loadRequested: async () => [], loadRemaining: scan },
            now: () => 0,
            pageSize,
            requestedPollIntervalMs: 0,
          });
          for (let step = 0; step <= rows.length; step += 1) {
            const result = await queue.next();
            switch (result.type) {
              case "row":
                selected.push(result.row.decision);
                break;
              case "exhausted":
                return selected;
              case "budget-spent":
                break;
              default: {
                result satisfies never;
                panic("Unexpected document queue outcome");
              }
            }
          }
          return selected;
        };
        const scan = newScan();
        expect(await drain(scan)).toEqual(expected);
        expect(examined).toBeLessThanOrEqual(
          rows.length * (Math.ceil(rows.length / pageSize) + 1),
        );
        expect(pageCalls).toBeLessThanOrEqual(
          Math.ceil(rows.length / pageSize) + 1,
        );
        const exhaustedCalls = pageCalls;
        expect(await scan(pageSize)).toEqual({ type: "exhausted" });
        expect(pageCalls).toBe(exhaustedCalls);

        // A crash discards unprocessed rows buffered beside the cursor.
        // Persist only one claim; restarting must recover the rest of its page.
        const beforeCrash = newScan();
        const firstPage = await beforeCrash(pageSize);
        const claimed =
          firstPage.type === "rows" ? firstPage.rows.at(0) : undefined;
        expect(claimed).toBeDefined();
        if (!claimed) {
          throw new TypeError("Expected a ready decision before crash");
        }
        expect(claimed).toEqual(expected.at(0));
        await client.query(
          completedClaim
            ? "UPDATE case_law_decisions SET fulltext = 'completed' WHERE id = $1"
            : "UPDATE case_law_decisions SET document_fetch_attempts = document_fetch_attempts + 1, document_fetch_attempted_at = now() WHERE id = $1",
          [claimed.id],
        );
        const replay = await drain(newScan());
        expect([claimed, ...replay]).toEqual(expected);
        expect(new Set([claimed, ...replay].map(({ id }) => id)).size).toBe(
          expected.length,
        );
      },
    ),
    { numRuns: 30 },
  );
}, 60_000);
