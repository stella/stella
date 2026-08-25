import type { CorpusFamily } from "@/api/lib/legal-search/corpus-family";

/**
 * corpus index index configuration, generic over document family. Shared
 * core fields apply to every family; each family adds its own
 * (case_law: court/decision_date/ecli/citation_*; legislation:
 * status/effective_date/version_valid_from/version_valid_to/eli). Notes that
 * matter:
 *
 * - `text` and `title` enable `fieldnorms` so BM25 scoring works
 *   (corpus index disables BM25 by default for latency).
 * - full-text fields use the custom `folded` tokenizer so a query typed
 *   without diacritics reaches text that carries them.
 * - jurisdiction / document_type / source (+ court for case law, status for
 *   legislation) are `tag_fields` so queries prune irrelevant splits.
 * - a family's own date field stays nullable, fast, and range-filterable, and
 *   is never the timestamp_field. Case law carries a second, always-present
 *   `decision_date_ts` for that role.
 */

type CorpusIndexFieldType =
  | "text"
  | "u64"
  | "i64"
  | "f64"
  | "bool"
  | "datetime";

type CorpusIndexTokenizer = {
  name: string;
  type: "simple" | "raw" | "regex";
  filters: readonly string[];
};

/**
 * The tokenizer every full-text field uses. `ascii_folding` is the reason it
 * exists: the corpus is written with diacritics, and a query typed without
 * them ("skody") has to reach the text that carries them ("škody"). The filter
 * runs over both the indexed terms and the query terms, so the match is
 * symmetric and neither side has to be normalized by hand. `remove_long`
 * discards tokens past the default byte limit, keeping OCR runs out of the
 * term dictionary; `lower_caser` is what `default` already did.
 */
export const FOLDED_TOKENIZER = {
  name: "folded",
  type: "simple",
  filters: ["lower_caser", "ascii_folding", "remove_long"],
} as const satisfies CorpusIndexTokenizer;

const CUSTOM_TOKENIZERS = [FOLDED_TOKENIZER] as const;

type CorpusIndexFieldMapping = {
  name: string;
  type: CorpusIndexFieldType;
  // Built-in names plus whatever `CUSTOM_TOKENIZERS` declares, so a field can
  // never name a tokenizer the doc mapping does not ship.
  tokenizer?:
    | "raw"
    | "default"
    | "en_stem"
    | (typeof CUSTOM_TOKENIZERS)[number]["name"];
  record?: "basic" | "freq" | "position";
  fieldnorms?: boolean;
  fast?: boolean;
  /** Fast-field resolution for a datetime; coarser truncates harder. */
  fast_precision?: "seconds" | "milliseconds" | "microseconds" | "nanoseconds";
  stored?: boolean;
  input_formats?: string[];
};

/**
 * Split merging. The engine's default `stable_log` policy matures a split
 * after one day, and a matured split is never merged again: a backfill that
 * writes for longer than that leaves its early splits frozen small and
 * numerous. That is a query-time cost, not a storage one — a cold query pays
 * one object-store round trip per split it cannot prune, so split count
 * multiplies cold latency for as long as the generation lives.
 *
 * The period is therefore set past the length of a full-corpus backfill, so
 * splits written during one still consolidate before they mature. The rest are
 * the engine's defaults, restated: a merge policy declared by halves is harder
 * to reason about than one declared whole.
 */
const MERGE_POLICY = {
  type: "stable_log",
  maturation_period: "7days",
  merge_factor: 10,
  max_merge_factor: 12,
  min_level_num_docs: 100_000,
} as const;

type CorpusIndexDocMappingMode = "lenient" | "strict" | "dynamic";

