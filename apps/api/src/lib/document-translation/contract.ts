import type { ConstantMap } from "@/api/lib/constant-map";

export const DOCUMENT_TRANSLATION_OUTPUTS = [
  "translated",
  "bilingual",
] as const;
export type DocumentTranslationOutput =
  (typeof DOCUMENT_TRANSLATION_OUTPUTS)[number];
export const DOCUMENT_TRANSLATION_OUTPUT = {
  TRANSLATED: "translated",
  BILINGUAL: "bilingual",
} as const satisfies ConstantMap<DocumentTranslationOutput>;

export const DOCUMENT_TRANSLATION_ENGINES = ["deepl", "ai"] as const;
export type DocumentTranslationEngine =
  (typeof DOCUMENT_TRANSLATION_ENGINES)[number];
export const DOCUMENT_TRANSLATION_ENGINE = {
  DEEPL: "deepl",
  AI: "ai",
} as const satisfies ConstantMap<DocumentTranslationEngine>;

export const DOCUMENT_TRANSLATION_COMMENT_POLICIES = [
  "original",
  "original-and-translated",
  "translated",
] as const;
export type DocumentTranslationCommentPolicy =
  (typeof DOCUMENT_TRANSLATION_COMMENT_POLICIES)[number];
export const DOCUMENT_TRANSLATION_COMMENT_POLICY = {
  ORIGINAL: "original",
  ORIGINAL_AND_TRANSLATED: "original-and-translated",
  TRANSLATED: "translated",
} as const satisfies ConstantMap<DocumentTranslationCommentPolicy>;

export const DOCUMENT_TRANSLATION_RUN_STATUSES = [
  "queued",
  "preparing",
  "translating",
  "assembling",
  "validating",
  "completed",
  "failed",
  "cancelled",
] as const;
export type DocumentTranslationRunStatus =
  (typeof DOCUMENT_TRANSLATION_RUN_STATUSES)[number];

export const DOCUMENT_TRANSLATION_RUN_ACTIVE_STATUSES = [
  "queued",
  "preparing",
  "translating",
  "assembling",
  "validating",
] as const satisfies readonly DocumentTranslationRunStatus[];

export const DOCUMENT_TRANSLATION_RUN_ERROR_CODES = [
  "document_unresolved",
  "document_changed",
  "unsupported_format",
  "unsupported_review_markup",
  "provider_unavailable",
  "translation_failed",
  "format_validation_failed",
  "internal",
] as const;
export type DocumentTranslationRunErrorCode =
  (typeof DOCUMENT_TRANSLATION_RUN_ERROR_CODES)[number];

export const DOCUMENT_TRANSLATION_UNIT_STATUSES = [
  "pending",
  "translated",
  "failed",
] as const;
export type DocumentTranslationUnitStatus =
  (typeof DOCUMENT_TRANSLATION_UNIT_STATUSES)[number];

export type DocxSegmentApplication = {
  type: "docxSegment";
  segmentId: string;
  taggedSourceText: string;
};

export type BilingualRowApplication = {
  type: "bilingualRow";
  rowId: string;
  kind: "paragraph" | "heading" | "listItem" | "table";
  inTable: boolean;
  disposition: "translate" | "keep" | "inline";
  sourceParaId: string | null;
};

export type DocumentTranslationUnitApplication =
  | DocxSegmentApplication
  | BilingualRowApplication;

export const DOCUMENT_TRANSLATION_LIMITS = {
  unitsMax: 3000,
  warningsMax: 100,
  batchSize: 8,
  contextUnits: 2,
  unitTextMax: 20_000,
} as const;

export const isExecutableTranslationCombination = (
  output: DocumentTranslationOutput,
  engine: DocumentTranslationEngine,
): boolean =>
  output === DOCUMENT_TRANSLATION_OUTPUT.TRANSLATED ||
  engine === DOCUMENT_TRANSLATION_ENGINE.AI;
