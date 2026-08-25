import { expect, test } from "bun:test";

import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexConfigFromManifest,
  corpusIndexManifestDigest,
  requireCorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";

const EXPECTED_DIGESTS = {
  case_law_v5:
    "95c84d0c4a841ab65b69469824cdde3c0c438e310fa004927ddf26af1ea4b60d",
  legislation_v2:
    "9ab1f962750f78cd4472a05551f6e265d55f428e0fb94de9b15467b61f24f9dd",
} as const satisfies Record<keyof typeof CORPUS_INDEX_MANIFESTS, string>;

test("the final-generation registry is exact and fails closed", () => {
  expect(Object.keys(CORPUS_INDEX_MANIFESTS).sort()).toEqual([
    "case_law_v5",
    "legislation_v2",
  ]);
  expect(requireCorpusIndexManifest("case_law", "case_law_v5")).toBe(
    CORPUS_INDEX_MANIFESTS.case_law_v5,
  );
  expect(requireCorpusIndexManifest("legislation", "legislation_v2")).toBe(
    CORPUS_INDEX_MANIFESTS.legislation_v2,
  );
  expect(() => requireCorpusIndexManifest("case_law", "case_law_v4")).toThrow(
    "Unknown case-law index manifest: case_law_v4",
  );
  expect(() =>
    requireCorpusIndexManifest("legislation", "legislation_v1"),
  ).toThrow("Unknown legislation index manifest: legislation_v1");
});

test("manifest digests pin every semantic array and ignore object key order", () => {
  expect(corpusIndexManifestDigest(CORPUS_INDEX_MANIFESTS.case_law_v5)).toBe(
    EXPECTED_DIGESTS.case_law_v5,
  );
  expect(
    corpusIndexManifestDigest(CORPUS_INDEX_MANIFESTS.legislation_v2),
  ).toBe(EXPECTED_DIGESTS.legislation_v2);
  for (const digest of Object.values(EXPECTED_DIGESTS)) {
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
  }

  const manifest = CORPUS_INDEX_MANIFESTS.case_law_v5;
  const rootKeysReordered = {
    route: manifest.route,
    projection: manifest.projection,
    engine: manifest.engine,
    cluster: manifest.cluster,
    generation: manifest.generation,
    family: manifest.family,
    schemaVersion: manifest.schemaVersion,
  } satisfies typeof manifest;
  expect(corpusIndexManifestDigest(rootKeysReordered)).toBe(
    EXPECTED_DIGESTS.case_law_v5,
  );

  const tagOrderChanged = {
    ...manifest,
    engine: {
      ...manifest.engine,
      indexConfig: {
        ...manifest.engine.indexConfig,
        doc_mapping: {
          ...manifest.engine.indexConfig.doc_mapping,
          tag_fields: [
            ...manifest.engine.indexConfig.doc_mapping.tag_fields,
          ].reverse(),
        },
      },
    },
  };
  expect(corpusIndexManifestDigest(tagOrderChanged)).not.toBe(
    EXPECTED_DIGESTS.case_law_v5,
  );
});

test("physical index ids are deployment state, not manifest identity", () => {
  const manifest = CORPUS_INDEX_MANIFESTS.case_law_v5;
  const csSkConfig = corpusIndexConfigFromManifest(
    manifest,
    "case_law_v5_cs_sk",
  );
  expect(csSkConfig).toEqual({
    ...manifest.engine.indexConfig,
    index_id: "case_law_v5_cs_sk",
  });
  expect(corpusIndexConfigFromManifest(manifest, "case_law_v5_pol")).toEqual({
    ...manifest.engine.indexConfig,
    index_id: "case_law_v5_pol",
  });
  expect(corpusIndexManifestDigest(manifest)).toBe(
    EXPECTED_DIGESTS.case_law_v5,
  );

  csSkConfig.doc_mapping.tag_fields.reverse();
  expect(manifest.engine.indexConfig.doc_mapping.tag_fields).toEqual([
    "jurisdiction",
    "document_type",
    "source",
    "court",
    "language",
  ]);
});

