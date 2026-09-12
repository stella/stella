import { panic } from "better-result";

import { CASE_LAW_INDEX_GROUP_OF } from "@/api/lib/legal-search/case-law-index-groups";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import {
  CORPUS_FINAL_INDEX_CONFIG_VERSION,
  CORPUS_FINAL_INDEX_DOCSTORE_DEFAULT,
  CORPUS_FINAL_INDEX_DOCSTORE_V7,
  CORPUS_FINAL_INDEX_HEAP_SIZE_BYTES,
  CORPUS_FINAL_INDEX_MAX_PARTITIONS,
  CORPUS_FINAL_INDEX_MERGE_POLICY,
  CORPUS_FINAL_INDEX_MIN_SHARDS,
  CORPUS_FINAL_INDEX_SPLIT_NUM_DOCS_TARGET,
  CORPUS_INDEX_COMMIT_TIMEOUT_SECS,
  CORPUS_INDEX_DATE_INPUT_FORMATS,
  DECISION_TIMESTAMP_FIELD,
  FOLDED_TOKENIZER,
  PUBLISHER_KEYWORDS_FIELD,
  PUBLISHER_SUMMARY_FIELD,
  STEM_FIELD_OF,
  canonicalCorpusIndexMaturationPeriod,
  type CorpusIndexConfig,
  type CorpusIndexDocstoreSettings,
} from "@/api/lib/legal-search/corpus-index-config";
import { QUICKWIT_V09_BINARY_VERSION } from "@/api/lib/legal-search/corpus-index-engine-version";
import {
  CORPUS_INDEX_ID_MAX_LENGTH,
  isCorpusIndexJurisdiction,
} from "@/api/lib/legal-search/index-naming";

export const CORPUS_INDEX_MANIFEST_SCHEMA_VERSION = 1;

type CorpusIndexProjectionContract = {
  documentIdField: "document_id";
  projectionRevisionField: "projection_revision";
  openingField: "is_opening";
};

type CorpusIndexManifestBase = {
  schemaVersion: typeof CORPUS_INDEX_MANIFEST_SCHEMA_VERSION;
  cluster: "q09";
  engine: {
    binaryVersion: typeof QUICKWIT_V09_BINARY_VERSION;
    indexConfig: Omit<CorpusIndexConfig, "index_id">;
  };
};

type CaseLawManifestBase = CorpusIndexManifestBase & {
  family: "case_law";
  route: {
    type: "case_law_group";
    byJurisdiction: typeof CASE_LAW_INDEX_GROUP_OF;
  };
};

type CaseLawV5Manifest = CaseLawManifestBase & {
  generation: "case_law_v5";
  projection: CorpusIndexProjectionContract & {
    layout: "passage";
    builderVersion: "case-law-passages-v1";
    yearFacetField: "decision_year";
  };
};

/**
 * v5 plus the publisher summary and the stem companions of the two fields a
 * reader's words reach. A new generation rather than fields added to v5: the
 * case-law doc mapping is `strict`, so an index created without a field drops
 * every document that carries it, and the engine never diffs the mapping of an
 * index that already exists. v5 therefore keeps its exact bytes, and with them
 * its manifest digest and every projection fingerprint derived from it, while
 * v6 builds beside it.
 */
type CaseLawV6Manifest = CaseLawManifestBase & {
  generation: "case_law_v6";
  projection: CorpusIndexProjectionContract & {
    layout: "passage";
    builderVersion: "case-law-passages-v2";
    yearFacetField: "decision_year";
    publisherSummaryField: typeof PUBLISHER_SUMMARY_FIELD;
    stemFields: {
      text: (typeof STEM_FIELD_OF)["text"];
      publisherSummary: (typeof STEM_FIELD_OF)[typeof PUBLISHER_SUMMARY_FIELD];
    };
  };
};

