import { parseCaseLawDecisionAst } from "@stll/legal-ast/case-law-reader";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { deepFreeze } from "@/api/lib/legal-search/deep-freeze";
import { recordReadWork } from "@/api/lib/observability/request-work";

const normalized = new WeakMap<object, DocumentAst | null>();

/** Cache normalization by the immutable payload identity, never by a caller's query. */
export const parseCachedDecisionAst = (raw: unknown): DocumentAst | null => {
  if (typeof raw !== "object" || raw === null) {
    recordReadWork("astParses");
    return parseCaseLawDecisionAst(raw);
  }
  if (normalized.has(raw)) {
    recordReadWork("cacheHits");
    return normalized.get(raw) ?? null;
  }
  recordReadWork("astParses");
  const ast = deepFreeze(parseCaseLawDecisionAst(raw));
  normalized.set(raw, ast);
  return ast;
};
