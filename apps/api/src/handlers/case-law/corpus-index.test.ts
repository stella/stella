import { describe, expect, test } from "bun:test";

import {
  generationProjectionTargetIds,
  hasGenerationProjectionTargets,
  loadDocsForBatch,
} from "@/api/handlers/case-law/corpus-index";
import { toSafeId } from "@/api/lib/branded-types";
import { corpusDocumentDeleteQuery } from "@/api/lib/corpus-index/core";
import type { TimestampCasToken } from "@/api/lib/db/timestamp-cas";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import {
  caseLawIndexConfig,
  DECISION_TIMESTAMP_FIELD,
  UNDATED_DECISION_TIMESTAMP,
} from "@/api/lib/legal-search/corpus-index-config";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";

type MakeRowOptions = {
  id: string;
  contentHash: string;
  textS3Key?: string | null;
  astS3Key?: string | null;
  decisionDate?: string | null;
  decisionType?: string | null;
  ecli?: string | null;
};

const makeRow = ({
  id,
  contentHash,
  textS3Key,
  astS3Key = null,
  decisionDate = "2024-01-01",
  decisionType = null,
  ecli = null,
}: MakeRowOptions) => ({
  id: toSafeId<"caseLawDecision">(id),
  sourceId: toSafeId<"caseLawSource">("src_1"),
  caseNumber: `case-${id}`,
  ecli,
  identifiers: [`case-${id}`, ...(ecli === null ? [] : [ecli])],
  court: "Test Court",
  country: "CZ",
  language: "cs",
  decisionDate,
  decisionType,
  citationAuthority: 0,
  citationCount: 0,
  textS3Key:
    textS3Key === undefined ? `legal-corpus/${id}/text.zst` : textS3Key,
  astS3Key,
  contentHash,
  indexedHash: null,
  indexedGeneration: null,
  generationIndexId: null,
  generationPendingAction: null,
  generationPendingIndexIds: [],
  generationPendingRevision: 0,
  // SAFETY: tests fabricate the branded token the adapters normally
  // select as `updated_at::text`.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  updatedAtToken: "2024-01-01 00:00:00" as TimestampCasToken,
});

test("generation delete targets are the complete union of durable pointers", () => {
  const generation = "case_law_v2";
  const pendingIndexId = corpusIndexId(generation, "CZE");
  const projectionIndexId = corpusIndexId(generation, "SVK");
  const legacyIndexId = corpusIndexId(generation, "POL");

  for (const pendingIndexIds of [[], [pendingIndexId]]) {
    for (const generationIndexId of [null, projectionIndexId]) {
      for (const indexedGeneration of [null, legacyIndexId]) {
        const targets = generationProjectionTargetIds({
          generation,
          row: {
            generationIndexId,
            generationPendingIndexIds: pendingIndexIds,
            indexedGeneration,
          },
        });
        const expected = [
          ...pendingIndexIds,
          ...(generationIndexId === null ? [] : [generationIndexId]),
          ...(indexedGeneration === null ? [] : [indexedGeneration]),
        ];

        expect([...targets].sort()).toEqual(expected.sort());
        expect(
          hasGenerationProjectionTargets({
            generation,
            row: {
              generationIndexId,
              generationPendingIndexIds: pendingIndexIds,
              indexedGeneration,
            },
          }),
        ).toBe(expected.length > 0);
      }
    }
  }

  expect([
    ...generationProjectionTargetIds({
      generation,
      row: {
        generationIndexId: null,
        generationPendingIndexIds: [],
        indexedGeneration: corpusIndexId("case_law_v1", "CZE"),
      },
    }),
  ]).toEqual([]);
  expect(
    hasGenerationProjectionTargets({
      generation,
      row: {
        generationIndexId: null,
        generationPendingIndexIds: [],
        indexedGeneration: corpusIndexId("case_law_v1", "CZE"),
      },
    }),
  ).toBe(false);

  expect([
    ...generationProjectionTargetIds({
      generation,
      row: {
        generationIndexId: pendingIndexId,
        generationPendingIndexIds: [pendingIndexId],
        indexedGeneration: pendingIndexId,
      },
    }),
  ]).toEqual([pendingIndexId]);
});

