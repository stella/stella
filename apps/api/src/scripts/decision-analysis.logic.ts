/**
 * Everything the three decision-analysis operator scripts decide, without a
 * database, a file or a process: argument parsing, the per-decision input
 * they print, the submission they accept, and the one-word outcome they
 * report. Pure, so the fences and the refusals are driven directly in
 * `decision-analysis.logic.test.ts` rather than through a live corpus.
 *
 * The scripts run under a restricted database login, so nothing here may
 * reach for the application's env or its connection.
 */

import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { parseUsableDocumentAst } from "@stll/legal-ast/document-ast";

import { analysisOutputSchema } from "@/api/handlers/case-law/analysis/analysis-output";
import type {
  AnalysisSubject,
  AnalysisUpdateOutcome,
} from "@/api/handlers/case-law/analysis/analysis-update";
import { allowsDerivedAiAnalysis } from "@/api/handlers/case-law/analysis/analysis-update";
import { getSystemPrompt } from "@/api/handlers/case-law/analysis/prompts/prompt-registry";
import type { SafeId } from "@/api/lib/branded-types";
import type { AnalysisInput } from "@/api/lib/case-law/analysis-prompt";
import { analysisInputOf } from "@/api/lib/case-law/analysis-prompt";

export class ScriptArgumentError extends TaggedError("ScriptArgumentError")<{
  message: string;
}> {}

/**
 * Why one decision cannot be analysed, or cannot take the analysis offered
 * for it. A closed set: the scripts print one of these verbatim, so an
 * operator reading a run's report can act on it without reading the code.
 */
export const ANALYSIS_REJECTION = {
  /** No such decision, or it is not visible to this login. */
  notFound: "not-found",
  /** The decision's text was erased on request; there is nothing to analyse. */
  redacted: "redacted",
  /** The source's reuse terms withhold derived AI use of its text. */
  derivedAiNotAllowed: "derived-ai-not-allowed",
  /**
   * No usable parse in the row. Under canonical corpus storage the parse
   * lives in object storage, which this database-only login cannot read.
   */
  astUnavailable: "ast-unavailable",
  /** The submitted output does not match the schema the input published. */
  invalidOutput: "invalid-output",
  /** The graph-fenced layer is written in-app; it is never submitted. */
  significanceNotAccepted: "significance-not-accepted",
  /** The decision's input no longer digests to the submitted fingerprint. */
  staleFingerprint: "stale-fingerprint",
  /** The row's content hash is not the one the input was read under. */
  staleContentHash: "stale-content-hash",
  /** An in-app generation run holds the row. */
  runInFlight: "run-in-flight",
  /** The row changed between the read and the claim. */
  claimLost: "claim-lost",
} as const;

export type AnalysisRejection =
  (typeof ANALYSIS_REJECTION)[keyof typeof ANALYSIS_REJECTION];

/** The columns both scripts read from `case_law_decisions` and its source. */
export type DecisionAnalysisRow = AnalysisSubject & {
  id: SafeId<"caseLawDecision">;
  language: string;
  court: string;
  country: string;
  decisionType: string | null;
  documentAst: unknown;
  redactedAt: Date | null;
};

export type ResolvedDecisionInput =
  | { status: "ok"; input: AnalysisInput; ast: DocumentAst }
  | { status: "rejected"; reason: AnalysisRejection };

/**
 * The model input for one row, resolved exactly as the in-app run resolves
 * it: the same language-selected system prompt, the same anchored user
 * message, and therefore the same fingerprint. The parse comes from the
 * row's own column, which is what a database-only login can read.
 */
export const resolveRowAnalysisInput = (
  row: DecisionAnalysisRow,
): ResolvedDecisionInput => {
  if (row.redactedAt !== null) {
    return { status: "rejected", reason: ANALYSIS_REJECTION.redacted };
  }
  if (!allowsDerivedAiAnalysis(row)) {
    return {
      status: "rejected",
      reason: ANALYSIS_REJECTION.derivedAiNotAllowed,
    };
  }
  const ast = parseUsableDocumentAst(row.documentAst);
  if (ast === null) {
    return { status: "rejected", reason: ANALYSIS_REJECTION.astUnavailable };
  }
  return {
    status: "ok",
    ast,
    input: analysisInputOf({
      blocks: ast.blocks,
      decision: row,
      systemPrompt: getSystemPrompt(row.language),
    }),
  };
};

/**
 * One record of a save run's input file. `output` is parsed with the very
 * schema the input script published, so a submission the published schema
 * accepts is a submission this accepts.
 */
export const analysisSubmissionRecordSchema = v.strictObject({
  decisionId: v.pipe(v.string(), v.minLength(1)),
  fingerprint: v.pipe(v.string(), v.minLength(1)),
  contentHash: v.nullable(v.pipe(v.string(), v.minLength(1))),
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  output: analysisOutputSchema,
});

