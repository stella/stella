import { parseCaseLawDecisionAst } from "@stll/legal-ast/case-law-reader";
import type { DocumentAst } from "@stll/legal-ast/document-ast";
import {
  hasUsableAst,
  isDocumentAst,
  omitDerivablePlainText,
} from "@stll/legal-ast/document-ast";
import { projectionDigest } from "@stll/legal-ast/projection-digest";

import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import type { StoredAstUnreadableError } from "@/api/lib/errors/tagged-errors";
import {
  readCorpusPayloadOrFallback,
  readPersistedCorpusAst,
} from "@/api/lib/legal-search/corpus-storage";
import type { PersistedCorpusAstRead } from "@/api/lib/legal-search/corpus-storage";
import type { EmptyAst } from "@/api/lib/legal-search/document-types";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";

type DecisionAstSource = "store" | "row";

/**
 * One copy of the AST as read: the payload and where it came from, or a
 * typed refusal for a stored value no reader can read. Null when absent.
 */
type ResolvedAst =
  | {
      type: "read";
      payload: DocumentAst | EmptyAst;
      source: DecisionAstSource;
    }
  | { type: "unreadable"; error: StoredAstUnreadableError }
  | null;

const astFrom = (
  source: DecisionAstSource,
  payload: DocumentAst | EmptyAst | null,
): ResolvedAst => (payload === null ? null : { type: "read", payload, source });

type ServedAst = {
  payload: DocumentAst | EmptyAst | null;
  source: DecisionAstSource | null;
  projectionDigest: string | null;
  /**
   * The stored AST exists but no reader can read it. The decision is then
   * served without its structure, from its fulltext or as a failed read, and
   * the row is reported for repair.
   */
  unreadable: boolean;
};

type ReadServedAstOptions = {
  astS3Key: string | null;
  contentHash: string | null;
  /**
   * The row's `document_ast` column as stored. Typed `unknown` on purpose: a
   * row keeps whatever its writer stored, so it is read only through
   * `readPersistedCorpusAst`, never trusted as the column's declared type.
   */
  pgAst: unknown;
  decisionId: SafeId<"caseLawDecision">;
  corpusReadEnabled: boolean;
  /** The stored object as read; raises only for an object-storage failure. */
  readStore: () => Promise<PersistedCorpusAstRead>;
};

/**
 * Resolve the AST and record which copy actually served the response.
 *
 * Never throws over what a copy holds: an unreadable store copy falls back to
 * the row's, but only to one with usable content. An absent or empty row copy
 * recovers nothing, so the answer stays `unreadable` and is reported. Only an
 * object-storage refusal with no row copy still raises, as
 * `CorpusPayloadUnavailableError`, which the read contains as an outage.
 */
export const readServedDecisionAst = async ({
  astS3Key,
  contentHash,
  pgAst,
  decisionId,
  corpusReadEnabled,
  readStore,
}: ReadServedAstOptions): Promise<ServedAst> => {
  const rowAst = (): ResolvedAst => {
    const read = readPersistedCorpusAst(pgAst);
    return read.type === "read" ? astFrom("row", read.ast) : read;
  };
  const storeAst = async (): Promise<ResolvedAst> => {
    const stored = await readStore();
    if (stored.type === "read") {
      return astFrom("store", stored.ast);
    }
    const row = rowAst();
    return row?.type === "read" && hasUsableAst(row.payload)
      ? row
      : { type: "unreadable", error: stored.error };
  };
  const resolved =
    !corpusReadEnabled || astS3Key === null || contentHash === null
      ? rowAst()
      : await readCorpusPayloadOrFallback({
          documentId: decisionId,
          key: astS3Key,
          step: "readDecision.corpusAst",
          read: storeAst,
          fallback: rowAst,
        });

  if (resolved === null || resolved.type === "unreadable") {
    if (resolved !== null) {
      captureError(
        resolved.error,
        handlerErrorContext("decisions.readServedDecisionAst.unreadable", {
          decisionId,
          step: "readDecision.storedAstUnreadable",
        }),
      );
    }
    return {
      payload: null,
      source: null,
      projectionDigest: null,
      unreadable: resolved !== null,
    };
  }

  const payload = isDocumentAst(resolved.payload)
    ? parseCaseLawDecisionAst(resolved.payload)
    : resolved.payload;
  return {
    payload,
    source: isDocumentAst(resolved.payload) ? resolved.source : null,
    projectionDigest: isDocumentAst(payload)
      ? await projectionDigest(payload)
      : null,
    unreadable: false,
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
  const normalized = parseCaseLawDecisionAst(resolvedAst);
  if (normalized === null) {
    return {
      documentAst: null,
      projectionDigest: null,
      documentAstSource: null,
    };
  }
  return {
    documentAst:
      plainText === "include" ? normalized : omitDerivablePlainText(normalized),
    projectionDigest: await projectionDigest(normalized),
    documentAstSource: null,
  };
};
