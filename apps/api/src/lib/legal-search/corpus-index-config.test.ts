import { expect, test } from "bun:test";

import { CASE_LAW_INDEX_GROUPS } from "@/api/lib/legal-search/case-law-index-groups";
import {
  caseLawIndexConfig,
  corpusIndexConfig,
  DECISION_TIMESTAMP_FIELD,
  TAG_FIELD_VALUE_LIMIT,
} from "@/api/lib/legal-search/corpus-index-config";
import {
  CASE_LAW_JURISDICTIONS,
  type CaseLawJurisdiction,
} from "@/api/lib/legal-search/ingestion-constants";

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

test("case-law tag fields are the filters a query prunes splits by", () => {
  expect(caseLawIndexConfig("case_law_v1").doc_mapping.tag_fields).toEqual([
    "jurisdiction",
    "document_type",
    "source",
    "court",
    "language",
  ]);
});

// The engine never diffs an existing index, so a mode change reaches documents
// only through a generation created from this config; an existing generation
// keeps the mode it was made with.
//
// `strict` costs the whole document when a field is undeclared, and says so
// only in the engine's log, so a family may only take it where something
// counts the documents that should be there. Case law has the rebuild census;
// legislation does not, and stays lenient until it does.
test("only a family with a census maps in strict mode", () => {
  expect(caseLawIndexConfig("case_law_v3_cze").doc_mapping.mode).toBe("strict");
  expect(
    corpusIndexConfig("legislation", "legislation_v2_svk").doc_mapping.mode,
  ).toBe("lenient");
});

test("the docket is its own raw field, reachable only by an exact query", () => {
  const config = caseLawIndexConfig("case_law_v3_cze");
  const caseNumber = config.doc_mapping.field_mappings.find(
    (field) => field.name === "case_number",
  );
  expect(caseNumber).toEqual({
    name: "case_number",
    type: "text",
    tokenizer: "raw",
    indexed: true,
    stored: true,
    fast: false,
  });
  // Raw and not a default search field: a docket answers `case_number:"..."`,
  // and no free-text term reaches it. It repeats across a decision's passages,
  // which is the fan-out rule that keeps it out of the default fields.
  expect(config.search_settings.default_search_fields).not.toContain(
    "case_number",
  );
  // Case law only: legislation identifies a document by ELI.
  expect(
    corpusIndexConfig(
      "legislation",
      "legislation_v2_svk",
    ).doc_mapping.field_mappings.some((field) => field.name === "case_number"),
  ).toBe(false);
});

/**
 * The courts one jurisdiction's index may name, declared per jurisdiction
 * against the court system its sources draw from. Upper bounds rather than
 * observed counts: the corpus grows toward its sources, and what a tag field
 * has to survive is what the domain can hold, not what it holds today.
 *
 * This is the decision, not the measurement. The other side is a court
 * registry in a foreign jurisdiction, which nothing here can bind at compile
 * time, so the value of the table is that the bound is written down per
 * jurisdiction and cannot be inherited silently by the next one. Observing the
 * live distinct-value count belongs to the generation that carries the tag,
 * where it can be read off the index itself.
 *
 * - AUT: RIS publishes for OGH, VwGH and VfGH, 4 Oberlandesgerichte, the
 *   Landesgerichte, and the Bezirksgerichte.
 * - CZE: Ústavní soud, NS, NSS, 2 vrchní, 8 krajské (Městský soud v Praze
 *   among them), and the okresní courts.
 * - EU: Court of Justice, General Court, and the dissolved Civil Service
 *   Tribunal.
 * - POL: the SAOS `commonCourts` registry the adapter takes court names from
 *   enumerates 374 (318 rejonowy, 45 okręgowy, 11 apelacyjny), plus Sąd
 *   Najwyższy, NSA, Trybunał Konstytucyjny and the voivodeship
 *   administrative courts.
 * - SVK: Ústavný súd, NS, NSS, the krajské courts, and the okresné courts.
 */
const COURT_DOMAIN_BOUND = {
  AUT: 200,
  CZE: 200,
  EU: 10,
  POL: 400,
  SVK: 200,
} as const satisfies Record<CaseLawJurisdiction, number>;

