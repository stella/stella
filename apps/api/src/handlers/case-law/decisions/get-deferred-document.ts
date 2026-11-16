/**
 * The public decision read, with the document fetched when it is a
 * reader who gets there before the ingestion queue.
 *
 * This sits between the route and `get.ts` rather than inside it for
 * two reasons. `get.ts` stays a read — it holds the public read-only
 * database boundary, while hydration performs outbound I/O. An import edge added
 * to a module the route tree infers through costs the API typecheck
 * over a million type instantiations (see the typecheck baseline
 * guard), so the read handler keeps the import list it had and reports
 * `documentPending` instead; the fetch is wired in here.
 */

import { panic } from "better-result";

import type { PublicCountrySurface } from "@stll/api-contract/public-country-capability";
import { isDocumentAst } from "@stll/legal-ast/document-ast";

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
import { transientDecisionAstProjection } from "@/api/handlers/case-law/decisions/served-ast";
import {
  checkDecisionTextCompletion,
  decisionTextCompletionReasons,
  readDecisionTextCompletion,
  readDecisionTextCompletionSafely,
} from "@/api/handlers/case-law/decisions/text-completion";
import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import {
  absentDecisionTextFields,
  absentTextField,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import type { TextAbsenceReason } from "@/api/lib/case-law/decision-text";
import type {
  DecisionSubjectLocator,
  RedistributableDecisionSubject,
} from "@/api/lib/case-law/public-subject";
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
 * yet. A fetch is a publisher crawl, a third-party request, so only a caller
 * holding a permit may ask for one. A caller reading many decisions at once
 * reads the stored state first and spends its own fetch budget deliberately,
 * rather than crawling once per id.
 */
export type DecisionDocumentHydration =
  /** Fetch the document when the read finds one pending. */
  | { type: "on-demand"; permit: ThirdPartyOutboundPermit }
  /** Answer from what is stored; a pending document stays pending. */
  | { type: "stored-only" };

export const STORED_ONLY_DOCUMENT_HYDRATION = {
  type: "stored-only",
} as const satisfies DecisionDocumentHydration;

/**
 * On demand for a caller holding a permit. A caller without one (a chat
 * script) answers from what is stored, so its read never crawls a publisher.
 */
export const documentHydrationFor = (
  permit: ThirdPartyOutboundPermit | undefined,
): DecisionDocumentHydration =>
  permit === undefined
    ? STORED_ONLY_DOCUMENT_HYDRATION
    : { type: "on-demand", permit };

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
    : {
        ...decision,
        ...(await transientDecisionAstProjection({
          resolvedAst: documentAst,
          plainText: "include",
        })),
        documentPending: false,
        hasDocument: true,
        fulltext: null,
      };
};

/**
 * Whether reads run against a shared public-law database rather than this
 * process's own ingestion database. That mode is strictly read-side: no read
 * may crawl a publisher or write through the local ingestion database, so the
 * parser in this tree is applied to what is stored instead.
 */
export const readsSharedPublicLawCorpus = (): boolean =>
  envBase.PUBLIC_LAW_DATABASE_URL !== undefined;

type HydrateDocumentOptions = {
  decision: ReadableDecision;
  recordDemand: boolean;
  documentHydration: DecisionDocumentHydration;
  textEligibilityFingerprint: string;
  textRevisionFingerprint: string;
};

