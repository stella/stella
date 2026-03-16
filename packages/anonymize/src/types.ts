/**
 * Source of a detected entity span.
 * Ordered by detection layer in the pipeline.
 */
export const DETECTION_SOURCES = {
  TRIGGER: "trigger",
  REGEX: "regex",
  LEGAL_FORM: "legal-form",
  GAZETTEER: "gazetteer",
  NER: "ner",
  COREFERENCE: "coreference",
} as const;

export type DetectionSource =
  (typeof DETECTION_SOURCES)[keyof typeof DETECTION_SOURCES];

/**
 * A detected PII entity span in the source text.
 * Every detection layer produces these.
 */
export type Entity = {
  start: number;
  end: number;
  label: string;
  text: string;
  score: number;
  source: DetectionSource;
};

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

/**
 * Trigger phrase rule for Czech/German legal documents.
 * The trigger is a prefix; the value following it is
 * extracted as a PII entity.
 */
export type TriggerRule = {
  trigger: string;
  label: string;
  strategy: TriggerExtractionStrategy;
};

type TriggerExtractionStrategy =
  | { type: "to-next-comma" }
  | { type: "to-end-of-line" }
  | { type: "n-words"; count: number };

/**
 * Anonymisation operator types. Each operator defines
 * how a confirmed entity is replaced in the output.
 */
export const OPERATOR_TYPES = ["replace", "redact"] as const;

export type OperatorType = (typeof OPERATOR_TYPES)[number];

/** Per-label operator selection. Key is the entity label. */
export type OperatorConfig = {
  /** Operator per label. Missing labels default to "replace". */
  operators: Record<string, OperatorType>;
  /** Custom replacement string for the redact operator. */
  redactString: string;
};

/** Whether an operator produces a reversible redaction entry. */
type OperatorReversibility = "reversible" | "irreversible";

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
  ) => string;
};

/**
 * Redacted document output with stable entity mapping.
 */
export type RedactionResult = {
  redactedText: string;
  /**
   * Maps placeholder to original text. Only populated for
   * reversible operators (replace). Empty for redact.
   */
  redactionMap: Map<string, string>;
  /** Maps placeholder to the operator that produced it. */
  operatorMap: Map<string, OperatorType>;
  entityCount: number;
};

/**
 * Configuration for the detection pipeline.
 */
export type PipelineConfig = {
  threshold: number;
  enableTriggerPhrases: boolean;
  enableRegex: boolean;
  enableNameCorpus: boolean;
  enableGazetteer: boolean;
  enableNer: boolean;
  enableConfidenceBoost: boolean;
  enableCoreference: boolean;
  labels: string[];
  workspaceId: string;
};

/**
 * Canonical entity labels used across the pipeline.
 * NER models may use different native labels; the bench
 * NER wrapper maps model output to these canonical names.
 *
 * These labels are ephemeral: entities are regenerated on
 * every pipeline run and never persisted to the database.
 * Renaming a label here requires no migration.
 */
export const DEFAULT_ENTITY_LABELS = [
  "person",
  "organization",
  "phone number",
  "address",
  "email address",
  "date",
  "bank account number",
  "iban",
  "tax identification number",
  "identity card number",
  "registration number",
  "credit card number",
  "passport number",
] as const;
