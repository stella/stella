import { normalizeCaseLawDecisionAst } from "@stll/legal-ast/case-law-normalize";
import type { DocumentAst } from "@stll/legal-ast/document-ast";
import {
  isDocumentAst,
  omitDerivablePlainText,
} from "@stll/legal-ast/document-ast";
import { projectionDigest } from "@stll/legal-ast/projection-digest";

import type { SafeId } from "@/api/lib/branded-types";
import {
  parsePersistedCorpusAst,
  readCorpusPayloadOrFallback,
} from "@/api/lib/legal-search/corpus-storage";
import type { EmptyAst } from "@/api/lib/legal-search/document-types";

type DecisionAstSource = "store" | "row";

/** One copy of the AST, named by where it was read from; null when it is absent. */
const astFrom = (
  source: DecisionAstSource,
  payload: DocumentAst | EmptyAst | null,
) => (payload === null ? null : { payload, source });

type ServedAst = {
  payload: DocumentAst | EmptyAst | null;
  source: DecisionAstSource | null;
  projectionDigest: string | null;
};

type ReadServedAstOptions = {
  astS3Key: string | null;
  contentHash: string | null;
  pgAst: DocumentAst | EmptyAst | null;
  decisionId: SafeId<"caseLawDecision">;
  corpusReadEnabled: boolean;
  readStore: () => Promise<DocumentAst | EmptyAst | null>;
};

/** Resolve the AST and record which copy actually served the response. */
export const readServedDecisionAst = async ({
  astS3Key,
  contentHash,
  pgAst,
  decisionId,
  corpusReadEnabled,
  readStore,
}: ReadServedAstOptions): Promise<ServedAst> => {
  const rowAst = () => astFrom("row", parsePersistedCorpusAst(pgAst));
  const resolved =
    !corpusReadEnabled || astS3Key === null || contentHash === null
      ? rowAst()
      : await readCorpusPayloadOrFallback({
          documentId: decisionId,
          key: astS3Key,
          step: "readDecision.corpusAst",
          read: async () => astFrom("store", await readStore()),
          fallback: rowAst,
        });

  if (resolved === null) {
    return { payload: null, source: null, projectionDigest: null };
  }

  const payload = isDocumentAst(resolved.payload)
    ? normalizeCaseLawDecisionAst(resolved.payload)
    : resolved.payload;
  return {
    payload,
    source: isDocumentAst(resolved.payload) ? resolved.source : null,
    projectionDigest: isDocumentAst(payload)
      ? await projectionDigest(payload)
      : null,
  };
};

/** A deferred fetch or local reparse replaces the AST after the stored read.
 * Neither the store nor the row served the replacement, so its source is null.
 */
type TransientDecisionAstProjectionOptions = {
  resolvedAst: DocumentAst;
  plainText: "include" | "omit";
};

export const transientDecisionAstProjection = async ({
  resolvedAst,
  plainText,
}: TransientDecisionAstProjectionOptions) => {
  const normalized = normalizeCaseLawDecisionAst(resolvedAst);
  return {
    documentAst:
      plainText === "include" ? normalized : omitDerivablePlainText(normalized),
    projectionDigest: await projectionDigest(normalized),
    documentAstSource: null,
  };
};