const hydrate = async ({
  decision,
  recordDemand,
  documentHydration,
  textEligibilityFingerprint,
  textRevisionFingerprint,
}: HydrateDocumentOptions): Promise<ReadableDecision> => {
  // The development reparse fetches the document from the publisher, so a
  // caller without a permit answers from what is stored before that branch.
  if (documentHydration.type === "stored-only") {
    return decision;
  }
  // The local shared-corpus mode is strictly read-side. An incomplete remote
  // decision stays metadata-only instead of starting the ingestion path,
  // which would otherwise crawl the publisher and write through the local
  // ingestion database.
  if (readsSharedPublicLawCorpus()) {
    return await reparsedForDev(decision);
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
    adapterKey: decision.source.adapterKey,
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
    textRevisionFingerprint,
    deps: onDemandDocumentDeps,
    recordDemand,
    textEligibilityFingerprint,
  });

  // The fetch did not finish inside the read's budget, or the source
  // had nothing: the decision stays readable as metadata and stays
  // queued, and the next read finds it stored.
  if (!document) {
    return decision;
  }

  // Match the stored read: serve the fetched text when structure was rejected.
  const projection = isDocumentAst(document.documentAst)
    ? await transientDecisionAstProjection({
        resolvedAst: document.documentAst,
        plainText: "omit",
      })
    : { documentAst: null, projectionDigest: null, documentAstSource: null };
  return {
    ...decision,
    ...projection,
    documentPending: false,
    hasDocument: true,
    fulltext: projection.documentAst === null ? document.fulltext : null,
  };
};

const DECISION_READ_FIELD_KIND = {
  METADATA: "metadata",
  TEXT: "text",
  STATE: "state",
} as const;

type DecisionReadFieldKind =
  (typeof DECISION_READ_FIELD_KIND)[keyof typeof DECISION_READ_FIELD_KIND];

/**
 * Every field of a public decision read, classified for the response that
 * withholds text after a failed completion. Metadata is copied, text is
 * replaced by its absence, and state is recomputed. A field added to the read
 * does not compile until it is classified here.
 */
const DECISION_READ_FIELD_KINDS = {
  id: DECISION_READ_FIELD_KIND.METADATA,
  resolution: DECISION_READ_FIELD_KIND.METADATA,
  caseNumber: DECISION_READ_FIELD_KIND.METADATA,
  caseNumberType: DECISION_READ_FIELD_KIND.METADATA,
  slug: DECISION_READ_FIELD_KIND.METADATA,
  ecli: DECISION_READ_FIELD_KIND.METADATA,
  identifiers: DECISION_READ_FIELD_KIND.METADATA,
  court: DECISION_READ_FIELD_KIND.METADATA,
  courtId: DECISION_READ_FIELD_KIND.METADATA,
  courtAbbreviation: DECISION_READ_FIELD_KIND.METADATA,
  courtTier: DECISION_READ_FIELD_KIND.METADATA,
  country: DECISION_READ_FIELD_KIND.METADATA,
  language: DECISION_READ_FIELD_KIND.METADATA,
  languageGroupKey: DECISION_READ_FIELD_KIND.METADATA,
  decisionDate: DECISION_READ_FIELD_KIND.METADATA,
  decisionType: DECISION_READ_FIELD_KIND.METADATA,
  citationCount: DECISION_READ_FIELD_KIND.METADATA,
  sourceUrl: DECISION_READ_FIELD_KIND.METADATA,
  sourceAttributionUrl: DECISION_READ_FIELD_KIND.METADATA,
  documentUrl: DECISION_READ_FIELD_KIND.METADATA,
  sourceLanguages: DECISION_READ_FIELD_KIND.METADATA,
  createdAt: DECISION_READ_FIELD_KIND.METADATA,
  updatedAt: DECISION_READ_FIELD_KIND.METADATA,
  judges: DECISION_READ_FIELD_KIND.METADATA,
  languageAlternates: DECISION_READ_FIELD_KIND.METADATA,
  caseFile: DECISION_READ_FIELD_KIND.METADATA,
  documentAst: DECISION_READ_FIELD_KIND.TEXT,
  projectionDigest: DECISION_READ_FIELD_KIND.TEXT,
  documentAstSource: DECISION_READ_FIELD_KIND.TEXT,
  sections: DECISION_READ_FIELD_KIND.TEXT,
  fulltext: DECISION_READ_FIELD_KIND.TEXT,
  metadata: DECISION_READ_FIELD_KIND.TEXT,
  headnote: DECISION_READ_FIELD_KIND.TEXT,
  textFields: DECISION_READ_FIELD_KIND.TEXT,
  extractionWarnings: DECISION_READ_FIELD_KIND.TEXT,
  citationsFrom: DECISION_READ_FIELD_KIND.TEXT,
  citationsTo: DECISION_READ_FIELD_KIND.TEXT,
  citationsNextCursor: DECISION_READ_FIELD_KIND.TEXT,
  textIncompleteReason: DECISION_READ_FIELD_KIND.STATE,
  textWithheldReason: DECISION_READ_FIELD_KIND.STATE,
  documentPending: DECISION_READ_FIELD_KIND.STATE,
  documentReadFailed: DECISION_READ_FIELD_KIND.STATE,
  documentUnavailable: DECISION_READ_FIELD_KIND.STATE,
  hasDocument: DECISION_READ_FIELD_KIND.STATE,
  source: DECISION_READ_FIELD_KIND.STATE,
} as const satisfies Record<keyof ReadableDecision, DecisionReadFieldKind>;

