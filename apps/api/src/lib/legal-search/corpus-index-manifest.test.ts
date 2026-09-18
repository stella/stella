import { expect, test } from "bun:test";

import {
  CASE_LAW_JURISDICTIONS,
  type CaseLawJurisdiction,
} from "@stll/api-contract/case-law-jurisdictions";

import type { CaseLawIndexGroup } from "@/api/lib/legal-search/case-law-index-groups";
import { CORPUS_INDEX_COMMIT_TIMEOUT_SECS } from "@/api/lib/legal-search/corpus-index-config";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexConfigFromManifest,
  corpusIndexIdFromManifest,
  corpusIndexManifestDigest,
  corpusIndexPublisherFields,
  corpusIndexRoute,
  corpusIndexStemFields,
  requireCorpusIndexIdForManifest,
  requireCorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";

/**
 * A published generation's digest is the identity every projection fingerprint
 * is derived from, so it may never move: a changed digest re-projects the whole
 * corpus. Extend this map with a new generation; edit an entry only for a
 * generation nothing has built.
 */
const EXPECTED_DIGESTS = {
  case_law_v5:
    "7ee1e1bdbc0a1c746407333cac6eba21446d32b0eca461235569eac4197ed0ce",
  case_law_v6:
    "1fc5f09b5471e49a4e5588c9f59c3ce78c08a9aa54b55e5edef168bc315accc8",
  case_law_v7:
    "ca567a8f26fc3c4af987db655943ac46bbde12af27379b927239e795eb16d2d0",
  legislation_v2:
    "dc252d8635081d8037e7f9b1aca6713181a27390e8eb6dda54139ae6a1e68583",
} as const satisfies Record<keyof typeof CORPUS_INDEX_MANIFESTS, string>;

type CaseLawManifestGeneration = {
  [
    TGeneration in keyof typeof CORPUS_INDEX_MANIFESTS
  ]: (typeof CORPUS_INDEX_MANIFESTS)[TGeneration]["family"] extends "case_law"
    ? TGeneration
    : never;
}[keyof typeof CORPUS_INDEX_MANIFESTS];

/**
 * Every physical index a case-law generation routes a declared jurisdiction
 * to. The counterpart of `EXPECTED_DIGESTS`: that one pins what a generation
 * *is*, this one pins where its rows *go*.
 *
 * Grow-only. Declaring a jurisdiction adds a line per generation and edits
 * none, which is the whole point: a country is added without touching the
 * countries already indexed. Moving or dropping an existing line moves live
 * rows between physical indexes, which no code path can repair, so a line here
 * may never change once its index holds splits.
 *
 * The baseline is literal and the routes it is checked against are derived
 * from `CASE_LAW_INDEX_GROUP_OF`, so a group renamed or reassigned there fails
 * this rather than silently re-pointing a generation.
 */
const EXPECTED_CASE_LAW_ROUTES = {
  case_law_v5: {
    AUT: "aut",
    CZE: "cs_sk",
    EU: "eu",
    HUN: "hun",
    POL: "pol",
    SVK: "cs_sk",
  },
  case_law_v6: {
    AUT: "aut",
    CZE: "cs_sk",
    EU: "eu",
    HUN: "hun",
    POL: "pol",
    SVK: "cs_sk",
  },
  case_law_v7: {
    AUT: "aut",
    CZE: "cs_sk",
    EU: "eu",
    HUN: "hun",
    POL: "pol",
    SVK: "cs_sk",
  },
} as const satisfies Record<
  CaseLawManifestGeneration,
  Record<CaseLawJurisdiction, CaseLawIndexGroup>
>;

