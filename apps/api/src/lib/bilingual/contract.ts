// Durable bilingual-translation run vocabulary.
//
// Dependency-light on purpose: the database schema derives its CHECK
// constraints from the consts here, and the worker and the endpoints share one
// definition of what a run is. Nothing here imports a handler slice.

import type { ConstantMap } from "@/api/lib/constant-map";

/** Lifecycle of one translation run. `queued` on insert, `running` once the
 *  worker claims it, then a terminal `completed` / `failed` / `cancelled`. */
export const BILINGUAL_RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type BilingualRunStatus = (typeof BILINGUAL_RUN_STATUSES)[number];

/** The statuses that still occupy a document: exactly one run may hold them
 *  per `(entityId, fileFieldId)`, enforced by a partial unique index. */
export const BILINGUAL_RUN_ACTIVE_STATUSES = [
  "queued",
  "running",
] as const satisfies readonly BilingualRunStatus[];

/** Why a run ended in `failed`. A closed set so the surface can explain the
 *  failure without parsing a message, and so no model or provider text ever
 *  lands on the row. */
export const BILINGUAL_RUN_ERROR_CODES = [
  /** The document or its DOCX field no longer resolves. */
  "document_unresolved",
  /** The document moved to a newer version since the run was prepared. */
  "document_changed",
  /** The document has no bilingual table to fill. */
  "not_bilingual",
  /** No model is configured or usage is unavailable for this organization. */
  "ai_unavailable",
  /** A translation batch failed. */
  "translation_failed",
  /** The translated rows could not be written into the document. */
  "apply_failed",
  /** The job could not be handed to the queue. */
  "enqueue_failed",
  /** Anything the worker could not attribute more precisely. */
  "internal",
] as const;
export type BilingualRunErrorCode = (typeof BILINGUAL_RUN_ERROR_CODES)[number];

/**
 * What happens to one row of the bilingual table.
 *
 * `translate`: the right cell receives the translation. `keep`: the row is
 * not prose (signature line, identifier, amount); the cells are merged and
 * the copy removed. `inline`: a short label worth showing in both languages
 * in one cell (`Podpis: / Signature:`); the cells are merged and the text
 * becomes `source / target`. An inline-layout source table has no copy, so
 * its paragraph is edited in place. A stacked source table has a separate
 * target paragraph; both `translate` and `inline` write only that target.
 */
export const BILINGUAL_ROW_DISPOSITIONS = [
  "translate",
  "keep",
  "inline",
] as const;
export type BilingualRowDisposition =
  (typeof BILINGUAL_ROW_DISPOSITIONS)[number];
export const BILINGUAL_ROW_DISPOSITION = {
  TRANSLATE: "translate",
  KEEP: "keep",
  INLINE: "inline",
} as const satisfies ConstantMap<BilingualRowDisposition>;

/** Who chose a row's disposition; the review surface shows model choices
 *  differently from rule-stamped ones. */
export const BILINGUAL_DISPOSITION_ORIGINS = [
  "rule",
  "model",
  "default",
  "user",
] as const;
export type BilingualDispositionOrigin =
  (typeof BILINGUAL_DISPOSITION_ORIGINS)[number];

export const BILINGUAL_ROW_KINDS = [
  "paragraph",
  "heading",
  "listItem",
  "table",
] as const;
export type BilingualRowKind = (typeof BILINGUAL_ROW_KINDS)[number];

export const BILINGUAL_ROW_STATUSES = [
  "pending",
  "translated",
  "failed",
] as const;
export type BilingualRowStatus = (typeof BILINGUAL_ROW_STATUSES)[number];

export const BILINGUAL_GLOSSARY_ORIGINS = [
  "detected",
  "proposed",
  "user",
] as const;
export type BilingualGlossaryOrigin =
  (typeof BILINGUAL_GLOSSARY_ORIGINS)[number];

/** One defined term and the rendering every row must use for it. Inflected
 *  forms let the consistency check match declined languages. */
export type BilingualGlossaryEntry = {
  source: string;
  target: string;
  sourceForms: string[];
  targetForms: string[];
  origin: BilingualGlossaryOrigin;
};

export const BILINGUAL_LIMITS = {
  /** Rows per document; the manifest is held in memory and in one table. */
  rowsMax: 3000,
  glossaryMax: 300,
  termMax: 120,
  formsMax: 12,
  rowTextMax: 20_000,
  /** Rows sent to the model per translation call. */
  batchSize: 8,
  /** Preceding rows shown to the model for context. */
  contextRows: 2,
  /** Rows per disposition call. */
  dispositionChunk: 160,
} as const;

/** Source tables stay intact; their translations use a separate full-width
 * target table so legal forms are never squeezed into half-page columns. */
export const BILINGUAL_TABLE_LAYOUT = "stacked" as const;