export type AnalysisSubmissionRecord = v.InferOutput<
  typeof analysisSubmissionRecordSchema
>;

const submittedOutputSchema = v.object({
  // Presence is the whole test, whatever the value: `nonOptional` is what
  // separates a key that was sent from one that was left out.
  output: v.object({ significance: v.nonOptional(v.unknown()) }),
});

/**
 * The graph-fenced layer is written in-app from the citation graph, which a
 * producer of a document analysis has not seen. Named separately from a
 * plain schema failure so the report says what to remove.
 */
const carriesSignificance = (record: unknown): boolean =>
  v.is(submittedOutputSchema, record);

export type ParsedSubmission =
  | { status: "ok"; record: AnalysisSubmissionRecord }
  | { status: "rejected"; decisionId: string; reason: AnalysisRejection };

const submittedIdSchema = v.object({
  decisionId: v.pipe(v.string(), v.minLength(1)),
});

/** The id to report a rejection against, even when nothing else parses. */
const decisionIdOf = (record: unknown): string => {
  const parsed = v.safeParse(submittedIdSchema, record);
  return parsed.success ? parsed.output.decisionId : "<unknown>";
};

export const parseSubmissionRecord = (record: unknown): ParsedSubmission => {
  if (carriesSignificance(record)) {
    return {
      status: "rejected",
      decisionId: decisionIdOf(record),
      reason: ANALYSIS_REJECTION.significanceNotAccepted,
    };
  }
  const parsed = v.safeParse(analysisSubmissionRecordSchema, record);
  if (!parsed.success) {
    return {
      status: "rejected",
      decisionId: decisionIdOf(record),
      reason: ANALYSIS_REJECTION.invalidOutput,
    };
  }
  return { status: "ok", record: parsed.output };
};

/** The whole input file: a single record, or a list of them. */
export const parseSubmissionFile = (
  raw: string,
): Result<unknown[], ScriptArgumentError> => {
  const parsed = Result.try((): unknown => JSON.parse(raw));
  if (Result.isError(parsed)) {
    return Result.err(
      new ScriptArgumentError({ message: "--input is not valid JSON" }),
    );
  }
  const value = parsed.value;
  return Result.ok(Array.isArray(value) ? value : [value]);
};

/** Ids from a file, one per line; blank lines and `#` comments ignored. */
export const parseIdsFile = (raw: string): string[] =>
  raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

export type SaveOutcomeLine = { decisionId: string; outcome: string };

/** The one word a save run reports per decision. */
export const describeUpdateOutcome = (
  outcome: AnalysisUpdateOutcome,
): string => {
  switch (outcome.kind) {
    case "saved":
      return "saved";
    case "unchanged":
      return "unchanged";
    case "derived-ai-refused":
      return `rejected:${ANALYSIS_REJECTION.derivedAiNotAllowed}`;
    case "stale-fingerprint":
      return `rejected:${ANALYSIS_REJECTION.staleFingerprint}`;
    case "stale-content-hash":
      return `rejected:${ANALYSIS_REJECTION.staleContentHash}`;
    case "run-in-flight":
      return `rejected:${ANALYSIS_REJECTION.runInFlight}`;
    case "claim-lost":
      return `rejected:${ANALYSIS_REJECTION.claimLost}`;
    default:
      outcome satisfies never;
      return panic("Unhandled analysis update outcome");
  }
};

export const rejectionLine = (reason: AnalysisRejection): string =>
  `rejected:${reason}`;

/** The database URL the three scripts connect with. */
export const ANALYSIS_DATABASE_URL_ENV = "CASE_LAW_ANALYSIS_DATABASE_URL";

export const readAnalysisDatabaseUrl = (
  environment: Record<string, string | undefined>,
): Result<string, ScriptArgumentError> => {
  const url = environment[ANALYSIS_DATABASE_URL_ENV];
  return url === undefined || url.length === 0
    ? Result.err(
        new ScriptArgumentError({
          message: `${ANALYSIS_DATABASE_URL_ENV} is not set. Point it at the corpus database, as the stella_case_law_analysis_writer role.`,
        }),
      )
    : Result.ok(url);
};

/** `--name value` from an argument list; absent means undefined. */
export const flagValue = (
  argv: readonly string[],
  name: string,
): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
};

export const hasFlag = (argv: readonly string[], name: string): boolean =>
  argv.includes(`--${name}`);

export const positiveInteger = (
  raw: string | undefined,
  fallback: number,
): number => {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const nonNegativeInteger = (
  raw: string | undefined,
  fallback: number,
): number => {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};