/**
 * v6 with the publisher's classification in its own field. v6 has one field
 * for everything a publisher wrote, so a decision with no headnote carries its
 * subject-index terms there instead, and a query matching those terms scores
 * against the field that stands for a written headnote. Splitting them is a
 * mapping change, and the case-law doc mapping is `strict`, so it arrives as a
 * generation: v6 keeps its exact bytes, its digest, and every projection
 * fingerprint derived from it while v7 builds beside it.
 *
 * v7 also carries its own docstore settings and marks `document_id` and
 * `anchor_id` fast; both are fixed at index creation, so they arrive with a
 * generation.
 */
type CaseLawV7Manifest = CaseLawManifestBase & {
  generation: "case_law_v7";
  projection: CorpusIndexProjectionContract & {
    layout: "passage";
    builderVersion: "case-law-passages-v3";
    yearFacetField: "decision_year";
    publisherSummaryField: typeof PUBLISHER_SUMMARY_FIELD;
    keywordsField: typeof PUBLISHER_KEYWORDS_FIELD;
    stemFields: {
      text: (typeof STEM_FIELD_OF)["text"];
      publisherSummary: (typeof STEM_FIELD_OF)[typeof PUBLISHER_SUMMARY_FIELD];
    };
  };
};

type LegislationV2Manifest = CorpusIndexManifestBase & {
  family: "legislation";
  generation: "legislation_v2";
  projection: CorpusIndexProjectionContract & {
    layout: "document";
    builderVersion: "legislation-document-v1";
  };
  // The routing rule is fixed while the jurisdiction set is deliberately
  // open: adding a corpus creates another jurisdiction index without changing
  // the manifest. Plane decides which jurisdictions to build and when.
  route: { type: "jurisdiction" };
};

export type CorpusIndexManifest =
  | CaseLawV5Manifest
  | CaseLawV6Manifest
  | CaseLawV7Manifest
  | LegislationV2Manifest;
export type CorpusIndexManifestGeneration = CorpusIndexManifest["generation"];

type CorpusIndexFieldMapping =
  CorpusIndexConfig["doc_mapping"]["field_mappings"][number];

const rawField = (
  name: string,
  options: { stored: boolean; fast: boolean },
): CorpusIndexFieldMapping => ({
  name,
  type: "text",
  tokenizer: "raw",
  indexed: true,
  stored: options.stored,
  fast: options.fast,
  record: "basic",
  fieldnorms: false,
});

const dateField = (name: string): CorpusIndexFieldMapping => ({
  name,
  type: "datetime",
  indexed: true,
  stored: false,
  fast: true,
  input_formats: CORPUS_INDEX_DATE_INPUT_FORMATS,
  fast_precision: "seconds",
  output_format: "rfc3339",
});

/**
 * The stem companion of a full-text field, derived from that field rather than
 * restated beside it: same tokenizer, positions and fieldnorms, or a stem hit
 * would phrase-match and score on different terms than the field it stands in
 * for. Only the name and the docstore differ, because nothing reads a stem
 * back. Deriving it is what makes the two impossible to drift apart; a copied
 * literal would need a test to notice.
 */
const stemCompanionField = (
  surface: CorpusIndexFieldMapping,
  name: string,
): CorpusIndexFieldMapping => ({ ...surface, name, stored: false });

/** Mark mapped fields fast; panics on a name the mapping does not declare. */
const withFastFields = (
  fields: CorpusIndexFieldMapping[],
  names: readonly string[],
): CorpusIndexFieldMapping[] => {
  const mapped = new Set(fields.map(({ name }) => name));
  const missing = names.filter((name) => !mapped.has(name));
  if (missing.length > 0) {
    return panic(`Cannot make unmapped fields fast: ${missing.join(", ")}`);
  }
  const fast = new Set(names);
  return fields.map((field) =>
    fast.has(field.name) ? { ...field, fast: true } : field,
  );
};

const unsignedIntegerField = (name: string): CorpusIndexFieldMapping => ({
  name,
  type: "u64",
  indexed: false,
  stored: false,
  fast: true,
  coerce: true,
  output_format: "number",
});

