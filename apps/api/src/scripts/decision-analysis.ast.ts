/**
 * The decision's parse, read the way the application reads it.
 *
 * Most of the corpus keeps its parse in object storage, not in the row: on
 * production only a minority of decisions still carry `document_ast`. A
 * reader that looked at the column alone would refuse most of the corpus,
 * so the scripts go through `readDecisionAnalysisAst`, the same function
 * the in-app generation run uses, which reads the corpus object and falls
 * back to the row's copy when the object is unreadable. `ast-unavailable`
 * then means what it says: there is no parse anywhere.
 *
 * This is the one module of the three scripts that needs the API
 * environment. The corpus reader resolves its bucket, region and storage
 * mode through `env-base`, and separating it from that would mean a second
 * copy of the payload reader (packed locations, transfer ceilings, zstd
 * framing, degradation reporting), which is worse than the dependency. The
 * scripts run as a one-off task on the API task definition, where that
 * environment is present and the task role carries the object-store read;
 * the database login is the only thing overridden, through
 * `CASE_LAW_ANALYSIS_DATABASE_URL`.
 *
 * Variables this module consumes, all already set on that task definition:
 *   CORPUS_STORAGE_MODE      whether the object or the column is canonical
 *   LEGAL_CORPUS_S3_BUCKET   the corpus bucket, falling back to S3_BUCKET
 *   S3_BUCKET, S3_REGION     bucket and region for the object-store client
 *   S3_ENDPOINT              set only where the store is not AWS
 * Object-store credentials come from the task role, never from a variable.
 */

import { Result } from "better-result";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { readDecisionAnalysisAst } from "@/api/lib/case-law/decision-analysis";
import { refreshCorpusS3 } from "@/api/lib/s3";

import type { DecisionAnalysisRow } from "./decision-analysis.logic";

/**
 * Refresh the corpus object-store client once per run, so a task role's
 * rotating credentials are picked up before the first read.
 */
export const prepareCorpusReads = async (): Promise<void> => {
  await refreshCorpusS3();
};

/**
 * The parse behind one row, or null when there is none to be had. A read
 * that fails outright is null too rather than an exception: one unreadable
 * object must not end a batch, and the run reports the decision as
 * `ast-unavailable`.
 */
export const readRowAst = async (
  row: DecisionAnalysisRow,
): Promise<DocumentAst | null> => {
  const ast = await Result.tryPromise(
    async () =>
      await readDecisionAnalysisAst({
        astS3Key: row.astS3Key,
        contentHash: row.contentHash,
        documentAst: row.documentAst,
        id: row.id,
      }),
  );
  return Result.isOk(ast) ? ast.value : null;
};
