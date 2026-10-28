import * as v from "valibot";

import { analysisTreeSchema } from "@stll/legal-ast/analysis";

/**
 * The languages a decision can be analysed in: one system prompt is written
 * for each, and the server refuses any other (`language_unsupported`). The
 * prompt registry is typed against this list, so the reader names exactly
 * the languages the server accepts.
 */
export const CASE_LAW_ANALYSIS_LANGUAGES = [
  "cs",
  "sk",
  "de",
  "en",
  "pl",
] as const;

export type CaseLawAnalysisLanguage =
  (typeof CASE_LAW_ANALYSIS_LANGUAGES)[number];

/** Whether a version's language is one an analysis can be made in. */
export const isCaseLawAnalysisLanguage = (
  language: string,
): language is CaseLawAnalysisLanguage =>
  CASE_LAW_ANALYSIS_LANGUAGES.some((known) => known === language);

/**
 * Why the decision analysis read answers `error` without a failed run behind
 * it: the server will not make an analysis of this decision at all.
 */
export const CASE_LAW_ANALYSIS_UNAVAILABLE_CODES = [
  "decision_not_found",
  "document_unparseable",
  "language_unsupported",
  "analysis_unavailable",
] as const;

export type CaseLawAnalysisUnavailableCode =
  (typeof CASE_LAW_ANALYSIS_UNAVAILABLE_CODES)[number];

/**
 * Why the reader's last run ended without an analysis, as the reader is told:
 * the answer arrived incomplete (cut off, unparseable, or not the requested
 * structure), the run outlived its deadline, the provider refused the call
 * (rejected key, billing, quota, retired model), the provider was
 * unavailable, or something else failed.
 */
export const CASE_LAW_ANALYSIS_FAILURE_CODES = [
  "answer_incomplete",
  "timed_out",
  "provider_refused",
  "provider_unavailable",
  "failed",
] as const;

export type CaseLawAnalysisFailureCode =
  (typeof CASE_LAW_ANALYSIS_FAILURE_CODES)[number];

/** Whose AI key a failed run called the provider with. */
export const CASE_LAW_ANALYSIS_KEY_SOURCES = [
  "organization",
  "platform",
] as const;

export type CaseLawAnalysisKeySource =
  (typeof CASE_LAW_ANALYSIS_KEY_SOURCES)[number];

export const caseLawAnalysisProgressSchema = v.object({
  status: v.literal("generating"),
  partialTree: v.optional(analysisTreeSchema, []),
});

export type CaseLawAnalysisProgressResponse = v.InferInput<
  typeof caseLawAnalysisProgressSchema
>;