const commonFields = (): CorpusIndexFieldMapping[] => [
  rawField("document_id", { stored: true, fast: false }),
  // Exact cleanup queries and the standing orphan-revision census need this
  // attempt identity in the columnar store. It is never returned to readers.
  rawField("projection_revision", { stored: false, fast: true }),
  rawField("jurisdiction", { stored: false, fast: true }),
  rawField("document_type", { stored: false, fast: true }),
  rawField("source", { stored: false, fast: true }),
  rawField("language", { stored: false, fast: true }),
  {
    name: "title",
    type: "text",
    tokenizer: FOLDED_TOKENIZER.name,
    record: "position",
    fieldnorms: true,
    indexed: true,
    stored: false,
    fast: false,
  },
  {
    name: "text",
    type: "text",
    tokenizer: FOLDED_TOKENIZER.name,
    record: "position",
    fieldnorms: true,
    indexed: true,
    stored: true,
    fast: false,
  },
  {
    name: "is_opening",
    type: "bool",
    indexed: true,
    stored: false,
    fast: false,
  },
];

type IndexConfigOptions = {
  fieldMappings: CorpusIndexFieldMapping[];
  tagFields: string[];
  timestampField?: string;
  /** Required per generation: the engine fixes these at index creation. */
  docstore: CorpusIndexDocstoreSettings;
  /**
   * What a bare free-text term reaches. Only a field written once per document
   * belongs here: under a passage layout a field repeated across a document's
   * passages lets one document answer a broad query with as many hits as it
   * has passages.
   */
  defaultSearchFields: string[];
};

const indexConfig = ({
  fieldMappings,
  tagFields,
  timestampField,
  docstore,
  defaultSearchFields,
}: IndexConfigOptions): Omit<CorpusIndexConfig, "index_id"> => ({
  version: CORPUS_FINAL_INDEX_CONFIG_VERSION,
  doc_mapping: {
    mode: "strict",
    field_mappings: fieldMappings,
    tokenizers: [FOLDED_TOKENIZER],
    tag_fields: tagFields,
    timestamp_field: timestampField ?? null,
    max_num_partitions: CORPUS_FINAL_INDEX_MAX_PARTITIONS,
    index_field_presence: false,
    store_document_size: false,
    store_source: false,
  },
  indexing_settings: {
    merge_policy: CORPUS_FINAL_INDEX_MERGE_POLICY,
    commit_timeout_secs: CORPUS_INDEX_COMMIT_TIMEOUT_SECS,
    docstore_blocksize: docstore.blocksize,
    docstore_compression_level: docstore.compressionLevel,
    split_num_docs_target: CORPUS_FINAL_INDEX_SPLIT_NUM_DOCS_TARGET,
    resources: { heap_size: CORPUS_FINAL_INDEX_HEAP_SIZE_BYTES },
  },
  ingest_settings: { min_shards: CORPUS_FINAL_INDEX_MIN_SHARDS },
  search_settings: { default_search_fields: defaultSearchFields },
  retention: null,
});

const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== "object") {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  Object.freeze(value);
  return value;
};

const caseLawFields = (): CorpusIndexFieldMapping[] => [
  ...commonFields(),
  {
    name: "anchor_id",
    type: "text",
    indexed: false,
    stored: true,
    fast: false,
    fieldnorms: false,
  },
  rawField("case_number", { stored: false, fast: false }),
  rawField("court", { stored: false, fast: true }),
  dateField("decision_date"),
  // Quickwit 0.9 supports only fixed, not calendar, date-histogram
  // intervals. The projection emits this exact civil year on the one
  // opening passage only, avoiding both leap-year drift and per-passage
  // fast-field duplication for browse facets.
  unsignedIntegerField("decision_year"),
  {
    ...dateField(DECISION_TIMESTAMP_FIELD),
    fast_precision: "seconds",
  },
  rawField("ecli", { stored: false, fast: false }),
];

const CASE_LAW_TAG_FIELDS = [
  "jurisdiction",
  "document_type",
  "source",
  "court",
  "language",
];

const CASE_LAW_V5_INDEX_CONFIG = deepFreeze(
  structuredClone(
    indexConfig({
      fieldMappings: caseLawFields(),
      tagFields: [...CASE_LAW_TAG_FIELDS],
      timestampField: DECISION_TIMESTAMP_FIELD,
      docstore: CORPUS_FINAL_INDEX_DOCSTORE_DEFAULT,
      defaultSearchFields: ["title", "text"],
    }),
  ),
);

