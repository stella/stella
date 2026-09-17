/**
 * The public decision read, with the document fetched when it is a
 * reader who gets there before the ingestion queue.
 *
 * This sits between the route and `get.ts` rather than inside it for
 * two reasons. `get.ts` stays a read — it holds the public read-only
 * database boundary, and the fetch is a write. And an import edge added
 * to a module the route tree infers through costs the API typecheck
 * over a million type instantiations (see the typecheck baseline
 * guard), so the read handler keeps the import list it had and reports
 * `documentPending` instead; the fetch is wired in here.
 */

import { envBase } from "@/api/env-base";
import {
  devReparseEnabled,
  reparseForDev,
} from "@/api/handlers/case-law/decisions/dev-reparse";
import {
  isDeferredDocumentFetchable,
  readThroughDeferredDocument,
} from "@/api/handlers/case-law/decisions/document-on-demand";
import { onDemandDocumentDeps } from "@/api/handlers/case-law/decisions/document-on-demand-deps";
import { readDecisionHandler } from "@/api/handlers/case-law/decisions/get";
import { omitDerivablePlainText } from "@/api/handlers/case-law/document-ast";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type { DecisionSubjectLocator } from "@/api/lib/case-law/public-subject";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";

type DecisionRead = Awaited<ReturnType<typeof readDecisionHandler>>;
type ReadableDecision = Extract<DecisionRead, { documentPending: boolean }>;

/**
 * Whether the caller's reads may persist demand. Only a caller we can
 * attribute — a session, an agent token — may steer the ingestion
 * queue; see `recordDemand` in `document-on-demand.ts`.
 */
export type DecisionReadCaller = "anonymous" | "attributed";

/**
 * Whether this read may fetch a document the ingestion queue has not stored
 * yet. A fetch is a publisher crawl, so a caller reading many decisions at
 * once reads the stored state first and spends its own fetch budget
 * deliberately, rather than crawling once per id.
 */
export const DECISION_DOCUMENT_HYDRATION = {
  /** Fetch the document when the read finds one pending. */
  onDemand: "on-demand",
  /** Answer from what is stored; a pending document stays pending. */
  storedOnly: "stored-only",
} as const;

export type DecisionDocumentHydration =
  (typeof DECISION_DOCUMENT_HYDRATION)[keyof typeof DECISION_DOCUMENT_HYDRATION];

/**
 * A development process reading a shared corpus shows the parser in this
 * tree rather than the one that ingested the row; see `dev-reparse.ts`.
 */
const reparsedForDev = async (
  decision: ReadableDecision,
): Promise<ReadableDecision> => {
  if (!devReparseEnabled()) {
    return decision;
  }
  const documentAst = await reparseForDev({
    adapterKey: decision.source.adapterKey,
    caseNumber: decision.caseNumber,
    court: decision.court,
    decisionDate: decision.decisionDate,
    decisionType: decision.decisionType,
    documentUrl: decision.documentUrl,
    ecli: decision.ecli,
    id: decision.id,
    metadata: decision.metadata,
  });
  return documentAst === null
    ? decision
    : { ...decision, documentAst, documentPending: false, fulltext: null };
};

/**
 * Whether reads run against a shared public-law database rather than this
 * process's own ingestion database. That mode is strictly read-side: no read
 * may crawl a publisher or write through the local ingestion database, so the
 * parser in this tree is applied to what is stored instead.
 */
const readsSharedPublicLawCorpus = (): boolean =>
  envBase.PUBLIC_LAW_DATABASE_URL !== undefined;

const hydrate = async (
  decision: ReadableDecision,
  recordDemand: boolean,
  documentHydration: DecisionDocumentHydration,
): Promise<ReadableDecision> => {
  // The local shared-corpus mode is strictly read-side. An incomplete remote
  // decision stays metadata-only instead of starting the ingestion path,
  // which would otherwise crawl the publisher and write through the local
  // ingestion database. Checked before the caller's fetch budget, because a
  // caller that declines a publisher fetch is still owed the parser in this
  // tree: the reparse is not the fetch it declined.
  if (readsSharedPublicLawCorpus()) {
    return await reparsedForDev(decision);
  }
  if (documentHydration === DECISION_DOCUMENT_HYDRATION.storedOnly) {
    return decision;
  }

  if (
    !isDeferredDocumentFetchable({
      adapterKey: decision.source.adapterKey,
      documentUrl: decision.documentUrl,
      documentPending: decision.documentPending,
      documentReadFailed: decision.documentReadFailed,
    })
  ) {
    return decision;
  }

  const document = await readThroughDeferredDocument({
    decision: {
      id: decision.id,
      caseNumber: decision.caseNumber,
      ecli: decision.ecli,
      court: decision.court,
      country: decision.country,
      decisionDate: decision.decisionDate,
      decisionType: decision.decisionType,
      documentUrl: decision.documentUrl,
    },
    deps: onDemandDocumentDeps,
    recordDemand,
  });

  // The fetch did not finish inside the read's budget, or the source
  // had nothing: the decision stays readable as metadata and stays
  // queued, and the next read finds it stored.
  if (!document) {
    return decision;
  }

  return {
    ...decision,
    // Same omission the read applies to a stored AST: a document fetched
    // on demand must not answer with a fatter payload than a cached one.
    documentAst: omitDerivablePlainText(document.documentAst),
    documentPending: false,
    // Mirrors the read: text is the fallback for a decision without a
    // usable AST, and a parsed document always has one.
    fulltext: null,
  };
};

/**
 * The read's second phase: fetch the document when a reader arrives before
 * the ingestion queue does. A publisher fetch and an ingestion write, so it
 * runs after the gated read transaction has closed, never inside it.
 */
export const hydrateDeferredDocument = async (
  read: DecisionRead,
  recordDemand: boolean,
  documentHydration: DecisionDocumentHydration,
): Promise<DecisionRead> =>
  "documentPending" in read
    ? await hydrate(read, recordDemand, documentHydration)
    : read;

export type ReadGatedDecisionOptions = {
  caseLawDb: CaseLawPublicReadDb;
  locator: DecisionSubjectLocator;
  caller: DecisionReadCaller;
  citationsCursor?: string | null | undefined;
  documentHydration: DecisionDocumentHydration;
};

/**
 * Gate, read, then hydrate — in that order and for that reason.
 *
 * The gate and every row of the read share one transaction, so the content
 * cannot come from a state the gate did not approve. Hydration is a
 * publisher fetch and an ingestion write, which must not hold a read-only
 * transaction open, so it runs once that transaction has closed.
 *
 * Null is "no such decision for the public": it does not exist, or its
 * source may not be redistributed.
 */
export const readGatedDecisionWithDocument = async ({
  caseLawDb,
  locator,
  caller,
  citationsCursor,
  documentHydration,
}: ReadGatedDecisionOptions): Promise<DecisionRead | null> => {
  const read = await withRedistributableSubject(
    caseLawDb,
    locator,
    async (subject) => await readDecisionHandler({ citationsCursor, subject }),
  );

  return read === null
    ? null
    : await hydrateDeferredDocument(
        read,
        caller === "attributed",
        documentHydration,
      );
};
