/**
 * What a refresh that brings nothing new writes: nothing it does not have to.
 *
 * A publisher's page moves for reasons of its own (a counter, a banner, a
 * re-render), which changes the source hash and makes the crawl refresh the
 * decision. The row must then take the new observation and nothing else: its
 * payload is not copied back in and trimmed out again, its citations are not
 * deleted and re-inserted, and `updated_at`, which the recent-activity reads
 * and the search refresh order by, does not move. The same holds for a
 * decision the publisher serves without a document.
 *
 * Each case first shows the refresh did apply (the observation advanced), so
 * the stillness that follows is not a skipped write.
 */

import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources, relations } from "@/api/db/schema";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import { PROCESS_DECISION_STATUS } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { DECISION_REFRESH } from "@/api/handlers/case-law/ingestion/pipeline/types";
import { createSafeId } from "@/api/lib/branded-types";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import type { EncodedPack } from "@/api/lib/legal-search/corpus-pack";
import { partialObservationFromMetadata } from "@/api/lib/legal-search/ingestion-normalization";
import { isRecord } from "@/api/lib/type-guards";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;

const sourceId = createSafeId<"caseLawSource">();

/** Every pack the canonical batches of this file handed to the transfer. */
const transferred: EncodedPack[] = [];

const canonical = {
  mode: "canonical",
  transfer: {
    layout: "packs",
    putPacks: async ({ packs }) => {
      transferred.push(...packs);
      return await Promise.resolve(Result.ok(undefined));
    },
  },
} satisfies CaseLawCorpusDependencies;

/** Settles into the corpus like canonical, but keeps the row's payload. */
const dualWrite = {
  mode: "dual-write",
  transfer: canonical.transfer,
} satisfies CaseLawCorpusDependencies;

const postgresOnly = {
  mode: "off",
  transfer: {
    layout: "packs",
    putPacks: () => {
      throw new TypeError("a postgres-only plan must not transfer packs");
    },
  },
} satisfies CaseLawCorpusDependencies;

const PRECEDENT =
  "K výkladu § 1765 občanského zákoníku srov. rozsudek Nejvyššího soudu " +
  "ze dne 3. 2. 2020, sp. zn. 21 Cdo 1234/2020, z něhož soud vycházel.";

const withDocument = (
  caseNumber: string,
  rawHash: string,
  metadata: Record<string, unknown> = {},
): IngestionResult => ({
  caseNumber,
  court: "Nejvyšší soud",
  country: "CZE",
  language: "cs",
  decisionDate: "2024-03-01",
  decisionType: "rozsudek",
  fulltext: PRECEDENT,
  metadata,
  textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
  rawHash,
  documentAst: {},
});

/** A decision the publisher lists and serves inline, with no document. */
const withoutDocument = (
  caseNumber: string,
  rawHash: string,
): IngestionResult => ({
  caseNumber,
  court: "Nejvyšší soud",
  country: "CZE",
  language: "cs",
  decisionDate: "2024-03-01",
  decisionType: "rozsudek",
  metadata: {},
  textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
  rawHash,
  documentAst: {},
});

type StoredRow = {
  id: string;
  updatedAt: string;
  observationOrder: string | null;
  mirrorStatus: string;
  contentHash: string | null;
  textKey: string | null;
  holdsInlineText: boolean;
  metadata: unknown;
};

const storedRow = async (caseNumber: string): Promise<StoredRow> => {
  const result = await db.execute(sql`
    SELECT id::text AS id,
           updated_at::text AS updated_at,
           source_observation_order::text AS observation_order,
           corpus_mirror_status,
           content_hash,
           text_s3_key,
           fulltext IS NOT NULL AS holds_inline_text,
           metadata
      FROM case_law_decisions
     WHERE source_id = ${sourceId}::uuid
       AND case_number = ${caseNumber}
  `);
  const record = result.rows.at(0);
  if (!isRecord(record)) {
    throw new TypeError(`expected a stored decision ${caseNumber}`);
  }
  return {
    id: String(record["id"]),
    updatedAt: String(record["updated_at"]),
    observationOrder:
      typeof record["observation_order"] === "string"
        ? record["observation_order"]
        : null,
    mirrorStatus: String(record["corpus_mirror_status"]),
    contentHash:
      typeof record["content_hash"] === "string"
        ? record["content_hash"]
        : null,
    textKey:
      typeof record["text_s3_key"] === "string" ? record["text_s3_key"] : null,
    holdsInlineText: record["holds_inline_text"] === true,
    metadata: record["metadata"],
  };
};