const caseLawV6Fields = (): CorpusIndexFieldMapping[] => {
  const base = caseLawFields();
  const text =
    base.find((field) => field.name === "text") ??
    panic("Case-law fields no longer map `text`");
  // The summary is prose a reader quotes from, so it is mapped exactly like
  // the body text: positions for adjacency, fieldnorms for BM25. Not stored,
  // because the line a reader sees comes from Postgres; not fast, because
  // nothing filters, sorts or aggregates on it.
  const publisherSummary: CorpusIndexFieldMapping = {
    ...text,
    name: PUBLISHER_SUMMARY_FIELD,
    stored: false,
  };
  return [
    ...base,
    publisherSummary,
    stemCompanionField(text, STEM_FIELD_OF.text),
    stemCompanionField(
      publisherSummary,
      STEM_FIELD_OF[PUBLISHER_SUMMARY_FIELD],
    ),
  ];
};

const CASE_LAW_V6_INDEX_CONFIG = deepFreeze(
  structuredClone(
    indexConfig({
      fieldMappings: caseLawV6Fields(),
      tagFields: [...CASE_LAW_TAG_FIELDS],
      timestampField: DECISION_TIMESTAMP_FIELD,
      docstore: CORPUS_FINAL_INDEX_DOCSTORE_DEFAULT,
      // Unchanged from v5, and the summary is deliberately not added.
      //
      // A default search field decides what a *bare* term matches, and a hit
      // is a passage whose stored `text` is what a reader — or the research
      // answer runner — is handed as the excerpt that matched. A summary-only
      // match would return the opening passage with text that does not carry
      // the terms at all. The summary and the stem fields are therefore named
      // explicitly by the query builder, which knows it is asking for them,
      // and never reached by a term that did not ask.
      defaultSearchFields: ["title", "text"],
    }),
  ),
);

/** Fields v7 marks fast in addition to stored; both are raw-normalized ids. */
const CASE_LAW_V7_FAST_ID_FIELDS = ["document_id", "anchor_id"];

const caseLawV7Fields = (): CorpusIndexFieldMapping[] => {
  const base = withFastFields(caseLawV6Fields(), CASE_LAW_V7_FAST_ID_FIELDS);
  const headnote =
    base.find((field) => field.name === PUBLISHER_SUMMARY_FIELD) ??
    panic("Case-law fields no longer map the headnote");
  // The headnote's tokenizer and positions, so the same phrase matches the
  // same way, minus the fieldnorms: a classification is a handful of terms and
  // BM25 length normalization would let it outscore a sentence a publisher
  // wrote for the same word. Not stored and not fast for the headnote's
  // reasons: nothing reads it back, nothing filters or sorts on it.
  return [
    ...base,
    { ...headnote, name: PUBLISHER_KEYWORDS_FIELD, fieldnorms: false },
  ];
};

const CASE_LAW_V7_INDEX_CONFIG = deepFreeze(
  structuredClone(
    indexConfig({
      fieldMappings: caseLawV7Fields(),
      tagFields: [...CASE_LAW_TAG_FIELDS],
      timestampField: DECISION_TIMESTAMP_FIELD,
      docstore: CORPUS_FINAL_INDEX_DOCSTORE_V7,
      // Unchanged from v6, for the reason stated there: a hit is a passage and
      // its stored `text` is the excerpt that stands for the match, so a field
      // written to the opening passage only is named by the query builder or
      // not matched at all.
      defaultSearchFields: ["title", "text"],
    }),
  ),
);

const LEGISLATION_V2_INDEX_CONFIG = deepFreeze(
  structuredClone(
    indexConfig({
      fieldMappings: [
        ...commonFields(),
        rawField("status", { stored: false, fast: true }),
        dateField("effective_date"),
        dateField("version_valid_from"),
        dateField("version_valid_to"),
        rawField("eli", { stored: false, fast: false }),
      ],
      docstore: CORPUS_FINAL_INDEX_DOCSTORE_DEFAULT,
      tagFields: [
        "jurisdiction",
        "document_type",
        "source",
        "status",
        "language",
      ],
      defaultSearchFields: ["title", "text"],
    }),
  ),
);

