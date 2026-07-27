import { describe, expect, test } from "bun:test";

import { loadDocsForBatch } from "@/api/handlers/case-law/corpus-index";
import { toSafeId } from "@/api/lib/branded-types";
import { corpusDocumentDeleteQuery } from "@/api/lib/corpus-index/core";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";

type MakeRowOptions = {
  id: string;
  contentHash: string;
  textS3Key?: string | null;
};

const makeRow = ({ id, contentHash, textS3Key }: MakeRowOptions) => ({
  id: toSafeId<"caseLawDecision">(id),
  sourceId: toSafeId<"caseLawSource">("src_1"),
  caseNumber: `case-${id}`,
  ecli: null,
  court: "Test Court",
  country: "CZ",
  language: "cs",
  decisionDate: "2024-01-01",
  decisionType: null,
  citationAuthority: 0,
  citationCount: 0,
  textS3Key:
    textS3Key === undefined ? `legal-corpus/${id}/text.zst` : textS3Key,
  astS3Key: null,
  contentHash,
  indexedHash: null,
  indexedGeneration: null,
  updatedAt: new Date("2024-01-01T00:00:00Z"),
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