/** Every citation tuple's header for one citing decision. */
const citationHeaders = async (decisionId: string): Promise<unknown> =>
  (
    await db.execute(sql`
      SELECT id::text AS id, xmin::text AS xmin, xmax::text AS xmax,
             resolution_status
        FROM case_law_citations
       WHERE citing_decision_id = ${decisionId}::uuid
       ORDER BY id
    `)
  ).rows;

/**
 * Wrap a query builder so that awaiting it first runs `before`. Every call
 * on the chain returns a wrapped builder, so the hook fires when the whole
 * statement is sent, not when it starts being built.
 */
const runningFirst = <T extends object>(
  target: T,
  before: () => Promise<void>,
): T =>
  new Proxy(target, {
    get(object, key) {
      const value: unknown = Reflect.get(object, key);
      if (typeof value !== "function") {
        return value;
      }
      if (key === "then") {
        return async (
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ): Promise<unknown> => {
          await before();
          return await Reflect.apply(value, object, [onFulfilled, onRejected]);
        };
      }
      return (...args: unknown[]) => {
        const out: unknown = Reflect.apply(value, object, args);
        return typeof out === "object" && out !== null
          ? runningFirst(out, before)
          : out;
      };
    },
  });

/**
 * A scoped db on which `race` runs once, in the writer's own transaction,
 * just before its first update of a decision row: what another worker
 * committing between the writer's read and its row lock would leave.
 */
const racingScopedDb = (
  race: (
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  ) => Promise<void>,
): ScopedDb => {
  let pending = true;
  return async (callback) =>
    await db.transaction(async (tx) => {
      const racing = new Proxy(tx, {
        get(object, key) {
          const value: unknown = Reflect.get(object, key);
          if (key === "update" && typeof value === "function") {
            return (table: unknown) => {
              const builder: unknown = Reflect.apply(value, object, [table]);
              if (
                table !== caseLawDecisions ||
                !pending ||
                typeof builder !== "object" ||
                builder === null
              ) {
                return builder;
              }
              return runningFirst(builder, async () => {
                if (pending) {
                  pending = false;
                  await race(tx);
                }
              });
            };
          }
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
      return await callback(asTestRaw(racing));
    });
};

let order = 0n;
const ingest = async (
  input: IngestionResult,
  corpus: CaseLawCorpusDependencies,
  writer: ScopedDb = scopedDb,
) => {
  order += 1n;
  const outcome = await processDecision({
    input,
    observationOrder: order,
    sourceId,
    scopedDb: writer,
    observedAt: new Date(Date.UTC(2026, 8, 23, 12, 0, Number(order))),
    refresh: DECISION_REFRESH.WHEN_SOURCE_CHANGED,
    corpus,
  });
  expect(outcome.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
  return order;
};

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client, relations: { ...relations, ...authRelationsPart } });
  scopedDb = async (callback) =>
    await db.transaction(async (tx) => await callback(asTestRaw(tx)));
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: "refresh-writes-test",
    name: "Refresh writes test",
  });
});

afterAll(async () => {
  await client.close();
});

test("a moved page over the same document rewrites neither payload, citations nor updated_at", async () => {
  const caseNumber = "30 Cdo 100/2024";
  await ingest(withDocument(caseNumber, "page-v1"), canonical);
  const first = await storedRow(caseNumber);
  // The fixture reaches the boundary: settled into the corpus, trimmed out of
  // the row, and carrying a citation the refresh could rewrite.
  expect(first.mirrorStatus).toBe("settled");
  expect(first.contentHash).not.toBeNull();
  expect(first.holdsInlineText).toBe(false);
  const citations = await citationHeaders(first.id);
  expect(citations).toHaveLength(1);
  const packsBefore = transferred.length;

  const refreshed = await ingest(
    withDocument(caseNumber, "page-v2"),
    canonical,
  );
  const second = await storedRow(caseNumber);
  // The refresh applied: the row now carries this observation.
  expect(second.observationOrder).toBe(String(refreshed));

  expect(second.updatedAt).toBe(first.updatedAt);
  expect(second.contentHash).toBe(first.contentHash);
  expect(second.textKey).toBe(first.textKey);
  expect(second.holdsInlineText).toBe(false);
  expect(transferred.length).toBe(packsBefore);
  expect(await citationHeaders(first.id)).toEqual(citations);
});