export const CORPUS_INDEX_MANIFESTS = deepFreeze({
  case_law_v5: {
    schemaVersion: CORPUS_INDEX_MANIFEST_SCHEMA_VERSION,
    family: "case_law",
    generation: "case_law_v5",
    cluster: "q09",
    engine: {
      binaryVersion: QUICKWIT_V09_BINARY_VERSION,
      indexConfig: CASE_LAW_V5_INDEX_CONFIG,
    },
    projection: {
      layout: "passage",
      builderVersion: "case-law-passages-v1",
      documentIdField: "document_id",
      projectionRevisionField: "projection_revision",
      openingField: "is_opening",
      yearFacetField: "decision_year",
    },
    route: {
      type: "case_law_group",
      byJurisdiction: { ...CASE_LAW_INDEX_GROUP_OF },
    },
  },
  case_law_v6: {
    schemaVersion: CORPUS_INDEX_MANIFEST_SCHEMA_VERSION,
    family: "case_law",
    generation: "case_law_v6",
    cluster: "q09",
    engine: {
      binaryVersion: QUICKWIT_V09_BINARY_VERSION,
      indexConfig: CASE_LAW_V6_INDEX_CONFIG,
    },
    projection: {
      layout: "passage",
      builderVersion: "case-law-passages-v2",
      documentIdField: "document_id",
      projectionRevisionField: "projection_revision",
      openingField: "is_opening",
      yearFacetField: "decision_year",
      publisherSummaryField: PUBLISHER_SUMMARY_FIELD,
      stemFields: {
        text: STEM_FIELD_OF.text,
        publisherSummary: STEM_FIELD_OF[PUBLISHER_SUMMARY_FIELD],
      },
    },
    route: {
      type: "case_law_group",
      byJurisdiction: { ...CASE_LAW_INDEX_GROUP_OF },
    },
  },
  case_law_v7: {
    schemaVersion: CORPUS_INDEX_MANIFEST_SCHEMA_VERSION,
    family: "case_law",
    generation: "case_law_v7",
    cluster: "q09",
    engine: {
      binaryVersion: QUICKWIT_V09_BINARY_VERSION,
      indexConfig: CASE_LAW_V7_INDEX_CONFIG,
    },
    projection: {
      layout: "passage",
      builderVersion: "case-law-passages-v3",
      documentIdField: "document_id",
      projectionRevisionField: "projection_revision",
      openingField: "is_opening",
      yearFacetField: "decision_year",
      publisherSummaryField: PUBLISHER_SUMMARY_FIELD,
      keywordsField: PUBLISHER_KEYWORDS_FIELD,
      stemFields: {
        text: STEM_FIELD_OF.text,
        publisherSummary: STEM_FIELD_OF[PUBLISHER_SUMMARY_FIELD],
      },
    },
    route: {
      type: "case_law_group",
      byJurisdiction: { ...CASE_LAW_INDEX_GROUP_OF },
    },
  },
  legislation_v2: {
    schemaVersion: CORPUS_INDEX_MANIFEST_SCHEMA_VERSION,
    family: "legislation",
    generation: "legislation_v2",
    cluster: "q09",
    engine: {
      binaryVersion: QUICKWIT_V09_BINARY_VERSION,
      indexConfig: LEGISLATION_V2_INDEX_CONFIG,
    },
    projection: {
      layout: "document",
      builderVersion: "legislation-document-v1",
      documentIdField: "document_id",
      projectionRevisionField: "projection_revision",
      openingField: "is_opening",
    },
    route: { type: "jurisdiction" },
  },
} as const satisfies Record<
  CorpusIndexManifestGeneration,
  CorpusIndexManifest
>);

