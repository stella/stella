// ── Core Types ────────────────────────────────────
export type {
  Entity,
  ReviewedEntity,
  ReviewDecision,
  DetectionSource,
  GazetteerEntry,
  TriggerRule,
  OperatorType,
  OperatorConfig,
  AnonymisationOperator,
  RedactionResult,
  PipelineConfig,
} from "./types";
export {
  DETECTION_SOURCES,
  OPERATOR_TYPES,
  DEFAULT_ENTITY_LABELS,
} from "./types";

// ── Pipeline ──────────────────────────────────────
export { runPipeline, mergeAndDedup } from "./pipeline";
export type { NerInferenceFn } from "./pipeline";

// ── Redaction ─────────────────────────────────────
export {
  redactText,
  deanonymise,
  exportRedactionKey,
  buildPlaceholderMap,
} from "./redact";

// ── Operators ─────────────────────────────────────
export {
  OPERATOR_REGISTRY,
  DEFAULT_OPERATOR_CONFIG,
  resolveOperator,
} from "./operators";

// ── Detectors ─────────────────────────────────────
export { detectRegexPii } from "./detectors/regex";
export { detectTriggerPhrases } from "./detectors/triggers";
export { scanExact, scanFuzzy } from "./detectors/gazetteer";
export {
  extractDefinedTerms,
  findCoreferenceSpans,
} from "./detectors/coreference";

// ── Filters ───────────────────────────────────────
export { filterFalsePositives } from "./filters/false-positives";
export { boostNearMissEntities } from "./filters/confidence-boost";

// ── GLiNER Computation ────────────────────────────
export { decodeSpans } from "./gliner/decoder";
export { decodeTokenSpans } from "./gliner/token-decoder";
export { prepareBatch, tokenizeText } from "./gliner/processor";
export type { EntityResult, RawInferenceResult } from "./gliner/types";

// ── Utilities ─────────────────────────────────────
export {
  chunkText,
  computeChunkOffsets,
  mergeChunkEntities,
} from "./util/chunker";
export { levenshtein } from "./util/levenshtein";