test("v5 removes stale and repeated physical fields", () => {
  const manifest = CORPUS_INDEX_MANIFESTS.case_law_v5;
  const fields = new Map(
    manifest.engine.indexConfig.doc_mapping.field_mappings.map((field) => [
      field.name,
      field,
    ]),
  );
  expect(manifest.engine.binaryVersion).toBe("0.9.0");
  expect(manifest.engine.indexConfig.version).toBe("0.8");
  expect(manifest.engine.indexConfig.doc_mapping.mode).toBe("strict");
  expect(manifest.engine.indexConfig.doc_mapping.timestamp_field).toBe(
    "decision_date_ts",
  );
  expect(manifest.engine.indexConfig.doc_mapping.tokenizers).toEqual([
    {
      name: "folded",
      type: "simple",
      filters: ["lower_caser", "ascii_folding", "remove_long"],
    },
  ]);
  expect(fields.get("document_id")).toMatchObject({
    tokenizer: "raw",
    indexed: true,
    stored: true,
    fast: false,
  });
  expect(fields.get("projection_revision")).toMatchObject({
    tokenizer: "raw",
    indexed: true,
    stored: true,
    fast: false,
  });
  expect(fields.get("is_opening")).toEqual({
    name: "is_opening",
    type: "bool",
    indexed: true,
    stored: false,
    fast: false,
  });
  expect(fields.get("title")).toMatchObject({
    tokenizer: "folded",
    indexed: true,
    stored: false,
    fast: false,
  });
  expect(fields.get("text")).toMatchObject({
    tokenizer: "folded",
    indexed: true,
    stored: true,
    fast: false,
  });
  expect(fields.get("anchor_id")).toEqual({
    name: "anchor_id",
    type: "text",
    indexed: false,
    stored: true,
    fast: false,
  });
  expect(fields.get("decision_date_ts")).toMatchObject({
    type: "datetime",
    indexed: true,
    stored: false,
    fast: true,
    fast_precision: "seconds",
  });

});

test("final manifests make every storage and index cost explicit", () => {
  for (const manifest of Object.values(CORPUS_INDEX_MANIFESTS)) {
    const fields = new Set(
      manifest.engine.indexConfig.doc_mapping.field_mappings.map(
        ({ name }) => name,
      ),
    );
    for (const field of manifest.engine.indexConfig.doc_mapping.field_mappings) {
      expect(typeof field.indexed).toBe("boolean");
      expect(typeof field.stored).toBe("boolean");
      expect(typeof field.fast).toBe("boolean");
    }
    for (const absent of [
      "year",
      "seq",
      "chunk_id",
      "heading_path",
      "citation_authority",
      "citation_count",
      "canonical_text_key",
      "canonical_ast_key",
    ]) {
      expect(fields.has(absent)).toBe(false);
    }
    expect(manifest.engine.indexConfig.doc_mapping.store_source).toBe(false);
    expect(manifest.engine.indexConfig.search_settings).toEqual({
      default_search_fields: ["title", "text"],
    });
  }
});

test("published manifests are immutable snapshots", () => {
  expect(Object.isFrozen(CORPUS_INDEX_MANIFESTS)).toBe(true);
  for (const manifest of Object.values(CORPUS_INDEX_MANIFESTS)) {
    const tokenizerFilters =
      manifest.engine.indexConfig.doc_mapping.tokenizers.at(0)?.filters;
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.engine.indexConfig)).toBe(true);
    expect(
      Object.isFrozen(manifest.engine.indexConfig.doc_mapping.field_mappings),
    ).toBe(true);
    expect(
      Object.isFrozen(manifest.engine.indexConfig.doc_mapping.tag_fields),
    ).toBe(true);
    expect(tokenizerFilters).toEqual([
      "lower_caser",
      "ascii_folding",
      "remove_long",
    ]);
    expect(Object.isFrozen(tokenizerFilters)).toBe(true);
  }
});

test("route topology and tag pruning are part of the manifest", () => {
  const caseLaw = CORPUS_INDEX_MANIFESTS.case_law_v5;
  expect(caseLaw.route).toEqual({
    type: "case_law_group",
    byJurisdiction: {
      AUT: "aut",
      CZE: "cs_sk",
      EU: "eu",
      POL: "pol",
      SVK: "cs_sk",
    },
  });
  expect(caseLaw.engine.indexConfig.doc_mapping.tag_fields).toEqual([
    "jurisdiction",
    "document_type",
    "source",
    "court",
    "language",
  ]);

  const legislation = CORPUS_INDEX_MANIFESTS.legislation_v2;
  // Plane may add a jurisdiction without changing the public routing rule:
  // every legislation jurisdiction always receives its own physical index.
  expect(legislation.route).toEqual({ type: "jurisdiction" });
  expect(legislation.engine.indexConfig.doc_mapping.mode).toBe("strict");
  expect(legislation.engine.indexConfig.doc_mapping.tag_fields).toEqual([
    "jurisdiction",
    "document_type",
    "source",
    "status",
    "language",
  ]);
});
