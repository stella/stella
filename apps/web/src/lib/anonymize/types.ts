/**
 * Source of a detected entity span.
 * Ordered by detection layer in the pipeline.
 */
export const DETECTION_SOURCES = {
  TRIGGER: "trigger",
  REGEX: "regex",
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

export type TriggerExtractionStrategy =
  | { type: "to-next-comma" }
  | { type: "to-end-of-line" }
  | { type: "n-words"; count: number };

/**
 * Redacted document output with stable entity mapping.
 */
export type RedactionResult = {
  redactedText: string;
  /** Maps placeholder like [PERSON_1] to original text */
  redactionMap: Map<string, string>;
  entityCount: number;
};

/**
 * Configuration for the detection pipeline.
 */
export type PipelineConfig = {
  threshold: number;
  enableTriggerPhrases: boolean;
  enableRegex: boolean;
  enableGazetteer: boolean;
  enableNer: boolean;
  enableConfidenceBoost: boolean;
  enableCoreference: boolean;
  labels: string[];
  workspaceId: string;
};

/**
 * GLiNER model option for the UI selector.
 */
export type ModelOption = {
  id: string;
  label: string;
  url: string;
  tokenizer: string;
};

export const MODEL_OPTIONS: readonly ModelOption[] = [
  {
    id: "pii-fp16",
    label: "PII v1 (fp16, 580 MB)",
    url: "https://huggingface.co/onnx-community/gliner_multi_pii-v1/resolve/main/onnx/model_fp16.onnx",
    tokenizer: "onnx-community/gliner_multi_pii-v1",
  },
  {
    id: "pii-int8",
    label: "PII v1 (int8, 349 MB)",
    url: "https://huggingface.co/onnx-community/gliner_multi_pii-v1/resolve/main/onnx/model_quantized.onnx",
    tokenizer: "onnx-community/gliner_multi_pii-v1",
  },
  {
    id: "multi-v2.1-fp16",
    label: "Multi v2.1 (fp16, 580 MB)",
    url: "https://huggingface.co/onnx-community/gliner_multi-v2.1/resolve/main/onnx/model_fp16.onnx",
    tokenizer: "onnx-community/gliner_multi-v2.1",
  },
  {
    id: "multi-v2.1-int8",
    label: "Multi v2.1 (int8, 349 MB)",
    url: "https://huggingface.co/onnx-community/gliner_multi-v2.1/resolve/main/onnx/model_quantized.onnx",
    tokenizer: "onnx-community/gliner_multi-v2.1",
  },
  {
    id: "pii-edge-fp16",
    label: "PII Edge (fp16, 91 MB)",
    url: "https://huggingface.co/knowledgator/gliner-pii-edge-v1.0/resolve/main/onnx/model_fp16.onnx",
    tokenizer: "onnx-community/gliner_multi_pii-v1",
  },
];

/**
 * Labels matching gliner_multi_pii-v1 training data.
 */
export const DEFAULT_ENTITY_LABELS = [
  "person",
  "organization",
  "phone number",
  "address",
  "email address",
  "date of birth",
  "bank account number",
  "iban",
  "tax identification number",
  "identity card number",
  "registration number",
  "credit card number",
  "passport number",
] as const;

/**
 * Colour classes for entity highlights (Tailwind).
 * Keyed by canonical label.
 */
export const ENTITY_COLORS: Record<string, string> = {
  person: "bg-blue-200 dark:bg-blue-800",
  organization: "bg-green-200 dark:bg-green-800",
  "phone number": "bg-pink-200 dark:bg-pink-800",
  address: "bg-yellow-200 dark:bg-yellow-800",
  "email address": "bg-orange-200 dark:bg-orange-800",
  "date of birth": "bg-purple-200 dark:bg-purple-800",
  "bank account number": "bg-red-200 dark:bg-red-800",
  iban: "bg-red-200 dark:bg-red-800",
  "tax identification number": "bg-teal-200 dark:bg-teal-800",
  "identity card number": "bg-indigo-200 dark:bg-indigo-800",
  "registration number": "bg-cyan-200 dark:bg-cyan-800",
  "credit card number": "bg-rose-200 dark:bg-rose-800",
  "passport number": "bg-violet-200 dark:bg-violet-800",
};