test("a refresh that changes what the decision says moves updated_at", async () => {
  // The other half of the rule above: without it, a row that never moves
  // would pass the first test too.
  const caseNumber = "30 Cdo 101/2024";
  await ingest(withDocument(caseNumber, "page-v1"), canonical);
  const first = await storedRow(caseNumber);
  await ingest(
    withDocument(caseNumber, "page-v2", { chamber: "grand" }),
    canonical,
  );
  const second = await storedRow(caseNumber);
  expect(second.updatedAt).not.toBe(first.updatedAt);
  expect(second.metadata).toMatchObject({ chamber: "grand" });
});

test("a refresh that rewrites the decision's identifier rows moves updated_at", async () => {
  // The identifier rows are replaced with the row and read into its search
  // document, which is refreshed by `updated_at`. Rows an earlier write left
  // differently from what this refresh derives are a change of their own,
  // even when nothing else the decision says moved.
  const caseNumber = "30 Cdo 102/2024";
  const reporter = {
    type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
    value: "R 12/2021 civ",
  } as const;
  await ingest(
    { ...withDocument(caseNumber, "page-v1"), identifiers: [reporter] },
    canonical,
  );
  const first = await storedRow(caseNumber);
  await db.execute(sql`
    UPDATE case_law_decision_identifiers
       SET value = 'R 12/2021 CIV'
     WHERE decision_id = ${first.id}::uuid
       AND type = ${reporter.type}
  `);

  await ingest(
    { ...withDocument(caseNumber, "page-v2"), identifiers: [reporter] },
    canonical,
  );
  const rewritten = await storedRow(caseNumber);
  expect(rewritten.updatedAt).not.toBe(first.updatedAt);
  const values = await db.execute(sql`
    SELECT value FROM case_law_decision_identifiers
     WHERE decision_id = ${first.id}::uuid AND type = ${reporter.type}
  `);
  expect(values.rows).toEqual([{ value: reporter.value }]);

  // The rows now match, so the next refresh of the same page leaves it.
  await ingest(
    { ...withDocument(caseNumber, "page-v3"), identifiers: [reporter] },
    canonical,
  );
  expect((await storedRow(caseNumber)).updatedAt).toBe(rewritten.updatedAt);
});

test.each([
  ["canonical", canonical],
  ["postgres-only", postgresOnly],
] as const)(
  "a document-less decision refreshed without one is not rewritten (%s)",
  async (_mode, corpus) => {
    const caseNumber = `30 Cdo 200/2024 ${_mode}`;
    await ingest(withoutDocument(caseNumber, "page-v1"), corpus);
    const first = await storedRow(caseNumber);
    // Stored unpublished: an inline source that served no document.
    expect(partialObservationFromMetadata(first.metadata).isListingOnly).toBe(
      true,
    );
    expect(first.mirrorStatus).toBe("settled");
    const packsBefore = transferred.length;

    const refreshed = await ingest(
      withoutDocument(caseNumber, "page-v2"),
      corpus,
    );
    const second = await storedRow(caseNumber);
    expect(second.observationOrder).toBe(String(refreshed));

    expect(second.updatedAt).toBe(first.updatedAt);
    expect(second.mirrorStatus).toBe("settled");
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.metadata).toEqual(first.metadata);
    expect(transferred.length).toBe(packsBefore);
  },
);

test("a document arriving for a document-less decision is still written", async () => {
  const caseNumber = "30 Cdo 300/2024";
  await ingest(withoutDocument(caseNumber, "page-v1"), canonical);
  const first = await storedRow(caseNumber);
  await ingest(withDocument(caseNumber, "page-v2"), canonical);
  const second = await storedRow(caseNumber);
  expect(second.contentHash).not.toBe(first.contentHash);
  expect(second.updatedAt).not.toBe(first.updatedAt);
  expect(partialObservationFromMetadata(second.metadata).isListingOnly).toBe(
    false,
  );
  const decisionRow = (
    await db
      .select({ id: caseLawDecisions.id })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.sourceId, sourceId),
          eq(caseLawDecisions.caseNumber, caseNumber),
        ),
      )
  ).at(0);
  expect(await citationHeaders(decisionRow?.id ?? "")).toHaveLength(1);
});

test("a refresh that moves the decision's language re-settles its kept citations", async () => {
  // Kept rows keep their answer unless something reopens them, and the citing
  // language is one of the things the answer depends on: it picks which
  // manifestation of a multilingual target an edge lands on.
  const caseNumber = "30 Cdo 400/2024";
  // Identified by the publisher's id, so the language is a field of the
  // decision rather than part of which decision it is.
  const sourceDocumentId = "publisher-400";
  await ingest(
    { ...withDocument(caseNumber, "page-v1"), sourceDocumentId },
    canonical,
  );
  const first = await storedRow(caseNumber);
  const citations = await citationHeaders(first.id);
  expect(citations).toHaveLength(1);

  await ingest(
    {
      ...withDocument(caseNumber, "page-v2"),
      sourceDocumentId,
      language: "sk",
    },
    canonical,
  );
  // Still the same decision, now in the other language.
  expect((await storedRow(caseNumber)).id).toBe(first.id);
  expect(await citationHeaders(first.id)).not.toEqual(citations);
});