export const requireCorpusIndexManifest = (
  family: CorpusFamily,
  generation: string,
): CorpusIndexManifest => {
  switch (family) {
    case "case_law":
      switch (generation) {
        case "case_law_v5":
          return CORPUS_INDEX_MANIFESTS.case_law_v5;
        case "case_law_v6":
          return CORPUS_INDEX_MANIFESTS.case_law_v6;
        case "case_law_v7":
          return CORPUS_INDEX_MANIFESTS.case_law_v7;
        default:
          return panic(`Unknown case-law index manifest: ${generation}`);
      }
    case "legislation":
      return generation === "legislation_v2"
        ? CORPUS_INDEX_MANIFESTS.legislation_v2
        : panic(`Unknown legislation index manifest: ${generation}`);
    default:
      return panic("Unknown corpus index manifest family");
  }
};

/**
 * How a generation's indexes hold what a publisher wrote, as the three shapes
 * that exist rather than as a field name plus a convention:
 *
 * - `none`: the generation mapped neither field. Nothing publisher-authored is
 *   written, because writing a field into a `strict` index that does not map
 *   it drops the whole document, and the engine reports that as a successful
 *   ingest.
 * - `summary`: one field for everything a publisher wrote. A decision with no
 *   headnote carries its classification there, which is the reading the
 *   generation was built with and may not change under it.
 * - `summary_and_keywords`: a field each. The headnote holds sentences and
 *   nothing else; the classification has somewhere of its own to go.
 *
 * Total over every generation, so a new one answers rather than inherits, and
 * the kind is what the writer, the fingerprint and the reader all branch on.
 */
export type CorpusIndexPublisherFields =
  | { kind: "none" }
  | { kind: "summary"; summaryField: typeof PUBLISHER_SUMMARY_FIELD }
  | {
      kind: "summary_and_keywords";
      summaryField: typeof PUBLISHER_SUMMARY_FIELD;
      keywordsField: typeof PUBLISHER_KEYWORDS_FIELD;
    };

export const corpusIndexPublisherFields = (
  manifest: CorpusIndexManifest,
): CorpusIndexPublisherFields => {
  switch (manifest.generation) {
    case "case_law_v5":
      return { kind: "none" };
    case "case_law_v6":
      return {
        kind: "summary",
        summaryField: manifest.projection.publisherSummaryField,
      };
    case "case_law_v7":
      return {
        kind: "summary_and_keywords",
        summaryField: manifest.projection.publisherSummaryField,
        keywordsField: manifest.projection.keywordsField,
      };
    case "legislation_v2":
      return { kind: "none" };
    default:
      manifest satisfies never;
      return panic(`Unhandled manifest: ${String(manifest)}`);
  }
};

/**
 * The fields a generation's mapping marks fast, read off that mapping rather
 * than off the generation name. Only a fast field has a columnar store, which
 * is what an aggregation reads; a reader asking whether it may aggregate over
 * a field asks this.
 */
export const corpusIndexFastFields = (
  manifest: CorpusIndexManifest,
): ReadonlySet<string> =>
  new Set(
    manifest.engine.indexConfig.doc_mapping.field_mappings
      .filter((field) => field.fast)
      .map((field) => field.name),
  );

export type CorpusIndexStemFields = {
  text: (typeof STEM_FIELD_OF)["text"];
  publisherSummary: (typeof STEM_FIELD_OF)[typeof PUBLISHER_SUMMARY_FIELD];
};

/**
 * The stem companions a generation maps, or null. Total for the same reason:
 * the writer must not emit a field the generation's mapping lacks, and the
 * query builder must not name one, since a `strict` index rejects a clause
 * over a field it never declared.
 */
export const corpusIndexStemFields = (
  manifest: CorpusIndexManifest,
): CorpusIndexStemFields | null => {
  switch (manifest.generation) {
    case "case_law_v5":
      return null;
    case "case_law_v6":
    case "case_law_v7":
      return manifest.projection.stemFields;
    case "legislation_v2":
      return null;
    default:
      manifest satisfies never;
      return panic(`Unhandled manifest: ${String(manifest)}`);
  }
};