type DecisionReadFieldsOf<Kind extends DecisionReadFieldKind> = {
  [
    Field in keyof typeof DECISION_READ_FIELD_KINDS
  ]: (typeof DECISION_READ_FIELD_KINDS)[Field] extends Kind ? Field : never;
}[keyof typeof DECISION_READ_FIELD_KINDS];

type DecisionReadPart<Kind extends DecisionReadFieldKind> = Pick<
  ReadableDecision,
  DecisionReadFieldsOf<Kind>
>;

const decisionReadMetadata = (
  read: ReadableDecision,
): DecisionReadPart<"metadata"> => ({
  id: read.id,
  resolution: read.resolution,
  caseNumber: read.caseNumber,
  caseNumberType: read.caseNumberType,
  slug: read.slug,
  ecli: read.ecli,
  identifiers: read.identifiers,
  court: read.court,
  courtId: read.courtId,
  courtAbbreviation: read.courtAbbreviation,
  courtTier: read.courtTier,
  country: read.country,
  language: read.language,
  languageGroupKey: read.languageGroupKey,
  decisionDate: read.decisionDate,
  decisionType: read.decisionType,
  citationCount: read.citationCount,
  sourceUrl: read.sourceUrl,
  sourceAttributionUrl: read.sourceAttributionUrl,
  documentUrl: read.documentUrl,
  sourceLanguages: read.sourceLanguages,
  createdAt: read.createdAt,
  updatedAt: read.updatedAt,
  judges: read.judges,
  languageAlternates: read.languageAlternates,
  caseFile: read.caseFile,
});

/** Every text field as its absence; nothing here is read from a decision. */
const withheldDecisionText = (reason: TextAbsenceReason) =>
  ({
    documentAst: null,
    projectionDigest: null,
    documentAstSource: null,
    sections: null,
    fulltext: null,
    metadata: {},
    headnote: absentTextField(reason),
    textFields: absentDecisionTextFields(reason),
    extractionWarnings: [],
    citationsFrom: [],
    citationsTo: [],
    citationsNextCursor: null,
  }) satisfies DecisionReadPart<"text">;

type WithheldDecisionCompletion = Exclude<
  ReturnType<typeof checkDecisionTextCompletion>,
  { type: "eligible" }
>;

const withheldTextAbsenceReason = (
  completion: WithheldDecisionCompletion,
): TextAbsenceReason => {
  switch (completion.type) {
    case "withheld":
      return TEXT_ABSENCE_REASON.REDISTRIBUTION_WITHHELD;
    case "incomplete":
      return completion.reason === "text_changed"
        ? TEXT_ABSENCE_REASON.TEXT_CHANGED
        : TEXT_ABSENCE_REASON.MISSING_TEXT;
    default:
      completion satisfies never;
      return panic("Unhandled withheld decision completion");
  }
};