describe("loadDocsForBatch read-failure isolation", () => {
  test("a single document's read failure is recorded while the batch continues", async () => {
    const generation = "case_law_v1";
    const okRow = makeRow({ id: "dec_ok", contentHash: "hash_ok" });
    const badRow = makeRow({ id: "dec_bad", contentHash: "hash_bad" });

    const { built, readFailures } = await loadDocsForBatch([okRow, badRow], {
      generation,
      fetchFulltext: async () => null,
      readPayload: async (row) => {
        if (row.id === badRow.id) {
          throw new TimeoutError({
            message: "corpus-read-text exceeded 60000ms",
            label: "corpus-read-text",
          });
        }
        return { text: `text for ${row.id}`, ast: null };
      },
    });

    // The healthy document still builds and stays in the batch.
    expect(built).toHaveLength(1);
    const entry = built.at(0);
    expect(entry?.row.id).toBe(okRow.id);
    expect(entry?.docs.at(0)?.["text"]).toBe(`text for ${okRow.id}`);

    // The failed read is isolated as a failed index job for its jurisdiction.
    expect(readFailures).toHaveLength(1);
    const failure = readFailures.at(0);
    expect(failure?.indexId).toBe(corpusIndexId(generation, "CZ"));
    expect(failure?.job).toMatchObject({
      entityId: badRow.id,
      contentHash: "hash_bad",
      operation: "index",
      status: "failed",
    });
    expect(failure?.job.errorMessage).toContain("corpus-read-text");
    expect(failure?.cause).toBeInstanceOf(TimeoutError);
  });

  test("a row without a corpus object gets its fulltext via the lazy fallback", async () => {
    const generation = "case_law_v1";
    const legacyRow = makeRow({
      id: "dec_legacy",
      contentHash: "hash_legacy",
      textS3Key: null,
    });
    const fetchedIds: string[] = [];

    const { built, readFailures } = await loadDocsForBatch([legacyRow], {
      generation,
      fetchFulltext: async (id) => {
        fetchedIds.push(id);
        return "stored fulltext";
      },
    });

    expect(readFailures).toHaveLength(0);
    expect(built).toHaveLength(1);
    expect(built.at(0)?.docs.at(0)?.["text"]).toBe("stored fulltext");
    // The lazy fallback runs only for the S3-less row, keyed by its id.
    expect(fetchedIds).toEqual([legacyRow.id]);
  });
});

const paragraph = (index: number, words: number) => ({
  id: `b${index}`,
  anchorId: `anchor-${index}`,
  type: "paragraph" as const,
  inlines: [],
  plainText: `${index} ${"slovo ".repeat(words).trim()}`,
});

const heading = (index: number, text: string) => ({
  id: `h${index}`,
  anchorId: `anchor-${index}`,
  type: "heading" as const,
  level: 1 as const,
  inlines: [],
  plainText: text,
});