test("the final-generation registry is exact and fails closed", () => {
  expect(Object.keys(CORPUS_INDEX_MANIFESTS).sort()).toEqual([
    "case_law_v5",
    "case_law_v6",
    "case_law_v7",
    "legislation_v2",
  ]);
  expect(requireCorpusIndexManifest("case_law", "case_law_v5")).toBe(
    CORPUS_INDEX_MANIFESTS.case_law_v5,
  );
  expect(requireCorpusIndexManifest("case_law", "case_law_v6")).toBe(
    CORPUS_INDEX_MANIFESTS.case_law_v6,
  );
  expect(requireCorpusIndexManifest("case_law", "case_law_v7")).toBe(
    CORPUS_INDEX_MANIFESTS.case_law_v7,
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
  expect(corpusIndexManifestDigest(CORPUS_INDEX_MANIFESTS.case_law_v6)).toBe(
    EXPECTED_DIGESTS.case_law_v6,
  );
  expect(corpusIndexManifestDigest(CORPUS_INDEX_MANIFESTS.case_law_v7)).toBe(
    EXPECTED_DIGESTS.case_law_v7,
  );
  expect(corpusIndexManifestDigest(CORPUS_INDEX_MANIFESTS.legislation_v2)).toBe(
    EXPECTED_DIGESTS.legislation_v2,
  );
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
          tag_fields:
            manifest.engine.indexConfig.doc_mapping.tag_fields.toReversed(),
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
    indexing_settings: {
      ...manifest.engine.indexConfig.indexing_settings,
      merge_policy: {
        ...manifest.engine.indexConfig.indexing_settings.merge_policy,
        maturation_period: "4h",
      },
    },
  });
  expect(corpusIndexConfigFromManifest(manifest, "case_law_v5_pol")).toEqual({
    ...manifest.engine.indexConfig,
    index_id: "case_law_v5_pol",
    indexing_settings: {
      ...manifest.engine.indexConfig.indexing_settings,
      merge_policy: {
        ...manifest.engine.indexConfig.indexing_settings.merge_policy,
        maturation_period: "4h",
      },
    },
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

test("every declared jurisdiction routes into every case-law generation", () => {
  expect(
    Object.values(CORPUS_INDEX_MANIFESTS)
      .filter((manifest) => manifest.family === "case_law")
      .map((manifest) => manifest.generation)
      .sort(),
  ).toEqual(Object.keys(EXPECTED_CASE_LAW_ROUTES).sort());

  for (const [generation, routes] of Object.entries(EXPECTED_CASE_LAW_ROUTES)) {
    const manifest = requireCorpusIndexManifest("case_law", generation);
    // The baseline answers for the whole declared union, so declaring a
    // jurisdiction is not finished until its line is here.
    expect(Object.keys(routes).sort()).toEqual(
      [...CASE_LAW_JURISDICTIONS].sort(),
    );
    for (const [jurisdiction, group] of Object.entries(routes)) {
      const indexId = `${generation}_${group}`;
      expect([
        corpusIndexIdFromManifest(manifest, jurisdiction),
        corpusIndexIdFromManifest(manifest, jurisdiction.toLowerCase()),
        requireCorpusIndexIdForManifest(manifest, indexId),
      ]).toEqual([indexId, indexId, indexId]);
    }
  }
  // Non-vacuity: the generations were built before Hungary was declared, and
  // it reaches all three without one of them changing.
  expect(
    corpusIndexIdFromManifest(CORPUS_INDEX_MANIFESTS.case_law_v7, "HUN"),
  ).toBe("case_law_v7_hun");
  expect(
    Object.keys(CORPUS_INDEX_MANIFESTS.case_law_v7.route.byJurisdiction),
  ).not.toContain("HUN");
});

test("the groups a generation was created with still route there", () => {
  // A created index holds splits under its own id, so the jurisdictions it was
  // created for may never be re-pointed at another one. The creation topology
  // is part of the digest; this proves the live declaration still agrees with
  // it, which is the property the digest alone cannot state.
  for (const manifest of Object.values(CORPUS_INDEX_MANIFESTS)) {
    if (manifest.route.type !== "case_law_group") {
      continue;
    }
    const created = Object.entries(manifest.route.byJurisdiction);
    expect(created.length).toBeGreaterThan(0);
    for (const [jurisdiction, group] of created) {
      expect([
        jurisdiction,
        corpusIndexIdFromManifest(manifest, jurisdiction),
      ]).toEqual([jurisdiction, `${manifest.generation}_${group}`]);
    }
  }
});

test("case-law routing stays closed over the declared union", () => {
  // A stored country code nobody declared a group for would otherwise derive
  // an index of its own that nothing ever created, and the projection would
  // drain into a 404. Legislation routes any valid code by design.
  expect(() =>
    corpusIndexIdFromManifest(CORPUS_INDEX_MANIFESTS.case_law_v5, "ROU"),
  ).toThrow("Undeclared case-law jurisdiction: ROU");
  expect(
    corpusIndexIdFromManifest(CORPUS_INDEX_MANIFESTS.legislation_v2, "HUN"),
  ).toBe("legislation_v2_hun");
  expect(() =>
    corpusIndexIdFromManifest(CORPUS_INDEX_MANIFESTS.legislation_v2, "cz;drop"),
  ).toThrow("Invalid corpus jurisdiction");
});

test("a query routes through the generation, not the live group map", () => {
  // Shared index: the clause keeps the query to the scoped jurisdiction.
  expect(corpusIndexRoute(CORPUS_INDEX_MANIFESTS.case_law_v7, "CZE")).toEqual({
    indexId: "case_law_v7_cs_sk",
    jurisdictionClause: "CZE",
  });
  // The clause is the canonical code indexed documents carry, whatever case
  // the scope arrived in.
  expect(corpusIndexRoute(CORPUS_INDEX_MANIFESTS.case_law_v7, "cze")).toEqual({
    indexId: "case_law_v7_cs_sk",
    jurisdictionClause: "CZE",
  });
  // A single-jurisdiction index is bounded by the index alone.
  expect(corpusIndexRoute(CORPUS_INDEX_MANIFESTS.case_law_v7, "POL")).toEqual({
    indexId: "case_law_v7_pol",
    jurisdictionClause: undefined,
  });
  expect(
    corpusIndexRoute(CORPUS_INDEX_MANIFESTS.case_law_v7, undefined),
  ).toEqual({ indexId: "case_law_v7_*", jurisdictionClause: undefined });
  // Declared in the live group map, unrouted by this generation: the query
  // fails instead of naming an index the generation never created.
  expect(() =>
    corpusIndexRoute(CORPUS_INDEX_MANIFESTS.case_law_v7, "HUN"),
  ).toThrow("Unrouted case-law jurisdiction: HUN");
  expect(
    corpusIndexRoute(CORPUS_INDEX_MANIFESTS.legislation_v2, "HUN"),
  ).toEqual({ indexId: "legislation_v2_hun", jurisdictionClause: undefined });
});

test("physical route validation is exact for closed and open manifests", () => {
  expect(
    requireCorpusIndexIdForManifest(
      CORPUS_INDEX_MANIFESTS.case_law_v5,
      "case_law_v5_cs_sk",
    ),
  ).toBe("case_law_v5_cs_sk");
  // A grouped jurisdiction's own code is not an index: only the group is.
  expect(() =>
    requireCorpusIndexIdForManifest(
      CORPUS_INDEX_MANIFESTS.case_law_v5,
      "case_law_v5_cze",
    ),
  ).toThrow("Corpus index id is not a manifest route");
  expect(() =>
    requireCorpusIndexIdForManifest(
      CORPUS_INDEX_MANIFESTS.case_law_v5,
      "case_law_v5_rou",
    ),
  ).toThrow("Corpus index id is not a manifest route");
  expect(
    requireCorpusIndexIdForManifest(
      CORPUS_INDEX_MANIFESTS.legislation_v2,
      "legislation_v2_cze",
    ),
  ).toBe("legislation_v2_cze");
  expect(() =>
    requireCorpusIndexIdForManifest(
      CORPUS_INDEX_MANIFESTS.legislation_v2,
      "legislation_v2_CZE",
    ),
  ).toThrow("Corpus index id is not a manifest route");
  expect(() =>
    requireCorpusIndexIdForManifest(
      CORPUS_INDEX_MANIFESTS.legislation_v2,
      "case_law_v5_cze",
    ),
  ).toThrow("Corpus index id is not a manifest route");
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
  expect(manifest.projection.builderVersion).toBe("case-law-passages-v1");
  expect(manifest.engine.indexConfig.version).toBe("0.9");
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
    stored: false,
    fast: true,
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
    fieldnorms: false,
  });
  expect(fields.get("decision_date_ts")).toMatchObject({
    type: "datetime",
    indexed: true,
    stored: false,
    fast: true,
    fast_precision: "seconds",
    output_format: "rfc3339",
  });
  expect(fields.get("decision_year")).toEqual({
    name: "decision_year",
    type: "u64",
    indexed: false,
    stored: false,
    fast: true,
    coerce: true,
    output_format: "number",
  });
  expect(manifest.projection.yearFacetField).toBe("decision_year");
});

/** Per generation, and total so a new generation answers rather than inherits. */
const EXPECTED_DOCSTORE_BLOCKSIZE = {
  case_law_v5: 1_000_000,
  case_law_v6: 1_000_000,
  case_law_v7: 65_536,
  legislation_v2: 1_000_000,
} as const satisfies Record<keyof typeof CORPUS_INDEX_MANIFESTS, number>;

test("final manifests make every storage and index cost explicit", () => {
  for (const manifest of Object.values(CORPUS_INDEX_MANIFESTS)) {
    const fields = new Set(
      manifest.engine.indexConfig.doc_mapping.field_mappings.map(
        ({ name }) => name,
      ),
    );
    for (const field of manifest.engine.indexConfig.doc_mapping
      .field_mappings) {
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
    expect(manifest.engine.indexConfig.doc_mapping.max_num_partitions).toBe(
      200,
    );
    expect(manifest.engine.indexConfig.doc_mapping.index_field_presence).toBe(
      false,
    );
    expect(manifest.engine.indexConfig.doc_mapping.store_document_size).toBe(
      false,
    );
    expect(manifest.engine.indexConfig.indexing_settings).toMatchObject({
      commit_timeout_secs: 60,
      docstore_blocksize: EXPECTED_DOCSTORE_BLOCKSIZE[manifest.generation],
      docstore_compression_level: 8,
      merge_policy: {
        type: "stable_log",
        maturation_period: "4hours",
        merge_factor: 10,
        max_merge_factor: 12,
        min_level_num_docs: 100_000,
      },
      split_num_docs_target: 10_000_000,
      resources: { heap_size: 2_000_000_000 },
    });
    expect(manifest.engine.indexConfig.ingest_settings).toEqual({
      min_shards: 1,
    });
    expect(manifest.engine.indexConfig.retention).toBeNull();
    // Exact, over every generation: a hit is a passage and its stored `text`
    // is the excerpt that stands for the match, so a field written to one
    // passage of a document may never be reachable by a bare term.
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

test("creation topology and tag pruning are part of the manifest", () => {
  const caseLaw = CORPUS_INDEX_MANIFESTS.case_law_v5;
  // The groups this generation's indexes were created for, which is what the
  // digest carries. Where a jurisdiction's rows go is decided live, so Hungary
  // is absent here and routed all the same.
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
  expect(caseLaw.engine.indexConfig.indexing_settings.commit_timeout_secs).toBe(
    CORPUS_INDEX_COMMIT_TIMEOUT_SECS,
  );

  const legislation = CORPUS_INDEX_MANIFESTS.legislation_v2;
  // Plane may add a jurisdiction without changing the public routing rule:
  // every legislation jurisdiction always receives its own physical index.
  expect(legislation.route).toEqual({ type: "jurisdiction" });
  expect(legislation.projection.builderVersion).toBe("legislation-document-v1");
  expect(legislation.engine.indexConfig.doc_mapping.mode).toBe("strict");
  expect(legislation.engine.indexConfig.doc_mapping.tag_fields).toEqual([
    "jurisdiction",
    "document_type",
    "source",
    "status",
    "language",
  ]);
});

test("v6 adds the publisher summary and nothing else", () => {
  const v5 = CORPUS_INDEX_MANIFESTS.case_law_v5.engine.indexConfig.doc_mapping;
  const v6 = CORPUS_INDEX_MANIFESTS.case_law_v6.engine.indexConfig.doc_mapping;

  expect(v6.field_mappings.map(({ name }) => name)).toEqual([
    ...v5.field_mappings.map(({ name }) => name),
    "headnote",
    "text_stem",
    "headnote_stem",
  ]);
  expect(v6.field_mappings.at(-3)).toEqual({
    name: "headnote",
    type: "text",
    tokenizer: "folded",
    record: "position",
    fieldnorms: true,
    indexed: true,
    stored: false,
    fast: false,
  });
  expect(v6.mode).toBe("strict");
  expect(v6.tag_fields).toEqual(v5.tag_fields);
  expect(v6.timestamp_field).toBe(v5.timestamp_field);
  expect(CORPUS_INDEX_MANIFESTS.case_law_v6.projection.builderVersion).toBe(
    "case-law-passages-v2",
  );
});

test("v7 gives the publisher's classification a field of its own", () => {
  const v6 = CORPUS_INDEX_MANIFESTS.case_law_v6.engine.indexConfig.doc_mapping;
  const v7 = CORPUS_INDEX_MANIFESTS.case_law_v7.engine.indexConfig.doc_mapping;

  expect(v7.field_mappings.map(({ name }) => name)).toEqual([
    ...v6.field_mappings.map(({ name }) => name),
    "keywords",
  ]);
  // The headnote's mapping, minus the fieldnorms BM25 length normalization
  // runs on: a two-word tag list must not outscore a sentence a publisher
  // wrote, for the same term, on brevity alone.
  expect(v7.field_mappings.at(-1)).toEqual({
    name: "keywords",
    type: "text",
    tokenizer: "folded",
    record: "position",
    fieldnorms: false,
    indexed: true,
    stored: false,
    fast: false,
  });
  expect(v7.mode).toBe("strict");
  expect(v7.tag_fields).toEqual(v6.tag_fields);
  expect(v7.timestamp_field).toBe(v6.timestamp_field);
  expect(CORPUS_INDEX_MANIFESTS.case_law_v7.projection.builderVersion).toBe(
    "case-law-passages-v3",
  );
});

test("v7 carries its own docstore settings and marks the ids fast", () => {
  const v6 = CORPUS_INDEX_MANIFESTS.case_law_v6.engine.indexConfig;
  const v7 = CORPUS_INDEX_MANIFESTS.case_law_v7.engine.indexConfig;

  // Only the block size moves; every other indexing setting is v6's.
  expect(v6.indexing_settings.docstore_blocksize).toBe(1_000_000);
  expect(v7.indexing_settings).toEqual({
    ...v6.indexing_settings,
    docstore_blocksize: 65_536,
  });

  const idFields = (config: typeof v6) =>
    config.doc_mapping.field_mappings.filter((field) =>
      ["document_id", "anchor_id"].includes(field.name),
    );
  // Fast in v7, stored in both, and identical otherwise.
  const v6Ids = idFields(v6);
  const v7Ids = idFields(v7);
  expect(v6Ids.map(({ name, fast, stored }) => [name, fast, stored])).toEqual([
    ["document_id", false, true],
    ["anchor_id", false, true],
  ]);
  expect(v7Ids.map(({ fast }) => fast)).toEqual([true, true]);
  const v7IdsWithoutFast: typeof v6Ids = [];
  for (const field of v7Ids) {
    v7IdsWithoutFast.push({ ...field, fast: false });
  }
  expect(v7IdsWithoutFast).toEqual(v6Ids);

  // Every other field is v6's, `keywords` aside.
  const carriedFields = (config: typeof v6) =>
    config.doc_mapping.field_mappings.filter(
      (field) => !["document_id", "anchor_id", "keywords"].includes(field.name),
    );
  expect(carriedFields(v7)).toEqual(carriedFields(v6));
});

test("only a generation that maps a publisher field reports one", () => {
  expect(
    corpusIndexPublisherFields(CORPUS_INDEX_MANIFESTS.case_law_v5),
  ).toEqual({ kind: "none" });
  // v6 has one field for everything a publisher wrote, and keeps it: changing
  // what a built generation writes would leave two readings of one field
  // inside a single index.
  expect(
    corpusIndexPublisherFields(CORPUS_INDEX_MANIFESTS.case_law_v6),
  ).toEqual({ kind: "summary", summaryField: "headnote" });
  expect(
    corpusIndexPublisherFields(CORPUS_INDEX_MANIFESTS.case_law_v7),
  ).toEqual({
    kind: "summary_and_keywords",
    summaryField: "headnote",
    keywordsField: "keywords",
  });
  expect(
    corpusIndexPublisherFields(CORPUS_INDEX_MANIFESTS.legislation_v2),
  ).toEqual({ kind: "none" });
  for (const manifest of Object.values(CORPUS_INDEX_MANIFESTS)) {
    const publisher = corpusIndexPublisherFields(manifest);
    const declared = new Set(
      manifest.engine.indexConfig.doc_mapping.field_mappings.map(
        ({ name }) => name,
      ),
    );
    switch (publisher.kind) {
      case "none":
        break;
      case "summary":
        expect(declared.has(publisher.summaryField)).toBe(true);
        break;
      case "summary_and_keywords":
        expect([
          declared.has(publisher.summaryField),
          declared.has(publisher.keywordsField),
        ]).toEqual([true, true]);
        break;
      default:
        publisher satisfies never;
        throw new Error("Unhandled publisher fields");
    }
  }
});

test("v6 keeps the default search fields v5 has", () => {
  // The load-bearing property behind the whole design: a hit is a passage, and
  // its stored `text` is what a reader and the research answer runner are
  // handed as the excerpt that matched. A field written to the opening passage
  // only — the summary, or either stem — must never be reachable by a bare
  // term, or a summary-only match would answer with a passage whose text does
  // not carry the terms. The query builder names those fields explicitly.
  const defaultsOf = (
    generation: "case_law_v5" | "case_law_v6" | "case_law_v7",
  ) =>
    CORPUS_INDEX_MANIFESTS[generation].engine.indexConfig.search_settings
      .default_search_fields;

  expect(defaultsOf("case_law_v6")).toEqual(["title", "text"]);
  expect(defaultsOf("case_law_v6")).toEqual(defaultsOf("case_law_v5"));
  expect(defaultsOf("case_law_v7")).toEqual(defaultsOf("case_law_v6"));
  for (const absent of ["headnote", "keywords", "text_stem", "headnote_stem"]) {
    expect(defaultsOf("case_law_v7")).not.toContain(absent);
  }
});

test("only a generation that maps the stem fields reports them", () => {
  expect(corpusIndexStemFields(CORPUS_INDEX_MANIFESTS.case_law_v5)).toBeNull();
  expect(corpusIndexStemFields(CORPUS_INDEX_MANIFESTS.case_law_v6)).toEqual({
    text: "text_stem",
    publisherSummary: "headnote_stem",
  });
  // v7 stems the same two fields. The classification is a controlled
  // vocabulary matched on the words it is written in, so it carries no stem
  // companion; adding one is a mapping change and therefore a generation.
  expect(corpusIndexStemFields(CORPUS_INDEX_MANIFESTS.case_law_v7)).toEqual({
    text: "text_stem",
    publisherSummary: "headnote_stem",
  });
  expect(
    corpusIndexStemFields(CORPUS_INDEX_MANIFESTS.legislation_v2),
  ).toBeNull();
  for (const manifest of Object.values(CORPUS_INDEX_MANIFESTS)) {
    const fields = corpusIndexStemFields(manifest);
    if (fields === null) {
      continue;
    }
    const declared = new Set(
      manifest.engine.indexConfig.doc_mapping.field_mappings.map(
        ({ name }) => name,
      ),
    );
    expect([
      declared.has(fields.text),
      declared.has(fields.publisherSummary),
    ]).toEqual([true, true]);
  }
});

test("which language fills a stem field is projection content, not index identity", () => {
  // The stem field *names* are physical schema and are digested. Which
  // algorithm stems the text into them is decided per document and per
  // request, outside the manifest, so changing that mapping changes what a
  // rebuild writes and never what the generation is: the digest every
  // projection fingerprint derives from must not move, or the whole corpus
  // re-projects.
  expect(corpusIndexStemFields(CORPUS_INDEX_MANIFESTS.case_law_v6)).toEqual({
    text: "text_stem",
    publisherSummary: "headnote_stem",
  });
  expect(corpusIndexManifestDigest(CORPUS_INDEX_MANIFESTS.case_law_v6)).toBe(
    EXPECTED_DIGESTS.case_law_v6,
  );
});
