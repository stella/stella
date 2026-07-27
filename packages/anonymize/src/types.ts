// Runtime-free constants live in `./constants`; re-exported
// here for back-compat with existing call sites that import
// from `@stll/anonymize` directly.
//
// `verbatimModuleSyntax` requires an explicit type-only
// import for any name used locally as a type even when it
// is also re-exported below — applies to `DetectionSource`
// (used by `Entity`) and `OperatorType` (used by
// `OperatorConfig`).
import type { DetectionSource, OperatorType } from "./constants";
import { DETECTION_SOURCES } from "./constants";

export {
  DETECTION_SOURCES,
  DETECTOR_PRIORITY,
  type DetectionSource,
} from "./constants";

/**
 * Fields shared by every entity span in the source text.
 */
type EntityBase = {
  start: number;
  end: number;
  label: string;
  text: string;
  score: number;
  sourceDetail?: "custom-deny-list" | "custom-regex" | "gazetteer-extension";
};

/**
 * A PII entity span found by a primary detection layer
 * (regex, NER, legal forms, deny list, ...).
 */
export type DetectedEntity = EntityBase & {
  source: Exclude<DetectionSource, typeof DETECTION_SOURCES.COREFERENCE>;
};

/**
 * An alias mention of a previously detected entity: a
 * defined term ("the Seller") or a propagated bare
 * mention ("Acme" after "Acme Corp.").
 *
 * `corefSourceText` is required by construction, so an
 * alias cannot exist without the link back to its source
 * entity. Placeholder numbering reads it to give the
 * alias the same placeholder as the source. The link
 * travels with the entity instead of living in a
 * side-channel map that a producer could forget to
 * write — or that a later pass could clear.
 */
export type CorefAliasEntity = EntityBase & {
  source: typeof DETECTION_SOURCES.COREFERENCE;
  /** Full text of the source entity this alias refers to. */
  corefSourceText: string;
};

/**
 * A detected PII entity span in the source text.
 * Every detection layer produces these.
 */
export type Entity = DetectedEntity | CorefAliasEntity;

/**
 * Entity after human review. Extends the base Entity
 * with a review decision.
 */
export type ReviewDecision = "confirmed" | "rejected" | "relabeled";

export type ReviewedEntity = Entity & {
  decision?: ReviewDecision;
  originalLabel?: string;
};

/**
 * A single entry in the workspace-scoped gazetteer
 * (deny list). Persisted in IndexedDB.
 */
export type GazetteerEntry = {
  id: string;
  canonical: string;
  label: string;
  variants: string[];
  workspaceId: string;
  createdAt: number;
  source: "manual" | "confirmed-from-model";
};

/** Extraction strategy — closed discriminated union. */
export type TriggerStrategy =
  | {
      type: "to-next-comma";
      /**
       * Optional list of lowercase keywords that terminate
       * the value scan, in addition to commas/newlines. Useful
       * for triggers like court names that may continue past
       * a missing comma into adjacent clause text ("Městským
       * soudem v Praze dne 1. 1. 2020"); listing `"dne"` here
       * stops the scan at the date boundary. Matched on a
       * word-boundary, case-insensitive.
       */
      stopWords?: string[];
      /**
       * Hard cap on the captured span length, in characters,
       * regardless of where the next comma / stop char sits.
       * Use for triggers that label short formulaic phrases
       * ("State of Delaware") and must not absorb the rest
       * of a long forum-selection clause when the comma is
       * sentences away. Falls back to the default 100-char
       * fallback when omitted.
       */
      maxLength?: number;
    }
  | { type: "to-end-of-line" }
  | { type: "n-words"; count: number }
  | { type: "company-id-value" }
  | { type: "address"; maxChars?: number }
  | {
      /**
       * Extract the first regex match in the value text.
       * Useful for shape-bounded values that follow a
       * label on the same line as other fields, where
       * `to-end-of-line` would over-capture. The pattern
       * is anchored to the start of the (already
       * leading-whitespace-stripped) value, so use
       * `(?:.*?)` prefix only when intentional.
       */
      type: "match-pattern";
      pattern: string;
      flags?: string;
    };

/** Validation rules — closed discriminated union. */
export type TriggerValidation =
  | { type: "starts-uppercase" }
  | { type: "min-length"; min: number }
  | { type: "max-length"; max: number }
  | { type: "no-digits" }
  | { type: "has-digits" }
  | {
      type: "matches-pattern";
      pattern: string;
      flags?: string;
    }
  /**
   * Run a named stdnum validator (checksum + length)
   * against the captured value. Keeps the trigger
   * path symmetrical with the formatted-regex
   * detectors so e.g. `CPF nº 00000000000` does not
   * survive as a tax-ID entity.
   */
  | { type: "valid-id"; validator: ValidIdValidator };

/** Built-in stdnum validators that can be referenced
 *  by `valid-id` validations. */
export type ValidIdValidator = "br.cpf" | "br.cnpj" | "us.rtn";