const astOf = (
  blocks: (ReturnType<typeof paragraph> | ReturnType<typeof heading>)[],
) => ({
  version: 1 as const,
  source: { system: "test", documentId: "d", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks,
});

describe("case-law passage projection", () => {
  test("one row emits every passage as its own document, under one row entry", async () => {
    const row = makeRow({ id: "dec_passages", contentHash: "hash_1" });
    const ast = astOf([
      heading(0, "Odůvodnění"),
      paragraph(1, 200),
      paragraph(2, 200),
      paragraph(3, 200),
    ]);

    const { built } = await loadDocsForBatch([row], {
      generation: "case_law_v2",
      fetchFulltext: async () => null,
      readPayload: async () => ({ text: "ignored fallback", ast }),
    });

    // The row stays one unit — that is what keeps its indexedHash/generation
    // mark and its audit row singular no matter how it split.
    expect(built).toHaveLength(1);
    const docs = built.at(0)?.docs ?? [];
    expect(docs.length).toBeGreaterThan(1);

    // Passage identity is deterministic and dense, and every passage carries
    // the doc-level fields the filters need.
    expect(docs.map((doc) => doc["seq"])).toEqual(
      docs.map((_, index) => index),
    );
    expect(docs.map((doc) => doc["chunk_id"])).toEqual(
      docs.map((_, index) => `${row.id}:${index}`),
    );
    for (const doc of docs) {
      expect(doc["document_id"]).toBe(row.id);
      expect(doc["court"]).toBe("Test Court");
      expect(doc["decision_date"]).toBe("2024-01-01");
      expect(doc["jurisdiction"]).toBe("CZ");
      expect(typeof doc["anchor_id"]).toBe("string");
    }

    // The section heading opens the first passage and is context for the rest.
    expect(docs.at(0)?.["text"]).toContain("Odůvodnění");
    expect(docs.at(-1)?.["heading_path"]).toBe("Odůvodnění");
    // No passage repeats the heading body text.
    expect(
      docs.filter((doc) => String(doc["text"]).includes("Odůvodnění")),
    ).toHaveLength(1);
  });

  test("every passage carries the timestamp field, dated decision or not", async () => {
    const dated = makeRow({ id: "dec_dated", contentHash: "hash_dated" });
    const undated = makeRow({
      id: "dec_undated",
      contentHash: "hash_undated",
      decisionDate: null,
    });

    const { built } = await loadDocsForBatch([dated, undated], {
      generation: "case_law_v2",
      fetchFulltext: async () => null,
      readPayload: async () => ({
        text: `${"slovo ".repeat(400)}\n\n${"jinak ".repeat(400)}`,
        ast: {},
      }),
    });

    const docsOf = (id: string) =>
      built.find((entry) => entry.row.id === id)?.docs ?? [];
    expect(docsOf(dated.id).length).toBeGreaterThan(1);
    expect(docsOf(undated.id).length).toBeGreaterThan(1);

    // The engine rejects a document missing the timestamp field, and a
    // decision is split across passages, so "every document" means every
    // passage of every row — not one per decision.
    for (const doc of docsOf(dated.id)) {
      expect(doc[DECISION_TIMESTAMP_FIELD]).toBe("2024-01-01");
      expect(doc["decision_date"]).toBe("2024-01-01");
    }
    for (const doc of docsOf(undated.id)) {
      expect(doc[DECISION_TIMESTAMP_FIELD]).toBe(UNDATED_DECISION_TIMESTAMP);
      // The sentinel stands in for the timestamp field alone. What the court
      // published is still nothing, so the fields the reader and the year
      // facet show stay absent rather than claiming a date of 1800.
      expect(doc["decision_date"]).toBeUndefined();
      expect(doc["year"]).toBeUndefined();
    }
  });

  test("every field the projection writes is one the doc mapping declares", async () => {
    // A generation created from the current config maps in `strict` mode: a
    // document carrying a field the mapping does not declare is rejected at
    // ingest. This is the guard for that — the writer and the mapping are two
    // halves of one shape, and the half that fails is the one nothing checks.
    const rows = [
      makeRow({
        id: "dec_full",
        contentHash: "hash_full",
        astS3Key: "legal-corpus/dec_full/ast.zst",
        decisionType: "rozsudek",
        ecli: "ECLI:CZ:NS:2024:1.T.1.2024.1",
      }),
      makeRow({
        id: "dec_sparse",
        contentHash: "hash_sparse",
        decisionDate: null,
        textS3Key: null,
      }),
    ];

    const { built } = await loadDocsForBatch(rows, {
      generation: "case_law_v3",
      fetchFulltext: async () => "slovo ".repeat(400),
      readPayload: async (row) => ({
        text: `${"slovo ".repeat(400)}\n\n${"jinak ".repeat(400)}`,
        // The anchored layout on one row and the unanchored fallback on the
        // other, so both passage shapes are in the assertion's input.
        ast:
          row.id === rows.at(0)?.id
            ? astOf([heading(0, "Odůvodnění"), paragraph(1, 200)])
            : {},
      }),
    });

    const docs = built.flatMap((entry) => entry.docs);
    const emitted = new Set(docs.flatMap((doc) => Object.keys(doc)));
    const mapped = new Set(
      caseLawIndexConfig("case_law_v3_cze").doc_mapping.field_mappings.map(
        (field) => field.name,
      ),
    );
    expect([...emitted].filter((name) => !mapped.has(name)).sort()).toEqual([]);

    // The fixtures have to reach the conditional fields, or the assertion is
    // over a shape narrower than the writer's: the rich row carries every
    // optional field, the sparse one carries none of them, and both layouts of
    // a passage (opening, continuation) appear.
    for (const field of [
      "anchor_id",
      "case_number",
      "decision_date",
      "document_type",
      "ecli",
      "title",
      "year",
      DECISION_TIMESTAMP_FIELD,
    ]) {
      expect(emitted.has(field)).toBe(true);
    }
    expect(
      [...emitted].filter((name) => name.startsWith("canonical_")),
    ).toEqual([]);
    expect(
      docs.filter((doc) => doc["title"] === undefined).length,
    ).toBeGreaterThan(0);
  });

  test("a row with no usable AST still emits passages, unanchored", async () => {
    const row = makeRow({ id: "dec_no_ast", contentHash: "hash_2" });

    const { built } = await loadDocsForBatch([row], {
      generation: "case_law_v2",
      fetchFulltext: async () => null,
      readPayload: async () => ({
        text: `${"slovo ".repeat(400)}\n\n${"jinak ".repeat(400)}`,
        ast: {},
      }),
    });

    const docs = built.at(0)?.docs ?? [];
    expect(docs.length).toBeGreaterThan(1);
    for (const doc of docs) {
      expect(doc["document_id"]).toBe(row.id);
      expect(doc["anchor_id"]).toBeUndefined();
    }
  });

  test("the searchable title is indexed once per decision, not per passage", async () => {
    const row = makeRow({ id: "dec_title", contentHash: "hash_title" });
    const { built } = await loadDocsForBatch([row], {
      generation: "case_law_v2",
      fetchFulltext: async () => null,
      readPayload: async () => ({
        text: "",
        ast: astOf([
          heading(0, "Odůvodnění"),
          paragraph(1, 200),
          paragraph(2, 200),
          paragraph(3, 200),
        ]),
      }),
    });

    const docs = built.at(0)?.docs ?? [];
    expect(docs.length).toBeGreaterThan(1);

    // `title` is the only document-level field a free-text term can reach.
    // Copied onto every passage, a court-name query would let one judgment
    // return as many equally-scoring hits as it has passages and crowd every
    // other decision out of the capped scan window.
    const titled = docs.filter((doc) => doc["title"] !== undefined);
    expect(titled).toHaveLength(1);
    expect(titled.at(0)?.["seq"]).toBe(0);
    expect(titled.at(0)?.["title"]).toBe(`case-${row.id} — Test Court`);

    // The filter and facet fields stay on every passage: they are
    // raw-tokenized or numeric, so they carry no free-text fan-out, and the
    // engine filters on the document it scores.
    for (const doc of docs) {
      expect(doc["court"]).toBe("Test Court");
      expect(doc["language"]).toBe("cs");
      expect(doc["citation_authority"]).toBe(0);
    }
  });

  test("the delete-previous-copies query selects every passage a row emitted", async () => {
    const row = makeRow({ id: "dec_replace", contentHash: "hash_4" });
    const { built } = await loadDocsForBatch([row], {
      generation: "case_law_v2",
      fetchFulltext: async () => null,
      readPayload: async () => ({
        text: "",
        ast: astOf([
          heading(0, "Odůvodnění"),
          paragraph(1, 200),
          paragraph(2, 200),
          paragraph(3, 200),
        ]),
      }),
    });

    const docs = built.at(0)?.docs ?? [];
    expect(docs.length).toBeGreaterThan(1);

    // Re-indexing appends, so the previous copies are removed first. The
    // engine has no primary key to replace by and the indexer does not know
    // how many passages the previous version emitted, so the delete is scoped
    // to the document, not to individual passage ids. Every passage this row
    // emits must therefore be selected by that one query.
    expect(corpusDocumentDeleteQuery(row.id)).toBe(`document_id:"${row.id}"`);
    expect(docs.every((doc) => doc["document_id"] === row.id)).toBe(true);
    // Passage identities are distinct — a delete keyed on them would have to
    // enumerate all of them, which is the bookkeeping this avoids.
    expect(new Set(docs.map((doc) => doc["chunk_id"])).size).toBe(docs.length);
  });

  test("a row with neither AST nor text still emits one findable document", async () => {
    const row = makeRow({ id: "dec_empty", contentHash: "hash_3" });

    const { built } = await loadDocsForBatch([row], {
      generation: "case_law_v2",
      fetchFulltext: async () => null,
      readPayload: async () => ({ text: "", ast: null }),
    });

    const docs = built.at(0)?.docs ?? [];
    expect(docs).toHaveLength(1);
    expect(docs.at(0)?.["text"]).toBe("");
    // Metadata filters must still reach it; dropping it would hide a decision
    // that the indexer nonetheless marks as indexed.
    expect(docs.at(0)?.["document_id"]).toBe(row.id);
    expect(docs.at(0)?.["court"]).toBe("Test Court");
  });
});
