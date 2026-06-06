import { isStatuteStatus } from "@stll/legal-ast";
import type { StatuteAst } from "@stll/legal-ast";

export const CORPUS_DOCUMENT_KINDS = [
  "case-law-decision",
  "statute-expression",
  "regulation-expression",
  "gazette-item",
] as const;

export type CorpusDocumentKind = (typeof CORPUS_DOCUMENT_KINDS)[number];

export const CORPUS_PROJECTION_KINDS = [
  "raw-source",
  "normalized-text",
  "legal-ast",
  "search-document",
] as const;

export type CorpusProjectionKind = (typeof CORPUS_PROJECTION_KINDS)[number];

export const LEGAL_AST_CAPABILITIES = {
  statuteAstVersion: 1,
  supportsConsolidatedStatus: isStatuteStatus("consolidated"),
} as const;

export type CorpusAst =
  | {
      type: "statute-expression";
      ast: StatuteAst;
    }
  | {
      type: Exclude<CorpusDocumentKind, "statute-expression">;
      ast: unknown;
    };
