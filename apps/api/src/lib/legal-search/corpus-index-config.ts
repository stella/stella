import type { CorpusFamily } from "@/api/lib/legal-search/corpus-family";

/**
 * corpus index index configuration, generic over document family. Shared
 * core fields apply to every family; each family adds its own
 * (case_law: court/decision_date/ecli/citation_*; legislation:
 * status/effective_date/eli). Notes that matter:
 *
 * - `text` and `title` enable `fieldnorms` so BM25 scoring works
 *   (corpus index disables BM25 by default for latency).
 * - jurisdiction / document_type / source (+ status for legislation) are
 *   `tag_fields` so queries prune irrelevant splits.
 * - date fields are fast datetime for range filtering, not the
 *   timestamp_field (dates can be null; a timestamp_field must be present
 *   on every doc).
 */

type CorpusIndexFieldType =
  | "text"
  | "u64"
  | "i64"
  | "f64"
  | "bool"
  | "datetime";

type CorpusIndexFieldMapping = {
  name: string;
  type: CorpusIndexFieldType;
  tokenizer?: "raw" | "default" | "en_stem";
  record?: "basic" | "freq" | "position";
  fieldnorms?: boolean;
  fast?: boolean;
  stored?: boolean;
  input_formats?: string[];
};

export type CorpusIndexConfig = {
  version: string;
  index_id: string;
  doc_mapping: {
    mode: "lenient" | "strict" | "dynamic";
    field_mappings: CorpusIndexFieldMapping[];
    tag_fields: string[];
    store_source: boolean;
  };
  search_settings: {
    default_search_fields: string[];
  };
};

export const CORPUS_INDEX_CONFIG_VERSION = "0.8";

const DATE_INPUT_FORMATS = ["%Y-%m-%d", "rfc3339", "unix_timestamp"];

// Fields every family shares. `document_id` is the stable join key back
// to Postgres; `text`/`title` carry BM25.
const CORE_FIELDS: CorpusIndexFieldMapping[] = [
  { name: "document_id", type: "text", tokenizer: "raw", fast: true },
  { name: "jurisdiction", type: "text", tokenizer: "raw", fast: true },
  { name: "document_type", type: "text", tokenizer: "raw", fast: true },
  { name: "source", type: "text", tokenizer: "raw", fast: true },
  { name: "language", type: "text", tokenizer: "raw", fast: true },
  { name: "year", type: "u64", fast: true },
  {
    name: "title",
    type: "text",
    tokenizer: "default",
    record: "position",
    fieldnorms: true,
  },
  {
    name: "text",
    type: "text",
    tokenizer: "default",
    record: "position",
    fieldnorms: true,
  },
  // Authority ranking signal, blended in the API rerank (case law uses
  // the citation graph; other families can populate an analogous signal).
  { name: "citation_authority", type: "f64", fast: true },
  { name: "citation_count", type: "u64", fast: true },
  { name: "canonical_text_key", type: "text", tokenizer: "raw", stored: true },
  { name: "canonical_ast_key", type: "text", tokenizer: "raw", stored: true },
];

const FAMILY_FIELDS: Record<CorpusFamily, CorpusIndexFieldMapping[]> = {
  case_law: [
    { name: "court", type: "text", tokenizer: "raw", fast: true },
    {
      name: "decision_date",
      type: "datetime",
      fast: true,
      input_formats: DATE_INPUT_FORMATS,
    },
    { name: "ecli", type: "text", tokenizer: "raw" },
  ],
  legislation: [
    // current | historical | repealed
    { name: "status", type: "text", tokenizer: "raw", fast: true },
    {
      name: "effective_date",
      type: "datetime",
      fast: true,
      input_formats: DATE_INPUT_FORMATS,
    },
    // European Legislation Identifier / national statute number.
    { name: "eli", type: "text", tokenizer: "raw" },
  ],
};

const FAMILY_TAG_FIELDS: Record<CorpusFamily, string[]> = {
  case_law: ["jurisdiction", "document_type", "source"],
  legislation: ["jurisdiction", "document_type", "source", "status"],
};

export const corpusIndexConfig = (
  family: CorpusFamily,
  indexId: string,
): CorpusIndexConfig => ({
  version: CORPUS_INDEX_CONFIG_VERSION,
  index_id: indexId,
  doc_mapping: {
    mode: "lenient",
    field_mappings: [...CORE_FIELDS, ...FAMILY_FIELDS[family]],
    tag_fields: FAMILY_TAG_FIELDS[family],
    store_source: false,
  },
  search_settings: {
    default_search_fields: ["title", "text"],
  },
});

export const caseLawIndexConfig = (indexId: string): CorpusIndexConfig =>
  corpusIndexConfig("case_law", indexId);
