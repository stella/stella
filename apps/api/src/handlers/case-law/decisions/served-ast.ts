import type {
  DocumentAst,
  WireDocumentAst,
} from "@stll/legal-ast/document-ast";
import { isDocumentAst } from "@stll/legal-ast/document-ast";
import { projectionDigest } from "@stll/legal-ast/projection-digest";

import type { SafeId } from "@/api/lib/branded-types";
import {
  parsePersistedCorpusAst,
  readCorpusPayloadOrFallback,
} from "@/api/lib/legal-search/corpus-storage";
import type { EmptyAst } from "@/api/lib/legal-search/document-types";

type DecisionAstSource = "store" | "row";

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
  const rowAst = () => parsePersistedCorpusAst(pgAst);
  const resolved =
    !corpusReadEnabled || astS3Key === null || contentHash === null
      ? { payload: rowAst(), source: "row" as const }
      : await readCorpusPayloadOrFallback({
          documentId: decisionId,
          key: astS3Key,
          step: "readDecision.corpusAst",
          read: async () => ({
            payload: await readStore(),
            source: "store" as const,
          }),
          fallback: () => {
            const payload = rowAst();
            return payload === null
              ? null
              : { payload, source: "row" as const };
          },
        });

  if (resolved === null || resolved.payload === null) {
    return { payload: null, source: null, projectionDigest: null };
  }

  return {
    payload: resolved.payload,
    source: isDocumentAst(resolved.payload) ? resolved.source : null,
    projectionDigest: isDocumentAst(resolved.payload)
      ? await projectionDigest(resolved.payload)
      : null,
  };
};

/** A deferred fetch or local reparse replaces the AST after the stored read.
 * Neither the store nor the row served the replacement, so its source is null.
 */
type TransientDecisionAstProjectionOptions = {
  resolvedAst: DocumentAst;
  wireAst: DocumentAst | WireDocumentAst;
};

export const transientDecisionAstProjection = async ({
  resolvedAst,
  wireAst,
}: TransientDecisionAstProjectionOptions) => ({
  documentAst: wireAst,
  projectionDigest: await projectionDigest(resolvedAst),
  documentAstSource: null,
});
