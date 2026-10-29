import { TaggedError } from "better-result";
import * as v from "valibot";

import { sanitizeErrorAttributesForOutput } from "@stll/errors";
import {
  isDocumentAst,
  persistedDocumentAstSchema,
} from "@stll/legal-ast/document-ast";

import { captureError } from "@/api/lib/analytics/capture";
import {
  STORED_CORPUS_VALIDATION_CODE,
  StoredCorpusValidationError,
} from "@/api/lib/errors/tagged-errors";
import {
  EMPTY_AST,
  emptyAstSchema,
} from "@/api/lib/legal-search/document-types";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { logger } from "@/api/lib/observability/logger";
import { isRecord } from "@/api/lib/type-guards";

/** The wire contract shared by corpus readers and every payload writer. */
export const persistedCorpusAstSchema = v.nullable(
  v.union([persistedDocumentAstSchema, emptyAstSchema]),
);

class IngestedAstRejectedError extends TaggedError("IngestedAstRejectedError")<{
  message: string;
  source: string;
  parserVersion: number | null;
  checks: readonly string[];
}> {}

type PrepareCorpusAstOptions = {
  ast: unknown;
  fallbackText: string | null | undefined;
  source?: string;
  parserVersion?: number | undefined;
};

/** Keep the text payload when structure cannot be read; never persist that structure. */
export const prepareCorpusAst = ({
  ast,
  fallbackText,
  source,
  parserVersion,
}: PrepareCorpusAstOptions) => {
  const parsed = v.safeParse(persistedCorpusAstSchema, ast);
  if (parsed.success) {
    // Keep a canonical AST as the parser produced it: the parsed output is a
    // rebuilt object (schema key order, undeclared fields dropped), and the
    // content hash is order-sensitive JSON, so writing it would change every
    // unchanged decision's hash and lose fields the schema does not name.
    // Only a legacy-shaped AST is written in its normalized form.
    const stored = isDocumentAst(ast) ? ast : parsed.output;
    return { type: "readable", ast: stored } as const;
  }
  if (
    fallbackText === null ||
    fallbackText === undefined ||
    fallbackText.trim().length === 0
  ) {
    const error = new StoredCorpusValidationError({
      message: "Stored document AST failed validation without usable text",
      code: STORED_CORPUS_VALIDATION_CODE,
      paths: parsed.issues.map((issue) => v.getDotPath(issue) ?? "$"),
    });
    throw error;
  }
  const sourceSystem =
    isRecord(ast) &&
    isRecord(ast["source"]) &&
    typeof ast["source"]["system"] === "string"
      ? ast["source"]["system"]
      : "unknown";
  // Schema check messages are repository-owned. Other issue messages can
  // contain the rejected value, so report their validator type only.
  const checks = parsed.issues.map((issue) =>
    issue.type === "check" ? issue.message : issue.type,
  );
  const error = new IngestedAstRejectedError({
    message:
      "Document AST rejected by the reader schema; text retained. Reparse with a corrected parser.",
    source: source ?? sourceSystem,
    parserVersion: parserVersion ?? null,
    checks,
  });
  logger.error(
    "case_law.ingestion.ast_schema_rejected",
    sanitizeErrorAttributesForOutput({
      source: error.source,
      parserVersion: error.parserVersion,
      checks: error.checks,
      "error.type": "IngestedAstRejectedError",
    }),
  );
  captureError(
    error,
    handlerErrorContext("corpus.prepareCorpusAst", {
      source: error.source,
      parserVersion: String(error.parserVersion),
      checks: checks.join("; "),
    }),
  );
  return { type: "text-only", ast: EMPTY_AST } as const;
};