type WithheldDecisionReadOptions = {
  read: ReadableDecision;
  completion: WithheldDecisionCompletion;
  allowsDerivedAi: boolean;
};

/**
 * The response for a decision whose text may no longer travel. Built from
 * the classified parts rather than the prepared read, so a text field the
 * read gains cannot reach this response unclassified.
 */
const withheldDecisionRead = ({
  read,
  completion,
  allowsDerivedAi,
}: WithheldDecisionReadOptions): ReadableDecision => {
  const { textIncompleteReason, textWithheldReason } =
    decisionTextCompletionReasons(completion);
  const state: DecisionReadPart<"state"> = {
    textIncompleteReason,
    textWithheldReason,
    documentPending: false,
    documentReadFailed: false,
    documentUnavailable: true,
    hasDocument: false,
    source: {
      id: read.source.id,
      name: read.source.name,
      adapterKey: read.source.adapterKey,
      allowsDerivedAi,
    },
  };
  return {
    ...decisionReadMetadata(read),
    ...withheldDecisionText(withheldTextAbsenceReason(completion)),
    ...state,
  };
};

/**
 * The read's second phase fetches a transient document outside the gated
 * transaction. The ingestion queue owns persistent documents independently.
 */
type PrepareDecisionDocumentReadOptions = {
  subject: RedistributableDecisionSubject;
  citationsCursor?: string | null | undefined;
  caseFileCursor?: string | null | undefined;
};

const PREPARED_DOCUMENT: unique symbol = Symbol("preparedDecisionDocument");

/** Bind the text-return proof to the same snapshot that produced the initial read. */
export const prepareDecisionDocumentRead = async ({
  subject,
  citationsCursor,
  caseFileCursor,
}: PrepareDecisionDocumentReadOptions) => {
  const read = await readDecisionHandler({
    subject,
    citationsCursor,
    caseFileCursor,
  });
  if (!("documentPending" in read)) {
    return { type: "response" as const, read };
  }
  const completion = await readDecisionTextCompletion({
    tx: subject.tx,
    decisionId: read.id,
    countries: subject.countries,
  });
  if (completion === undefined) {
    return panic("Prepared public decision has no text-completion snapshot");
  }
  return {
    type: "decision" as const,
    read,
    expectedFingerprint: completion.textEligibilityFingerprint,
    textRevisionFingerprint: completion.textRevisionFingerprint,
    countries: subject.countries,
    [PREPARED_DOCUMENT]: true as const,
  };
};

type PreparedDecisionDocument = Awaited<
  ReturnType<typeof prepareDecisionDocumentRead>
>;

type HydrateDeferredDocumentOptions = {
  prepared: PreparedDecisionDocument;
  caseLawDb: CaseLawPublicReadDb;
  recordDemand: boolean;
  documentHydration: DecisionDocumentHydration;
  hydrateDocument?: typeof hydrate;
};

/** Every response boundary completes its prepared proof after slow document work. */
export const hydrateDeferredDocument = async ({
  prepared,
  caseLawDb,
  recordDemand,
  documentHydration,
  hydrateDocument = hydrate,
}: HydrateDeferredDocumentOptions): Promise<DecisionRead> => {
  if (prepared.type === "response") {
    return prepared.read;
  }
  const hydrated = await hydrateDocument({
    decision: prepared.read,
    recordDemand,
    documentHydration,
    textEligibilityFingerprint: prepared.expectedFingerprint,
    textRevisionFingerprint: prepared.textRevisionFingerprint,
  });
  const current = await readDecisionTextCompletionSafely(
    async () =>
      await caseLawDb(
        async (tx) =>
          await readDecisionTextCompletion({
            tx,
            decisionId: prepared.read.id,
            countries: prepared.countries,
          }),
      ),
  );
  const currentSnapshot = current.isOk() ? current.value : undefined;
  const completion = current.match({
    ok: (snapshot) =>
      checkDecisionTextCompletion(prepared.expectedFingerprint, snapshot),
    err: (error) => ({ type: "incomplete", reason: error.reason }) as const,
  });
  if (completion.type === "eligible") {
    return hydrated;
  }
  return withheldDecisionRead({
    read: prepared.read,
    completion,
    allowsDerivedAi:
      currentSnapshot?.textWithheldReason === null &&
      currentSnapshot.textIncompleteReason === null,
  });
};