/** Auto-generated trigger variants — closed set. */
export type TriggerExtension =
  | "add-colon"
  | "add-trailing-space"
  | "add-colon-space"
  | "normalize-spaces";

/** V2 trigger config entry (JSON shape). */
export type TriggerGroupConfig = {
  id?: string;
  triggers: string[];
  label: string;
  strategy: TriggerStrategy;
  extensions?: TriggerExtension[];
  validations?: TriggerValidation[];
  /** When true, include the trigger text in the
   *  entity span (e.g., court names). */
  includeTrigger?: boolean;
};

/** Compiled validation with pre-built regex. */
export type CompiledValidation =
  | { type: "starts-uppercase"; re: RegExp }
  | { type: "min-length"; min: number }
  | { type: "max-length"; max: number }
  | { type: "no-digits"; re: RegExp }
  | { type: "has-digits"; re: RegExp }
  | { type: "matches-pattern"; re: RegExp }
  | {
      type: "valid-id";
      validator: ValidIdValidator;
      check: (value: string) => boolean;
    };

/**
 * Runtime rule — one per trigger string after
 * expansion. Fed to the Aho-Corasick automaton.
 */
export type TriggerRule = {
  trigger: string;
  label: string;
  strategy: TriggerStrategy;
  validations: CompiledValidation[];
  includeTrigger: boolean;
};

export {
  ENTITY_CAPABILITIES,
  ENTITY_LABELS,
  ENTITY_SELECTIONS,
  OPERATOR_TYPES,
  type DefaultEntityLabel,
  type EntityCapability,
  type EntityLabel,
  type EntitySelection,
  type OperatorType,
} from "./constants";

/** Per-label operator selection. Key is the entity label. */
export type MaskDirection = "start" | "end";

export type MaskOperatorConfig = {
  type: "mask";
  maskingCharacter: string;
  charactersToMask: number;
  direction: MaskDirection;
};

export type OperatorSelection =
  | Exclude<OperatorType, "mask">
  | MaskOperatorConfig;

export type OperatorConfig = {
  /** Operator per label. Missing labels default to "replace". */
  operators: Record<string, OperatorSelection>;
  /** Custom replacement string for the redact operator. */
  redactString: string;
};

/** Whether an operator produces a reversible redaction entry. */
type OperatorReversibility = "reversible" | "irreversible" | "preserving";

export type AnonymisationOperator = {
  type: OperatorType;
  reversibility: OperatorReversibility;
  /**
   * Apply the operator to a single entity occurrence.
   * Returns the replacement string to embed in the document.
   */
  apply: (
    text: string,
    label: string,
    placeholder: string,
    redactString: string,
    selection: OperatorSelection,
  ) => string;
};

/**
 * Redacted document output with stable entity mapping.
 */
export type RedactionResult = {
  redactedText: string;
  /**
   * Maps placeholder to original text. Only populated for
   * reversible operators (replace). Empty for redact, keep, and mask.
   */
  redactionMap: Map<string, string>;
  /** Maps placeholder to the operator that produced it. */
  operatorMap: Map<string, OperatorType>;
  entityCount: number;
};

/**
 * Configuration for the detection pipeline.
 */
export type DenyListCategory =
  | "Names"
  | "Places"
  | "Addresses"
  | "Courts"
  | "Financial"
  | "Government"
  | "Healthcare"
  | "Education"
  | "Political"
  | "Organizations"
  | "International";

/**
 * Metadata for a single dictionary entry in the
 * deny-list system. Mirrors the shape from
 * the anonymize-data package so consumers can pass
 * pre-loaded data without a runtime dependency.
 */
export type DictionaryMeta = {
  label: string;
  category: DenyListCategory;
  country: string | null;
};

/**
 * Caller-supplied exact terms for deny-list matching.
 * These entries are merged with the published deny-list
 * dictionaries when `enableDenyList` is enabled.
 */
export type CustomDenyListEntry = {
  value: string;
  label: string;
  variants?: readonly string[];
};

/**
 * Caller-supplied regex detector. The pattern is passed
 * to the native Rust regex engine, so use its supported
 * regex syntax. Inline flags such as `(?i)` are accepted
 * when supported by that engine.
 */
export type CustomRegexPattern = {
  pattern: string;
  label: string;
  score?: number;
  preparedArtifactPolicy?: "include" | "omit";
};

/**
 * Pre-loaded dictionary data for dependency injection.
 * Consumers that want name/city/deny-list detection
 * load dictionaries themselves (e.g. from the
 * anonymize-data package) and pass them here; the
 * anonymize package has zero cross-package imports.
 *
 * All fields are optional. When a field is absent,
 * the corresponding detection path is skipped (same
 * behavior as when no dictionaries are available).
 */