export type CorpusIndexConfig = {
  version: string;
  index_id: string;
  doc_mapping: {
    mode: CorpusIndexDocMappingMode;
    field_mappings: CorpusIndexFieldMapping[];
    tokenizers: readonly CorpusIndexTokenizer[];
    tag_fields: string[];
    /**
     * Present only for a family that maps an always-present datetime. The
     * engine stores its min/max per split and prunes on it, and it is what
     * `start_timestamp` / `end_timestamp` search parameters address.
     */
    timestamp_field?: string;
    store_source: boolean;
  };
  indexing_settings: {
    merge_policy: typeof MERGE_POLICY;
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
  // Searchable, and therefore fan-out sensitive. Under a passage layout a
  // document-level field copied onto every passage lets one document answer a
  // broad query with as many hits as it has passages, crowding every other
  // document out of the capped scan window. `title` is the only field here a
  // free-text term can reach (everything else document-level is raw-tokenized
  // or numeric), so a passage family sets it on the document's opening passage
  // only — one hit per document, as before. Any future searchable
  // document-level field has to make the same choice.
  {
    name: "title",
    type: "text",
    tokenizer: FOLDED_TOKENIZER.name,
    record: "position",
    fieldnorms: true,
  },
  {
    name: "text",
    type: "text",
    tokenizer: FOLDED_TOKENIZER.name,
    record: "position",
    fieldnorms: true,
  },
  // Authority ranking signal, blended in the API rerank (case law uses
  // the citation graph; other families can populate an analogous signal).
  { name: "citation_authority", type: "f64", fast: true },
  { name: "citation_count", type: "u64", fast: true },
  // Canonical object locations deliberately stay out of the search index.
  // Packing may repoint them without changing the document's content, while
  // every search read rehydrates the authoritative row from Postgres.
  // Passage fields. A passage-granular family emits one document per passage,
  // all sharing `document_id`; a document-granular family simply never sets
  // them and, in lenient mode, the index carries them empty. The read path is
  // written against the union of both layouts (see corpus-index-pagination),
  // so a generation built either way serves the same API.
  //
  // `<document_id>:<seq>`. A deterministic, greppable identity for one
  // passage; not a primary key — the engine appends and replaces by
  // delete-by-query on `document_id`.
  { name: "chunk_id", type: "text", tokenizer: "raw", stored: true },
  { name: "seq", type: "u64", fast: true, stored: true },
  // The AST block anchor the reader deep-links to, so a hit can open the
  // document scrolled to the passage that matched.
  { name: "anchor_id", type: "text", tokenizer: "raw", stored: true },
  // Heading ancestry of the passage's section. Tokenized so a query can target
  // it explicitly (`heading_path:...`), but deliberately NOT a default search
  // field: it repeats on every continuation passage of a section, so a
  // free-text term matching a boilerplate heading ("Odůvodnění", "Facts")
  // would match all of them at once. Nothing is lost by leaving it out — a
  // heading opens the passage carrying its section, so its words are already
  // in that passage's `text`, and matching there yields one hit per section
  // instead of one per passage.
  {
    name: "heading_path",
    type: "text",
    tokenizer: FOLDED_TOKENIZER.name,
    record: "position",
    fieldnorms: true,
    stored: true,
  },
];

/**
 * The timestamp field for case law, and the reason `decision_date` cannot be
 * it: a decision whose date the source never published still has to be
 * indexed, and the engine requires the timestamp field on every document it
 * accepts. `decision_date` therefore stays nullable and keeps answering for
 * display and range filters, while this field is written unconditionally,
 * standing in for the missing date with `UNDATED_DECISION_TIMESTAMP`.
 *
 * Seconds precision because the source data is a calendar date. A finer fast
 * field would spend bits encoding zeros.
 */
export const DECISION_TIMESTAMP_FIELD = "decision_date_ts";

/**
 * What `decision_date_ts` carries when the decision has no published date.
 *
 * Far enough before any decision the corpus can hold that it cannot collide
 * with a real one, and readable as what it is in a raw document. A timestamp
 * range query therefore never returns an undated decision unless it asks for a
 * window this old, which is the property that matters: the field decides what
 * a date filter matches.
 *
 * A split's timestamp range spans everything written into it, so pruning is
 * tight only where the walk that filled the split was ordered by date. The
 * generation walk is (see the case-law rebuild's cursor), and it puts undated
 * decisions in their own band, at this value.
 */
export const UNDATED_DECISION_TIMESTAMP = "1800-01-01";

const FAMILY_FIELDS: Record<CorpusFamily, CorpusIndexFieldMapping[]> = {
  case_law: [
    // The docket, exactly as the court wrote it. Raw-tokenized, so it answers
    // an exact lookup and no free-text term reaches it; it repeats on every
    // passage, which is what makes an exact lookup return the whole decision
    // rather than one passage of it. Until now the number reached the index
    // only inside `title`, where it is folded and tokenized with everything
    // else on that line.
    //
    // Nothing queries it yet, and nothing can before the generation that maps
    // it exists: the query layer builds its filters explicitly and strips
    // engine field syntax out of free text, so a docket filter is added there
    // with, or after, the flip.
    { name: "case_number", type: "text", tokenizer: "raw" },
    { name: "court", type: "text", tokenizer: "raw", fast: true },
    {
      name: "decision_date",
      type: "datetime",
      fast: true,
      input_formats: DATE_INPUT_FORMATS,
    },
    {
      name: DECISION_TIMESTAMP_FIELD,
      type: "datetime",
      fast: true,
      fast_precision: "seconds",
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
    // The consolidation's point-in-time validity window, half-open
    // `[version_valid_from, version_valid_to)`: the text in force on date D is
    // the version with `version_valid_from <= D` and `version_valid_to > D`.
    // A missing `version_valid_to` is the current consolidation, open-ended,
    // so the upper half of that test is asked as a negation — a document
    // without the field cannot match a range over it.
    //
    // Fast so an as-of filter is pushed into the engine and evaluated off the
    // fast field, instead of being re-derived per hit after the scan. Both
    // stay nullable (a source that publishes no window still has to be
    // indexed) and neither is the timestamp field, for the same reason.
    //
    // Like every mapping here, these reach only indexes created after this
    // change: the engine never diffs the mapping of an index that exists, and
    // in `lenient` mode it would take the fields and drop them. An existing
    // legislation index would therefore need a generation bump to serve an
    // as-of filter — `corpusGeneration("legislation")` is the flip.
    {
      name: "version_valid_from",
      type: "datetime",
      fast: true,
      input_formats: DATE_INPUT_FORMATS,
    },
    {
      name: "version_valid_to",
      type: "datetime",
      fast: true,
      input_formats: DATE_INPUT_FORMATS,
    },
    // European Legislation Identifier / national statute number.
    { name: "eli", type: "text", tokenizer: "raw" },
  ],
};

/**
 * Distinct values a split may hold for a tag field before the engine stops
 * recording that field's values in the split's metadata.
 *
 * Crossing it costs pruning, not correctness: a split whose tag values were
 * dropped is opened by every query instead of only the matching ones. Silent,
 * and visible only as latency, which is why a field joins `tag_fields` on an
 * argument about its value domain rather than on hope. `court` per
 * jurisdiction is the case the corpus-index config test states.
 */
export const TAG_FIELD_VALUE_LIMIT = 1000;

/**
 * Fields whose values a split records so a query can skip splits that cannot
 * match. Every one of them is a filter the browse and search paths apply, and
 * every one has a value domain bounded well under `TAG_FIELD_VALUE_LIMIT`
 * within a single index (indexes are per jurisdiction, or per index group
 * from case-law generation 3 on, so `court` is bounded by one group's court
 * registries, not by every country's at once).
 */
const FAMILY_TAG_FIELDS: Record<CorpusFamily, string[]> = {
  // `language` is bounded by the languages a jurisdiction's courts publish in,
  // which is one or a few; a jurisdiction that publishes in several is exactly
  // where tagging it lets a language-filtered query skip splits.
  case_law: ["jurisdiction", "document_type", "source", "court", "language"],
  legislation: ["jurisdiction", "document_type", "source", "status"],
};

/**
 * How the engine treats a document field the mapping does not declare.
 *
 * `lenient` indexes the document and drops the field, so a filter on it
 * matches nothing, forever, with nothing to notice. `strict` drops the whole
 * document — and not loudly: the ingest still answers 200 with the document
 * counted as accepted, and the only direct trace is a warning in the engine's
 * own log.
 *
 * So `strict` is worth its failure mode only where something counts the
 * documents that should be there. Case law has that: the rebuild's census
 * compares the engine's count against the corpus' per jurisdiction, and a
 * dropped document is a difference it reports. Legislation has no census yet
 * and stays `lenient` until it does, because a silently dropped document
 * there would be marked indexed with nothing to find it. Both families are
 * covered on the other side by a test that every field their writer emits is
 * one their mapping declares.
 *
 * Total, so a new family answers this rather than inheriting an answer.
 */
const FAMILY_DOC_MAPPING_MODE = {
  case_law: "strict",
  legislation: "lenient",
} as const satisfies Record<CorpusFamily, CorpusIndexDocMappingMode>;

/**
 * The datetime every document of a family carries, or null for a family that
 * has none. Total so a new family has to answer the question: the engine takes
 * the timestamp field as a promise about every document, and a family whose
 * date is nullable can only keep that promise by mapping a second field for it
 * (see `DECISION_TIMESTAMP_FIELD`).
 */
const FAMILY_TIMESTAMP_FIELD = {
  case_law: DECISION_TIMESTAMP_FIELD,
  legislation: null,
} as const satisfies Record<CorpusFamily, string | null>;

export const corpusIndexConfig = (
  family: CorpusFamily,
  indexId: string,
): CorpusIndexConfig => {
  const timestampField = FAMILY_TIMESTAMP_FIELD[family];
  return {
    version: CORPUS_INDEX_CONFIG_VERSION,
    index_id: indexId,
    doc_mapping: {
      // Per family, and generation-scoped like everything else here: an index
      // already created keeps the mode it was made with, which is what lets
      // the writer emit a field that generation never mapped
      // (`decision_date_ts` against a v2 index) without losing that document.
      mode: FAMILY_DOC_MAPPING_MODE[family],
      field_mappings: [...CORE_FIELDS, ...FAMILY_FIELDS[family]],
      tokenizers: CUSTOM_TOKENIZERS,
      tag_fields: FAMILY_TAG_FIELDS[family],
      ...(timestampField === null ? {} : { timestamp_field: timestampField }),
      store_source: false,
    },
    indexing_settings: { merge_policy: MERGE_POLICY },
    search_settings: {
      // The rule under a passage layout: no field that repeats across a
      // document's passages may be a default search field. One free-text term
      // hitting such a field lets a single document answer with as many hits
      // as it has passages and crowd everything else out of the capped scan
      // window. `text` is the only per-passage field here, and it is
      // per-passage *content* — each passage matches on its own words, which
      // is the point. Everything else document-level is raw-tokenized,
      // numeric, or (like `title`) written to one passage only.
      default_search_fields: ["title", "text"],
    },
  };
};

export const caseLawIndexConfig = (indexId: string): CorpusIndexConfig =>
  corpusIndexConfig("case_law", indexId);
