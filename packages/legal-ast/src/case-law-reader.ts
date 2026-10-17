import { normalizeCaseLawDecisionAst } from "./case-law-normalize.js";
import {
  type DecisionDocumentAst,
  parseUsableDocumentAst,
} from "./document-ast.js";

/** Parse persisted case-law content and apply every read-time structural repair. */
export const parseCaseLawDecisionAst = (
  raw: unknown,
): DecisionDocumentAst | null => {
  const ast = parseUsableDocumentAst(raw);
  if (ast === null || ast.metadata.family !== "decision") {
    return null;
  }
  return normalizeCaseLawDecisionAst({ ...ast, metadata: ast.metadata });
};