// A tag field whose values outgrow the engine's per-split limit stops being
// recorded, and the only symptom is that every query opens every split. Court
// is the one tag field whose domain is neither a short closed list
// (document_type, status) nor an operator-curated catalogue (source,
// jurisdiction), so it is the one that has to be argued.
test("court stays a viable tag field in every index", () => {
  // Indexes are per generation and jurisdiction up to generation 2, and per
  // index group from generation 3 on, so a split holds the courts of one
  // group's countries. A bound at half the limit leaves room for court
  // renames and reorganizations, which add values without retiring the old
  // ones. Summing per group is what makes adding a country to a group a
  // decision about the group's court domain rather than a silent inheritance.
  for (const bound of Object.values(COURT_DOMAIN_BOUND)) {
    expect(bound).toBeLessThan(TAG_FIELD_VALUE_LIMIT / 2);
  }
  // Group members are declared jurisdictions, so every member has a bound.
  for (const [group, countries] of CASE_LAW_INDEX_GROUPS) {
    const groupBound = countries.reduce(
      (total, country) => total + COURT_DOMAIN_BOUND[country],
      0,
    );
    expect([group, groupBound < TAG_FIELD_VALUE_LIMIT / 2]).toEqual([
      group,
      true,
    ]);
  }

  // Total over the jurisdictions the corpus ships, so onboarding one is a
  // decision about its court registry rather than a silent inheritance.
  expect(Object.keys(COURT_DOMAIN_BOUND).sort()).toEqual([
    ...CASE_LAW_JURISDICTIONS,
  ]);
  expect(
    caseLawIndexConfig("case_law_v3_pol").doc_mapping.tag_fields,
  ).toContain("court");
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

test("case-law indexes do not persist canonical storage locations", () => {
  const names = caseLawIndexConfig(
    "case_law_v4_cze",
  ).doc_mapping.field_mappings.map(({ name }) => name);
  expect(names.filter((name) => name.startsWith("canonical_"))).toEqual([]);
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

// Same reason the tokenizer block is pinned: the engine never diffs an
// existing index, so this shape is only ever read at creation time, and the
// block a reviewer sees is the block the engine is asked to accept.
test("the merge policy is declared whole, verbatim", () => {
  for (const family of ["case_law", "legislation"] as const) {
    expect(
      corpusIndexConfig(family, `${family}_v3_cze`).indexing_settings,
    ).toEqual({
      merge_policy: {
        type: "stable_log",
        maturation_period: "7days",
        merge_factor: 10,
        max_merge_factor: 12,
        min_level_num_docs: 100_000,
      },
    });
  }
});

test("case law names decision_date_ts as its timestamp field, mapped verbatim", () => {
  const config = caseLawIndexConfig("case_law_v3_cze");
  expect(config.doc_mapping.timestamp_field).toBe(DECISION_TIMESTAMP_FIELD);
  expect(
    config.doc_mapping.field_mappings.find(
      (f) => f.name === DECISION_TIMESTAMP_FIELD,
    ),
  ).toEqual({
    name: "decision_date_ts",
    type: "datetime",
    indexed: true,
    stored: true,
    fast: true,
    fast_precision: "seconds",
    input_formats: ["%Y-%m-%d", "rfc3339", "unix_timestamp"],
  });

  // The field it stands in for keeps its own mapping: nullable, so it is
  // absent from an undated decision's document, and never the timestamp field.
  const decisionDate = config.doc_mapping.field_mappings.find(
    (f) => f.name === "decision_date",
  );
  expect(decisionDate?.type).toBe("datetime");
  expect(decisionDate?.fast).toBe(true);
});

// The engine rejects an index whose timestamp field it cannot find in the doc
// mapping, and rejects a document that omits the field. A family therefore
// either maps a field every one of its documents carries, or declares none.
test("a declared timestamp field is a mapped fast datetime; a family without one declares none", () => {
  const declared = new Map(
    (["case_law", "legislation"] as const).map((family) => [
      family,
      corpusIndexConfig(family, `${family}_v3_cze`).doc_mapping,
    ]),
  );

  expect(declared.get("legislation")?.timestamp_field).toBeUndefined();

  for (const mapping of declared.values()) {
    const { timestamp_field: timestampField } = mapping;
    if (timestampField === undefined) {
      continue;
    }
    const field = mapping.field_mappings.find((f) => f.name === timestampField);
    expect(field?.type).toBe("datetime");
    expect(field?.fast).toBe(true);
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

// The point-in-time question — which consolidation was in force on date D — is
// answered off these two fields, so they are fast: the engine evaluates the
// window during the scan instead of the API re-deriving it per hit. Both stay
// out of `tag_fields`, whose values a split records: a date's domain is
// unbounded, and a tag field past the engine's per-split limit stops being
// recorded, costing pruning everywhere.
test("the legislation validity window is a pair of fast datetimes", () => {
  const config = corpusIndexConfig("legislation", "legislation_v1_svk");
  const window = ["version_valid_from", "version_valid_to"] as const;

  for (const name of window) {
    expect(
      config.doc_mapping.field_mappings.find((f) => f.name === name),
    ).toEqual({
      name,
      type: "datetime",
      indexed: true,
      stored: true,
      fast: true,
      input_formats: ["%Y-%m-%d", "rfc3339", "unix_timestamp"],
    });
    expect(config.doc_mapping.tag_fields).not.toContain(name);
  }

  // Nullable on both ends, and neither is the timestamp field: a source that
  // publishes no window still has to be indexed, and an open-ended
  // `version_valid_to` is how the current consolidation says it has no end.
  expect(config.doc_mapping.timestamp_field).toBeUndefined();
});
