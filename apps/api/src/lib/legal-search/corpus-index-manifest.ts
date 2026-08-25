import { panic } from "better-result";

import { CASE_LAW_INDEX_GROUP_OF } from "@/api/lib/legal-search/case-law-index-groups";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import {
  CORPUS_INDEX_CONFIG_VERSION,
  CORPUS_INDEX_DATE_INPUT_FORMATS,
  CORPUS_INDEX_MERGE_POLICY,
  DECISION_TIMESTAMP_FIELD,
  FOLDED_TOKENIZER,
  type CorpusIndexConfig,
} from "@/api/lib/legal-search/corpus-index-config";

export const CORPUS_INDEX_MANIFEST_SCHEMA_VERSION = 1;
export const QUICKWIT_V09_BINARY_VERSION = "0.9.0";

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

type CaseLawV5Manifest = CorpusIndexManifestBase & {
  family: "case_law";
  generation: "case_law_v5";
  projection: CorpusIndexProjectionContract & { layout: "passage" };
  route: {
    type: "case_law_group";
    byJurisdiction: typeof CASE_LAW_INDEX_GROUP_OF;
  };
};

type LegislationV2Manifest = CorpusIndexManifestBase & {
  family: "legislation";
  generation: "legislation_v2";
  projection: CorpusIndexProjectionContract & { layout: "document" };
  // The routing rule is fixed while the jurisdiction set is deliberately
  // open: adding a corpus creates another jurisdiction index without changing
  // the manifest. Plane decides which jurisdictions to build and when.
  route: { type: "jurisdiction" };
};

export type CorpusIndexManifest = CaseLawV5Manifest | LegislationV2Manifest;
export type CorpusIndexManifestGeneration =
  CorpusIndexManifest["generation"];

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
});

const dateField = (name: string): CorpusIndexFieldMapping => ({
  name,
  type: "datetime",
  indexed: true,
  stored: false,
  fast: true,
  input_formats: CORPUS_INDEX_DATE_INPUT_FORMATS,
});

const commonFields = (): CorpusIndexFieldMapping[] => [
  rawField("document_id", { stored: true, fast: false }),
  rawField("projection_revision", { stored: true, fast: false }),
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

const indexConfig = (
  fieldMappings: CorpusIndexFieldMapping[],
  tagFields: string[],
  timestampField?: string,
): Omit<CorpusIndexConfig, "index_id"> => ({
  version: CORPUS_INDEX_CONFIG_VERSION,
  doc_mapping: {
    mode: "strict",
    field_mappings: fieldMappings,
    tokenizers: [FOLDED_TOKENIZER],
    tag_fields: tagFields,
    ...(timestampField === undefined
      ? {}
      : { timestamp_field: timestampField }),
    store_source: false,
  },
  indexing_settings: { merge_policy: CORPUS_INDEX_MERGE_POLICY },
  search_settings: { default_search_fields: ["title", "text"] },
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

const CASE_LAW_V5_INDEX_CONFIG = deepFreeze(
  structuredClone(
    indexConfig(
      [
        ...commonFields(),
        {
          name: "anchor_id",
          type: "text",
          indexed: false,
          stored: true,
          fast: false,
        },
        rawField("case_number", { stored: false, fast: false }),
        rawField("court", { stored: false, fast: true }),
        dateField("decision_date"),
        {
          ...dateField(DECISION_TIMESTAMP_FIELD),
          fast_precision: "seconds",
        },
        rawField("ecli", { stored: false, fast: false }),
      ],
      ["jurisdiction", "document_type", "source", "court", "language"],
      DECISION_TIMESTAMP_FIELD,
    ),
  ),
);

const LEGISLATION_V2_INDEX_CONFIG = deepFreeze(
  structuredClone(
    indexConfig(
      [
        ...commonFields(),
        rawField("status", { stored: false, fast: true }),
        dateField("effective_date"),
        dateField("version_valid_from"),
        dateField("version_valid_to"),
        rawField("eli", { stored: false, fast: false }),
      ],
      ["jurisdiction", "document_type", "source", "status", "language"],
    ),
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
      documentIdField: "document_id",
      projectionRevisionField: "projection_revision",
      openingField: "is_opening",
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
      return generation === "case_law_v5"
        ? CORPUS_INDEX_MANIFESTS.case_law_v5
        : panic(`Unknown case-law index manifest: ${generation}`);
    case "legislation":
      return generation === "legislation_v2"
        ? CORPUS_INDEX_MANIFESTS.legislation_v2
        : panic(`Unknown legislation index manifest: ${generation}`);
    default:
      return panic("Unknown corpus index manifest family");
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
    .map(
      ([key, entry]) =>
        `${JSON.stringify(key)}:${canonicalJson(entry)}`,
    )
    .join(",")}}`;
};

export const corpusIndexManifestDigest = (
  manifest: CorpusIndexManifest,
): string =>
  new Bun.CryptoHasher("sha256")
    .update(canonicalJson(manifest))
    .digest("hex");

export const corpusIndexConfigFromManifest = (
  manifest: CorpusIndexManifest,
  indexId: string,
): CorpusIndexConfig => {
  const config = structuredClone(manifest.engine.indexConfig);
  return { ...config, index_id: indexId };
};
