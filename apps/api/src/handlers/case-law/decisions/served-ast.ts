import type { DocumentAst } from "@stll/legal-ast/document-ast";
import {
  isDocumentAst,
  omitDerivablePlainText,
} from "@stll/legal-ast/document-ast";
import { projectionDigest } from "@stll/legal-ast/projection-digest";

import type { SafeId } from "@/api/lib/branded-types";
import { parseCachedDecisionAst } from "@/api/lib/case-law/decision-ast-normalization";
import {
  parsePersistedCorpusAst,
  readCorpusPayloadOrFallback,
} from "@/api/lib/legal-search/corpus-storage";
import type { EmptyAst } from "@/api/lib/legal-search/document-types";
import { recordReadWork } from "@/api/lib/observability/request-work";

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

const normalizedProjections = new WeakMap<DocumentAst, Promise<ServedAst>>();

type ReadServedAstOptions = {
  astS3Key: string | null;
  contentHash: string | null;
  pgAst: unknown;
  readPgAst?: () => Promise<DocumentAst | EmptyAst | null>;
  decisionId: SafeId<"caseLawDecision">;
  corpusReadEnabled: boolean;
  readStore: () => Promise<DocumentAst | EmptyAst | null>;
};

/** Resolve the AST and record which copy actually served the response. */
export const readServedDecisionAst = async ({
  astS3Key,
  contentHash,
  pgAst,
  readPgAst,
  decisionId,
  corpusReadEnabled,
  readStore,
}: ReadServedAstOptions): Promise<ServedAst> => {
  const rowAst = async () =>
    astFrom(
      "row",
      readPgAst === undefined
        ? parsePersistedCorpusAst(pgAst, decisionId)
        : await readPgAst(),
    );
  const resolved =
    !corpusReadEnabled || astS3Key === null || contentHash === null
      ? await rowAst()
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

  if (!isDocumentAst(resolved.payload)) {
    return { payload: resolved.payload, source: null, projectionDigest: null };
  }
  const cached = normalizedProjections.get(resolved.payload);
  if (cached !== undefined) {
    recordReadWork("cacheHits");
    return { ...(await cached), source: resolved.source };
  }
  const projection = (async (): Promise<ServedAst> => {
    const payload = parseCachedDecisionAst(resolved.payload);
    return {
      payload,
      source: resolved.source,
      projectionDigest:
        payload === null ? null : await projectionDigest(payload),
    };
  })();
  normalizedProjections.set(resolved.payload, projection);
  return await projection;
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
  const normalized = parseCachedDecisionAst(resolvedAst);
  if (normalized === null) {
    return {
      documentAst: null,
      sections: null,
      projectionDigest: null,
      documentAstSource: null,
    };
  }
  return {
    sections: null,
    documentAst:
      plainText === "include" ? normalized : omitDerivablePlainText(normalized),
    projectionDigest: await projectionDigest(normalized),
    documentAstSource: null,
  };
};