export type Dictionaries = {
  /**
   * First names per language code (e.g., "cs", "de").
   */
  firstNames?: Readonly<Record<string, readonly string[]>>;
  /**
   * Surnames per language code.
   */
  surnames?: Readonly<Record<string, readonly string[]>>;
  /**
   * Non-Western name tokens per locale code
   * (e.g., "in", "ar", "ja-latn", "ko", "zh-latn",
   * "th", "vi", "fil", "id"). Merged with bundled
   * names-nw-*.json data at init time.
   */
  nonWesternNames?: Readonly<Record<string, readonly string[]>>;
  /**
   * Pre-loaded deny-list dictionaries keyed by
   * dictionary ID (e.g., "courts/CZ", "banks/DE").
   * Each value is the array of terms for that
   * dictionary.
   */
  denyList?: Readonly<Record<string, readonly string[]>>;
  /**
   * Metadata per dictionary ID. Required when
   * `denyList` is provided so the pipeline knows
   * labels, categories, and country filters.
   */
  denyListMeta?: Readonly<Record<string, DictionaryMeta>>;
  /**
   * Pre-loaded city names, already merged across
   * all desired countries.
   *
   * Prefer `citiesByCountry` when callers also pass
   * `denyListCountries` / `denyListRegions`; merged
   * city arrays cannot be scoped after injection.
   */
  cities?: readonly string[];
  /**
   * Pre-loaded city names keyed by ISO 3166-1 alpha-2
   * country code. When provided, the deny-list builder
   * applies `denyListCountries` / `denyListRegions`
   * before adding city patterns to the search automaton.
   */
  citiesByCountry?: Readonly<Record<string, readonly string[]>>;
};

/**
 * Street-address detection without a known-city anchor.
 */
export type StandaloneStreetDetection = "off" | "houseNumberAnchored";

export type PipelineConfig = {
  threshold: number;
  enableTriggerPhrases: boolean;
  enableRegex: boolean;
  /**
   * Expected content language codes. When present, these
   * derive default dictionary scopes for name corpus and
   * deny-list matching unless the lower-level scope fields
   * below are set explicitly.
   */
  languages?: string[];
  /**
   * Convenience form for single-language documents. Ignored
   * when `languages` is also provided.
   */
  language?: string;
  /**
   * Enables legal-form organization detection.
   * Required for typed callers; legacy untyped
   * callers that omit this field are treated as
   * enabled at runtime for backward compatibility.
   */
  enableLegalForms: boolean;
  /**
   * Enables first-name/surname/title corpus matching.
   * When deny-list mode is enabled, this also controls
   * whether name-corpus entries are injected into the
   * deny-list search automaton.
   */
  enableNameCorpus: boolean;
  /**
   * Optional language scope for first-name/surname
   * dictionaries, using the keys present in
   * `dictionaries.firstNames` / `dictionaries.surnames`
   * (for example `["en", "de"]`). When omitted, all
   * injected name languages are used for backward
   * compatibility.
   */
  nameCorpusLanguages?: string[];
  enableDenyList: boolean;
  denyListCountries?: string[];
  denyListRegions?: string[];
  denyListExcludeCategories?: string[];
  /**
   * Caller-owned exact terms to match through the
   * deny-list layer. Requires `enableDenyList: true`.
   */
  customDenyList?: readonly CustomDenyListEntry[];
  /**
   * Caller-owned regex detectors. Requires
   * `enableRegex: true`.
   */
  customRegexes?: readonly CustomRegexPattern[];
  enableGazetteer: boolean;
  /**
   * Detect country names (ISO 3166-1 names, curated
   * aliases, alpha-3 codes). Defaults to true. Names
   * span all manifest languages plus widely-used
   * additions (Dutch, Russian, Chinese, Arabic, etc.).
   */
  enableCountries?: boolean;
  enableConfidenceBoost: boolean;
  enableCoreference: boolean;
  enableZoneClassification?: boolean;
  enableHotwordRules?: boolean;
  /**
   * Detect a street address that carries no known-city
   * anchor. Defaults to `"off"`.
   *
   * `"houseNumberAnchored"` accepts a street-type word
   * with a house number directly beside it, in either
   * order ("14 Rue de la Paix", "Hauptstraße 5",
   * "123 Main Street"). A bare street name with no
   * number never fires.
   *
   * A street-type word plus a nearby number is a much
   * weaker signal than a city-anchored address and does
   * fire on contract prose ("District Court 2019"), so
   * this stays opt-in per workspace.
   */
  standaloneStreetDetection?: StandaloneStreetDetection;
  /**
   * Requested output labels. An empty array means
   * "do not filter by label" for deterministic detectors.
   */
  labels: string[];
  workspaceId: string;
  /**
   * Pre-loaded dictionary data for name, deny-list,
   * and city detection. When omitted, dictionary-based
   * detection paths are skipped. Consumers load from
   * the anonymize-data package and pass the data here.
   */
  dictionaries?: Dictionaries;
};

export { DEFAULT_ENTITY_LABELS } from "./constants";

export const isLegalFormsEnabled = (
  config: Pick<PipelineConfig, "enableLegalForms">,
): boolean => config.enableLegalForms !== false;