export type ReadGatedDecisionOptions = {
  caseLawDb: CaseLawPublicReadDb;
  locator: DecisionSubjectLocator;
  caller: DecisionReadCaller;
  citationsCursor?: string | null | undefined;
  documentHydration: DecisionDocumentHydration;
  /** The surface the read serves; its country list decides publication. */
  surface: PublicCountrySurface;
};

/**
 * Whether a read's document is stored, still coming, or not coming at all.
 *
 * `documentPending` alone cannot answer that. It stays set when a fetch was
 * never possible: a source that does not defer its documents, a payload object
 * storage refused (`documentReadFailed`), or a process reading a shared corpus,
 * which does not crawl at all. A caller told "pending" for one of those waits
 * for something that will never arrive, and if it withholds the stored
 * metadata while waiting, the decision reads as missing rather than as one
 * whose text is not served here.
 *
 * Derived from `hydrate`'s own gates, in the module that owns them, so the
 * answer cannot drift from what a hydration attempt would actually do.
 */
export const DECISION_DOCUMENT_STATE = {
  /** Stored and readable. */
  available: "available",
  /** Not stored, and a later fetch can still land it. */
  pending: "pending",
  /** Not stored, and nothing this deployment does will change that. */
  unavailable: "unavailable",
} as const;

export type DecisionDocumentState =
  (typeof DECISION_DOCUMENT_STATE)[keyof typeof DECISION_DOCUMENT_STATE];

export const decisionDocumentState = (
  read: DecisionRead,
  /**
   * Whether this process reads a shared corpus, passed in rather than read
   * here: it is the one part of the answer that belongs to the deployment
   * rather than to the row, and a caller that has it already should not make
   * this a second reader of the environment.
   */
  readsSharedCorpus: boolean,
): DecisionDocumentState => {
  if ("documentUnavailable" in read && read.documentUnavailable) {
    return DECISION_DOCUMENT_STATE.unavailable;
  }
  if (!("documentPending" in read) || !read.documentPending) {
    return DECISION_DOCUMENT_STATE.available;
  }
  // A shared-corpus process is strictly read-side: the only thing that can
  // change a stored document here is the development reparse, and a decision
  // still pending after `hydrate` ran is one it did not apply to.
  if (readsSharedCorpus) {
    return DECISION_DOCUMENT_STATE.unavailable;
  }
  return isDeferredDocumentFetchable({
    adapterKey: read.source.adapterKey,
    documentUrl: read.documentUrl,
    documentPending: read.documentPending,
    documentReadFailed: read.documentReadFailed,
  })
    ? DECISION_DOCUMENT_STATE.pending
    : DECISION_DOCUMENT_STATE.unavailable;
};

/**
 * Gate, read, then hydrate — in that order and for that reason.
 *
 * The gate and every row of the read share one transaction, so the content
 * cannot come from a state the gate did not approve. Hydration performs
 * outbound I/O after that transaction closes, then checks the current gate.
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
  surface,
}: ReadGatedDecisionOptions): Promise<DecisionRead | null> => {
  const prepared = await withRedistributableSubject(
    caseLawDb,
    surface,
    locator,
    async (subject) =>
      await prepareDecisionDocumentRead({ citationsCursor, subject }),
  );

  return prepared === null
    ? null
    : await hydrateDeferredDocument({
        prepared,
        caseLawDb,
        recordDemand: caller === "attributed",
        documentHydration,
      });
};