test("an unchanged refresh converges a retained payload to the trimmed shape", async () => {
  // Settled while the mode kept the payload in the row too; the mode has
  // since moved to canonical, where a settled row holds it only in the corpus.
  const caseNumber = "30 Cdo 500/2024";
  await ingest(withDocument(caseNumber, "page-v1"), dualWrite);
  const first = await storedRow(caseNumber);
  expect(first.mirrorStatus).toBe("settled");
  expect(first.holdsInlineText).toBe(true);
  const packsBefore = transferred.length;

  const refreshed = await ingest(
    withDocument(caseNumber, "page-v2"),
    canonical,
  );
  const second = await storedRow(caseNumber);
  expect(second.observationOrder).toBe(String(refreshed));
  expect(second.holdsInlineText).toBe(false);
  // Nothing about the decision changed, and the corpus already held it.
  expect(second.contentHash).toBe(first.contentHash);
  expect(second.textKey).toBe(first.textKey);
  expect(second.updatedAt).toBe(first.updatedAt);
  expect(transferred.length).toBe(packsBefore);
});

test("a payload replaced between the read and the write is planned again", async () => {
  // Another worker, holding an older observation of a different document,
  // settles it after this refresh read the row. The refresh must not keep
  // that document under its own newer observation.
  const caseNumber = "30 Cdo 600/2024";
  await ingest(withDocument(caseNumber, "page-v1"), canonical);
  const first = await storedRow(caseNumber);
  const packsBefore = transferred.length;

  const refreshed = await ingest(
    withDocument(caseNumber, "page-v2"),
    canonical,
    racingScopedDb(async (tx) => {
      await tx.execute(sql`
        UPDATE case_law_decisions
           SET content_hash = ${"f".repeat(64)},
               text_s3_key = text_s3_key || '.other'
         WHERE id = ${first.id}::uuid
      `);
    }),
  );
  const second = await storedRow(caseNumber);
  expect(second.observationOrder).toBe(String(refreshed));
  expect(second.contentHash).toBe(first.contentHash);
  expect(second.textKey).toBe(first.textKey);
  expect(second.mirrorStatus).toBe("settled");
  // Planned against what the row then held, so the document went back in.
  expect(transferred.length).toBeGreaterThan(packsBefore);
});

test("a directory jurisdiction's decision is written with its court id, and every other without one", async () => {
  const usa = (rawHash: string): IngestionResult => ({
    ...withDocument("No. 19-1392", rawHash),
    court: "Supreme Court of the United States",
    courtId: "scotus",
    country: "USA",
    language: "en",
  });
  const courtIdOf = async (caseNumber: string) =>
    (
      await db
        .select({ courtId: caseLawDecisions.courtId })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.caseNumber, caseNumber))
    ).map(({ courtId }) => courtId);

  await ingest(usa("page-v1"), canonical);
  await ingest(withDocument("30 Cdo 900/2024", "page-v1"), canonical);
  expect(await courtIdOf("No. 19-1392")).toEqual(["scotus"]);
  expect(await courtIdOf("30 Cdo 900/2024")).toEqual([null]);

  // A refresh that states the same court id is not a change of the row.
  const first = await storedRow("No. 19-1392");
  await ingest(usa("page-v2"), canonical);
  expect((await storedRow("No. 19-1392")).updatedAt).toBe(first.updatedAt);

  // A result that reaches the write path without its court id is an adapter
  // defect; nothing is written for it.
  const { courtId: _courtId, ...unresolved } = usa("page-v3");
  const rejection: unknown = await processDecision({
    input: { ...unresolved, caseNumber: "No. 20-1" },
    observationOrder: 1000n,
    sourceId,
    scopedDb,
    observedAt: new Date(Date.UTC(2026, 8, 23, 13)),
    refresh: DECISION_REFRESH.WHEN_SOURCE_CHANGED,
    corpus: canonical,
  }).then(
    () => null,
    (error: unknown) => error,
  );
  expect(rejection).toMatchObject({
    message: expect.stringContaining(
      "Decision court identity rejected for USA: missing",
    ),
  });
  expect(await courtIdOf("No. 20-1")).toEqual([]);
});
