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
  versionValidFrom?: string | null;
  versionValidTo?: string | null;
};

const makeRow = ({
  id,
  contentHash,
  textS3Key,
  astS3Key = null,
  documentType = null,
  effectiveDate = "2024-01-01",
  versionValidFrom = "2024-02-02",
  versionValidTo = null,
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
  versionValidFrom,
  versionValidTo,
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
        versionValidTo: "2025-01-01",
      }),
      makeRow({
        id: "leg_sparse",
        contentHash: "hash_sparse",
        effectiveDate: null,
        textS3Key: null,
        versionValidFrom: null,
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
      "document_type",
      "effective_date",
      "eli",
      "status",
      "version_valid_from",
      "version_valid_to",
      "year",
    ]) {
      expect(emitted.has(field)).toBe(true);
    }
    expect(
      [...emitted].filter((name) => name.startsWith("canonical_")),
    ).toEqual([]);
  });

  test("the validity window is written verbatim, open where the source left it open", async () => {
    const superseded = makeRow({
      id: "leg_superseded",
      contentHash: "hash_superseded",
      versionValidFrom: "2020-01-01",
      versionValidTo: "2024-07-01",
    });
    const current = makeRow({
      id: "leg_current",
      contentHash: "hash_current",
      versionValidFrom: "2024-07-01",
      versionValidTo: null,
    });

    const { built } = await loadDocsForBatch([superseded, current], {
      generation: "legislation_v2",
      fetchFulltext: async () => null,
      readPayload: async () => ({ text: "text", ast: null }),
    });

    const docById = new Map(
      built.map((entry) => [String(entry.row.id), entry.docs.at(0) ?? {}]),
    );

    // Half-open `[from, to)`: a superseded consolidation carries both bounds,
    // and both reach the engine as the source published them.
    expect(docById.get(superseded.id)?.["version_valid_from"]).toBe(
      "2020-01-01",
    );
    expect(docById.get(superseded.id)?.["version_valid_to"]).toBe("2024-07-01");

    // The current consolidation is open-ended, and absence is what marks it: a
    // stand-in upper bound would make it expire on a date the source never set.
    const currentDoc = docById.get(current.id) ?? {};
    expect(currentDoc["version_valid_from"]).toBe("2024-07-01");
    expect(
      Object.keys(currentDoc).filter((name) => name.startsWith("version_")),
    ).toEqual(["version_valid_from"]);

    // The window exists to be filtered on in the engine, so both bounds have to
    // be fast datetimes in the mapping this writer is paired with. Read off the
    // config rather than restated, or the two halves can drift apart.
    const mapped = new Map(
      corpusIndexConfig(
        "legislation",
        "legislation_v2_svk",
      ).doc_mapping.field_mappings.map((field) => [field.name, field]),
    );
    for (const name of ["version_valid_from", "version_valid_to"]) {
      expect([name, mapped.get(name)?.type, mapped.get(name)?.fast]).toEqual([
        name,
        "datetime",
        true,
      ]);
    }
  });
});
