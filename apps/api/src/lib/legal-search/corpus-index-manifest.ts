import { panic } from "better-result";

import { CASE_LAW_INDEX_GROUP_OF } from "@/api/lib/legal-search/case-law-index-groups";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import {
  CORPUS_FINAL_INDEX_CONFIG_VERSION,
  CORPUS_FINAL_INDEX_DOCSTORE_BLOCKSIZE,
  CORPUS_FINAL_INDEX_DOCSTORE_COMPRESSION_LEVEL,
  CORPUS_FINAL_INDEX_HEAP_SIZE_BYTES,
  CORPUS_FINAL_INDEX_MAX_PARTITIONS,
  CORPUS_FINAL_INDEX_MERGE_POLICY,
  CORPUS_FINAL_INDEX_MIN_SHARDS,
  CORPUS_FINAL_INDEX_SPLIT_NUM_DOCS_TARGET,
  CORPUS_INDEX_COMMIT_TIMEOUT_SECS,
  CORPUS_INDEX_DATE_INPUT_FORMATS,
  DECISION_TIMESTAMP_FIELD,
  FOLDED_TOKENIZER,
  PUBLISHER_SUMMARY_FIELD,
  canonicalCorpusIndexMaturationPeriod,
  type CorpusIndexConfig,
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
 * v5 plus the publisher summary, as its own searchable field on the opening
 * passage. A new generation rather than a field added to v5: the case-law doc
 * mapping is `strict`, so an index created without the field drops every
 * document that carries it, and the engine never diffs the mapping of an
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
    docstore_blocksize: CORPUS_FINAL_INDEX_DOCSTORE_BLOCKSIZE,
    docstore_compression_level: CORPUS_FINAL_INDEX_DOCSTORE_COMPRESSION_LEVEL,
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
      defaultSearchFields: ["title", "text"],
    }),
  ),
);

const CASE_LAW_V6_INDEX_CONFIG = deepFreeze(
  structuredClone(
    indexConfig({
      fieldMappings: [
        ...caseLawFields(),
        // Positions and fieldnorms because the summary is prose a reader
        // quotes from: a phrase has to match adjacently, and BM25 has to see
        // how long the line is. Not stored, because the line a reader sees
        // comes from Postgres; not fast, because nothing filters, sorts or
        // aggregates on it.
        {
          name: PUBLISHER_SUMMARY_FIELD,
          type: "text",
          tokenizer: FOLDED_TOKENIZER.name,
          record: "position",
          fieldnorms: true,
          indexed: true,
          stored: false,
          fast: false,
        },
      ],
      tagFields: [...CASE_LAW_TAG_FIELDS],
      timestampField: DECISION_TIMESTAMP_FIELD,
      // Safe to widen here and nowhere else: the summary is written to the
      // opening passage only, so a free-text term reaching it answers once per
      // document, exactly as `title` does. A generation's search settings are
      // fixed when its indexes are created, so v5 keeps searching two fields.
      defaultSearchFields: ["title", "text", PUBLISHER_SUMMARY_FIELD],
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
 * The index field a generation carries the publisher summary in, or null for
 * a generation whose indexes never mapped one. Total over every generation, so
 * a new one has to answer rather than inherit: writing the field into a
 * `strict` index that does not map it drops the whole document, and the engine
 * reports that as a successful ingest.
 */
export const corpusIndexPublisherSummaryField = (
  manifest: CorpusIndexManifest,
): typeof PUBLISHER_SUMMARY_FIELD | null => {
  switch (manifest.generation) {
    case "case_law_v5":
      return null;
    case "case_law_v6":
      return manifest.projection.publisherSummaryField;
    case "legislation_v2":
      return null;
    default:
      return manifest satisfies never;
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
      return manifest.route satisfies never;
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
      return manifest.route satisfies never;
  }
};
