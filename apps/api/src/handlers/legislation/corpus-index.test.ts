import { describe, expect, test } from "bun:test";

import { loadDocsForBatch } from "@/api/handlers/legislation/corpus-index";
import { toSafeId } from "@/api/lib/branded-types";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";

type MakeRowOptions = {
  id: string;
  contentHash: string;
  textS3Key?: string | null;
};

const makeRow = ({ id, contentHash, textS3Key }: MakeRowOptions) => ({
  id: toSafeId<"legislationDocument">(id),
  sourceId: toSafeId<"legislationSource">("src_1"),
  eli: `/eli/cz/act/2024/${id}`,
  title: `Act ${id}`,
  country: "CZ",
  language: "cs",
  documentType: null,
  status: "in_force",
  effectiveDate: "2024-01-01",
  versionValidFrom: null,
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

describe("legislation loadDocsForBatch read-failure isolation", () => {
  test("a single document's read failure is recorded while the batch continues", async () => {
    const generation = "legislation_v1";
    const okRow = makeRow({ id: "leg_ok", contentHash: "hash_ok" });
    const badRow = makeRow({ id: "leg_bad", contentHash: "hash_bad" });

    const { docs, readFailures } = await loadDocsForBatch([okRow, badRow], {
      generation,
      fetchFulltext: async () => null,
      readText: async (row) => {
        if (row.id === badRow.id) {
          throw new TimeoutError({
            message: "corpus-read-text exceeded 60000ms",
            label: "corpus-read-text",
          });
        }
        return `text for ${row.id}`;
      },
    });

    // The healthy document still builds and stays in the batch.
    expect(docs).toHaveLength(1);
    const built = docs.at(0);
    expect(built?.row.id).toBe(okRow.id);
    expect(built?.doc["text"]).toBe(`text for ${okRow.id}`);

    // The failed read is isolated as a failed index job for its jurisdiction.
    expect(readFailures).toHaveLength(1);
    const failure = readFailures.at(0);
    expect(failure?.indexId).toBe(corpusIndexId(generation, "CZ"));
    expect(failure?.job).toMatchObject({
      documentId: badRow.id,
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

    const { docs, readFailures } = await loadDocsForBatch([legacyRow], {
      generation,
      fetchFulltext: async (id) => {
        fetchedIds.push(id);
        return "stored fulltext";
      },
    });

    expect(readFailures).toHaveLength(0);
    expect(docs).toHaveLength(1);
    expect(docs.at(0)?.doc["text"]).toBe("stored fulltext");
    // The lazy fallback runs only for the S3-less row, keyed by its id.
    expect(fetchedIds).toEqual([legacyRow.id]);
  });
});
