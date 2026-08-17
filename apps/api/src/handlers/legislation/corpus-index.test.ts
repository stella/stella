import { describe, expect, test } from "bun:test";

import { loadDocsForBatch } from "@/api/handlers/legislation/corpus-index";
import { toSafeId } from "@/api/lib/branded-types";
import type { TimestampCasToken } from "@/api/lib/db/timestamp-cas";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { corpusIndexConfig } from "@/api/lib/legal-search/corpus-index-config";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";

type MakeRowOptions = {
  id: string;
  contentHash: string;
  textS3Key?: string | null;
  astS3Key?: string | null;
  documentType?: string | null;
  effectiveDate?: string | null;
};

const makeRow = ({
  id,
  contentHash,
  textS3Key,
  astS3Key = null,
  documentType = null,
  effectiveDate = "2024-01-01",
}: MakeRowOptions) => ({
  id: toSafeId<"legislationDocument">(id),
  sourceId: toSafeId<"legislationSource">("src_1"),
  eli: `/eli/cz/act/2024/${id}`,
  title: `Act ${id}`,
  country: "CZ",
  language: "cs",
  documentType,
  status: "in_force",
  effectiveDate,
  versionValidFrom: "2024-02-02",
  citationAuthority: 0,
  citationCount: 0,
  textS3Key:
    textS3Key === undefined ? `legal-corpus/${id}/text.zst` : textS3Key,
  astS3Key,
  contentHash,
  indexedHash: null,
  indexedGeneration: null,
  // SAFETY: tests fabricate the branded token the adapters normally
  // select as `updated_at::text`.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  updatedAtToken: "2024-01-01 00:00:00" as TimestampCasToken,
});

describe("legislation loadDocsForBatch read-failure isolation", () => {
  test("a single document's read failure is recorded while the batch continues", async () => {
    const generation = "legislation_v1";
    const okRow = makeRow({ id: "leg_ok", contentHash: "hash_ok" });
    const badRow = makeRow({ id: "leg_bad", contentHash: "hash_bad" });

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
    // Legislation stays document-granular: one row, exactly one document.
    expect(entry?.docs).toHaveLength(1);
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
    const generation = "legislation_v1";
    const legacyRow = makeRow({
      id: "leg_legacy",
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
    expect(built.at(0)?.docs).toHaveLength(1);
    expect(built.at(0)?.docs.at(0)?.["text"]).toBe("stored fulltext");
    // The lazy fallback runs only for the S3-less row, keyed by its id.
    expect(fetchedIds).toEqual([legacyRow.id]);
  });

  test("every field the projection writes is one the doc mapping declares", async () => {
    // A generation created from the current config maps in `strict` mode: a
    // document carrying a field the mapping does not declare is rejected at
    // ingest. The writer and the mapping are two halves of one shape, and this
    // is the half nothing else checks.
    const rows = [
      makeRow({
        id: "leg_full",
        astS3Key: "legal-corpus/leg_full/ast.zst",
        contentHash: "hash_full",
        documentType: "zákon",
      }),
      makeRow({
        id: "leg_sparse",
        contentHash: "hash_sparse",
        effectiveDate: null,
        textS3Key: null,
      }),
    ];

    const { built } = await loadDocsForBatch(rows, {
      generation: "legislation_v2",
      fetchFulltext: async () => "stored fulltext",
      readPayload: async () => ({ text: "text", ast: null }),
    });

    const docs = built.flatMap((entry) => entry.docs);
    const emitted = new Set(docs.flatMap((doc) => Object.keys(doc)));
    const mapped = new Set(
      corpusIndexConfig(
        "legislation",
        "legislation_v2_svk",
      ).doc_mapping.field_mappings.map((field) => field.name),
    );
    expect([...emitted].filter((name) => !mapped.has(name)).sort()).toEqual([]);

    // The fixtures reach the conditional fields, so the assertion is over the
    // writer's whole shape rather than its required half.
    for (const field of [
      "canonical_ast_key",
      "canonical_text_key",
      "document_type",
      "effective_date",
      "eli",
      "status",
      "year",
    ]) {
      expect(emitted.has(field)).toBe(true);
    }
  });
});