const compareCanonicalJsonKeys = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const canonicalJson = (value: unknown): string => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? JSON.stringify(value)
      : panic("Canonical JSON forbids non-finite numbers");
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value !== "object") {
    return panic(`Canonical JSON forbids ${typeof value}`);
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return panic("Canonical JSON accepts plain objects only");
  }
  const entries = Object.entries(value).sort(([left], [right]) =>
    compareCanonicalJsonKeys(left, right),
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
};

export const corpusIndexContractDigest = (value: unknown): string =>
  new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex");

const manifestDigestByIdentity = new WeakMap<CorpusIndexManifest, string>();

export const corpusIndexManifestDigest = (
  manifest: CorpusIndexManifest,
): string => {
  const cachedDigest = manifestDigestByIdentity.get(manifest);
  if (cachedDigest !== undefined) {
    return cachedDigest;
  }
  const digest = corpusIndexContractDigest(manifest);
  manifestDigestByIdentity.set(manifest, digest);
  return digest;
};

export const corpusIndexConfigFromManifest = (
  manifest: CorpusIndexManifest,
  indexId: string,
): CorpusIndexConfig => {
  const config = structuredClone(manifest.engine.indexConfig);
  return {
    ...config,
    index_id: indexId,
    indexing_settings: {
      ...config.indexing_settings,
      merge_policy: {
        ...config.indexing_settings.merge_policy,
        maturation_period: canonicalCorpusIndexMaturationPeriod(
          config.indexing_settings.merge_policy.maturation_period,
        ),
      },
    },
  };
};

/**
 * Resolve a canonical jurisdiction through the immutable generation route.
 * Case-law topology is closed over the manifest; a new court corpus requires
 * an explicit manifest decision. Legislation keeps the deliberate one-index-
 * per-jurisdiction rule and therefore accepts any valid jurisdiction code.
 */
export const corpusIndexIdFromManifest = (
  manifest: CorpusIndexManifest,
  jurisdiction: string,
): string => {
  const canonical = jurisdiction.toUpperCase();
  if (!isCorpusIndexJurisdiction(canonical)) {
    return panic(`Invalid corpus jurisdiction: ${jurisdiction}`);
  }

  let suffix: string;
  switch (manifest.route.type) {
    case "case_law_group": {
      const route = Object.entries(manifest.route.byJurisdiction).find(
        ([candidate]) => candidate === canonical,
      );
      suffix =
        route?.at(1) ?? panic(`Unrouted case-law jurisdiction: ${canonical}`);
      break;
    }
    case "jurisdiction":
      suffix = canonical.toLowerCase();
      break;
    default:
      manifest.route satisfies never;
      return panic(`Unhandled route: ${String(manifest.route)}`);
  }

  const indexId = `${manifest.generation}_${suffix}`;
  return indexId.length <= CORPUS_INDEX_ID_MAX_LENGTH
    ? indexId
    : panic(`Corpus index id exceeds storage limit: ${indexId}`);
};

/**
 * Assert that a physical index id is one route of this immutable manifest.
 * Callers must not accept an arbitrary generation-prefixed string: grouped
 * case-law routes are closed, while legislation routes are the manifest's
 * canonical jurisdiction spelling.
 */
export const requireCorpusIndexIdForManifest = (
  manifest: CorpusIndexManifest,
  indexId: string,
): string => {
  switch (manifest.route.type) {
    case "case_law_group": {
      const matches = Object.values(manifest.route.byJurisdiction).some(
        (suffix) => `${manifest.generation}_${suffix}` === indexId,
      );
      return matches
        ? indexId
        : panic(
            `Corpus index id is not a manifest route: ${manifest.generation}/${indexId}`,
          );
    }
    case "jurisdiction": {
      const prefix = `${manifest.generation}_`;
      const jurisdiction = indexId.startsWith(prefix)
        ? indexId.slice(prefix.length)
        : "";
      return jurisdiction !== "" &&
        corpusIndexIdFromManifest(manifest, jurisdiction) === indexId
        ? indexId
        : panic(
            `Corpus index id is not a manifest route: ${manifest.generation}/${indexId}`,
          );
    }
    default:
      manifest.route satisfies never;
      return panic(`Unhandled route: ${String(manifest.route)}`);
  }
};
