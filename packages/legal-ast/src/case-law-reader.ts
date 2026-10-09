import { normalizeCaseLawDecisionAst } from "./case-law-normalize.js";
import { type DocumentAst, parseUsableDocumentAst } from "./document-ast.js";

/** Parse persisted case-law content and apply every read-time structural repair. */
export const parseCaseLawDecisionAst = (raw: unknown): DocumentAst | null => {
  const ast = parseUsableDocumentAst(raw);
  return ast === null ? null : normalizeCaseLawDecisionAst(ast);
};
