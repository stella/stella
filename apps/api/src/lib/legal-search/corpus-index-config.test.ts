import { expect, test } from "bun:test";

import {
  caseLawIndexConfig,
  corpusIndexConfig,
} from "@/api/lib/legal-search/corpus-index-config";

test("searchable text fields enable fieldnorms so BM25 scoring works", () => {
  const fields = new Map(
    caseLawIndexConfig("case_law_v1").doc_mapping.field_mappings.map((f) => [
      f.name,
      f,
    ]),
  );
  expect(fields.get("text")?.fieldnorms).toBe(true);
  expect(fields.get("title")?.fieldnorms).toBe(true);
});

test("jurisdiction/document_type/source are tag fields for split pruning", () => {
  expect(caseLawIndexConfig("case_law_v1").doc_mapping.tag_fields).toEqual([
    "jurisdiction",
    "document_type",
    "source",
  ]);
});

test("index_id is the generation; citation_authority is a fast f64", () => {
  const config = caseLawIndexConfig("case_law_v2");
  expect(config.index_id).toBe("case_law_v2");
  const authority = config.doc_mapping.field_mappings.find(
    (f) => f.name === "citation_authority",
  );
  expect(authority?.type).toBe("f64");
  expect(authority?.fast).toBe(true);
});

test("default search fields are title + text", () => {
  expect(
    caseLawIndexConfig("case_law_v1").search_settings.default_search_fields,
  ).toEqual(["title", "text"]);
});

test("no field repeated across a document's passages is free-text searchable", () => {
  const config = caseLawIndexConfig("case_law_v2");
  const defaults = new Set(config.search_settings.default_search_fields);

  // `heading_path` is written to every passage of a section, so a term
  // matching a boilerplate heading would return the whole section at once and
  // exhaust the capped scan window. It stays mapped and explicitly targetable.
  expect(defaults.has("heading_path")).toBe(false);
  expect(
    config.doc_mapping.field_mappings.find((f) => f.name === "heading_path")
      ?.tokenizer,
  ).toBe("folded");

  // Anything else a default search field reaches must be per-passage content
  // (`text`) or written once per document (`title`).
  expect([...defaults].sort()).toEqual(["text", "title"]);
});

test("passage fields are mapped for every family, heading_path searchable", () => {
  for (const family of ["case_law", "legislation"] as const) {
    const fields = new Map(
      corpusIndexConfig(
        family,
        `${family}_v2_svk`,
      ).doc_mapping.field_mappings.map((f) => [f.name, f]),
    );
    // A passage hit must be able to name its document, its position, and the
    // anchor the reader deep-links to.
    expect(fields.get("chunk_id")?.tokenizer).toBe("raw");
    expect(fields.get("anchor_id")?.tokenizer).toBe("raw");
    expect(fields.get("seq")?.type).toBe("u64");
    // Section context is scored, not just stored.
    expect(fields.get("heading_path")?.fieldnorms).toBe(true);
  }
});

// The engine never diffs an existing index's doc mapping, so a change here
// only reaches documents indexed into a fresh generation. Pinning the exact
// block keeps the shape a reviewer sees identical to the shape the engine is
// asked to create.
test("the doc mapping declares the folded tokenizer verbatim", () => {
  for (const family of ["case_law", "legislation"] as const) {
    expect(
      corpusIndexConfig(family, `${family}_v3_cze`).doc_mapping.tokenizers,
    ).toEqual([
      {
        name: "folded",
        type: "simple",
        filters: ["lower_caser", "ascii_folding", "remove_long"],
      },
    ]);
  }
});

// Declared tokenizers and used tokenizers must match in both directions: a
// field naming an undeclared tokenizer is rejected by the engine at index
// creation, and a declared tokenizer nothing uses is dead config.
test("every full-text field uses a declared tokenizer, and every declared one is used", () => {
  const BUILT_IN_TOKENIZERS = new Set(["raw", "default", "en_stem"]);

  for (const family of ["case_law", "legislation"] as const) {
    const config = corpusIndexConfig(family, `${family}_v3_cze`);
    const declared = new Set(config.doc_mapping.tokenizers.map((t) => t.name));
    const used = new Set(
      config.doc_mapping.field_mappings
        .map((f) => f.tokenizer)
        .filter((name) => name !== undefined)
        .filter((name) => !BUILT_IN_TOKENIZERS.has(name)),
    );
    expect([...declared].sort()).toEqual([...used].sort());

    // Position-recorded fields are exactly the free-text surface; every one of
    // them folds, so a query typed without diacritics reaches text carrying
    // them. A new full-text field added with `default` trips this.
    const fullText = config.doc_mapping.field_mappings.filter(
      (f) => f.record === "position",
    );
    expect(fullText.map((f) => f.name).sort()).toEqual([
      "heading_path",
      "text",
      "title",
    ]);
    for (const field of fullText) {
      expect(field.tokenizer).toBe("folded");
    }
  }
});

test("the legislation family gets its own fields + status tag, sharing the core", () => {
  const config = corpusIndexConfig("legislation", "legislation_v1_svk");
  const names = new Set(config.doc_mapping.field_mappings.map((f) => f.name));
  // family-specific
  expect(names.has("status")).toBe(true);
  expect(names.has("effective_date")).toBe(true);
  expect(names.has("eli")).toBe(true);
  // shared core still present, case-law-only fields absent
  expect(names.has("text")).toBe(true);
  expect(names.has("document_id")).toBe(true);
  expect(names.has("court")).toBe(false);
  expect(names.has("decision_date")).toBe(false);
  // status joins the tag fields for split pruning
  expect(config.doc_mapping.tag_fields).toContain("status");
});
