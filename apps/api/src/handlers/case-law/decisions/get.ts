import { panic, Result, UnhandledException } from "better-result";
import { eq, sql } from "drizzle-orm";
import { status, t } from "elysia";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { caseLawDecisions } from "@/api/db/schema";
import { corpusStorageMode } from "@/api/env-base";
import {
  listIncomingDecisionCitations,
  listOutgoingDecisionCitations,
} from "@/api/handlers/case-law/decisions/citations";
import {
  DECISION_NOT_FOUND,
  type RedistributableDecisionSubject,
} from "@/api/handlers/case-law/decisions/public-subject";
import {
  hasUsableAst,
  omitDerivablePlainText,
} from "@/api/handlers/case-law/document-ast";
import { corpusCarriesDocument } from "@/api/handlers/case-law/stored-payload";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { decisionIdentifierProjection } from "@/api/lib/case-law/decision-identifiers";
import { listPublicDecisionLanguageAlternates } from "@/api/lib/case-law/language-alternates";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { CorpusPayloadUnavailableError } from "@/api/lib/errors/tagged-errors";
import { allowsDerivedAi } from "@/api/lib/legal-search/corpus-source";
import {
  readCorpusAst,
  readCorpusPayloadOrFallback,
  readCorpusText,
  parsePersistedCorpusAst,
} from "@/api/lib/legal-search/corpus-storage";
import type { EmptyAst } from "@/api/lib/legal-search/document-types";
import { LIMITS } from "@/api/lib/limits";
import {
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import {
  definePublicLawSharedQuery,
  PUBLIC_LAW_SHARED_QUERY,
} from "@/api/lib/public-law-shared-query";

const corpusReadEnabled = (): boolean => corpusStorageMode !== "off";

export const readDecisionTextColumnWritten = definePublicLawSharedQuery(
  PUBLIC_LAW_SHARED_QUERY.caseLawDecisionTextPresence,
  async (
    tx: CaseLawPublicReadTransaction,
    decisionId: SafeId<"caseLawDecision">,
  ): Promise<boolean | null> => {
    const [row] = await tx
      .select({
        written: sql<boolean>`${caseLawDecisions.fulltext} IS NOT NULL`,
      })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, decisionId))
      .limit(1);
    return row?.written ?? null;
  },
);

export const readDecisionQuerySchema = t.Object({
  citationsCursor: t.Optional(tPaginationCursor()),
});

type ReadDecisionOptions = {
  citationsCursor?: string | null | undefined;
  /**
   * Gated upstream, and the only database handle this read gets: its rows
   * come from the transaction that approved it.
   */
  subject: RedistributableDecisionSubject;
};

const CITATION_STREAM_CURSOR_STATUS = {
  CONTINUE: "continue",
  EXHAUSTED: "exhausted",
  START: "start",
} as const;

type CitationStreamCursor =
  | { status: typeof CITATION_STREAM_CURSOR_STATUS.START }
  | { status: typeof CITATION_STREAM_CURSOR_STATUS.EXHAUSTED }
  | {
      after: string;
      status: typeof CITATION_STREAM_CURSOR_STATUS.CONTINUE;
    };

type DecisionCitationCursorState = {
  from: CitationStreamCursor;
  to: CitationStreamCursor;
};

type CitationStreamNextCursor = Exclude<
  CitationStreamCursor,
  { status: typeof CITATION_STREAM_CURSOR_STATUS.START }
>;

type DecisionCitationNextCursorState = {
  from: CitationStreamNextCursor;
  to: CitationStreamNextCursor;
};

const decodeCitationStreamCursor = (
  value: unknown,
): CitationStreamNextCursor | null => {
  if (value === null) {
    return { status: CITATION_STREAM_CURSOR_STATUS.EXHAUSTED };
  }
  if (typeof value === "string") {
    return { after: value, status: CITATION_STREAM_CURSOR_STATUS.CONTINUE };
  }
  return null;
};

export const decodeDecisionCitationCursor = (
  cursor: string | null | undefined,
): DecisionCitationCursorState | null => {
  if (cursor === undefined) {
    return {
      from: { status: CITATION_STREAM_CURSOR_STATUS.START },
      to: { status: CITATION_STREAM_CURSOR_STATUS.START },
    };
  }
  if (cursor === null) {
    return {
      from: { status: CITATION_STREAM_CURSOR_STATUS.EXHAUSTED },
      to: { status: CITATION_STREAM_CURSOR_STATUS.EXHAUSTED },
    };
  }

  const parts = decodePaginationCursor(cursor);
  if (parts?.length !== 2) {
    return null;
  }

  const from = decodeCitationStreamCursor(parts.at(0));
  const to = decodeCitationStreamCursor(parts.at(1));
  if (from === null || to === null) {
    return null;
  }
  return { from, to };
};

const encodeCitationStreamCursor = (
  cursor: CitationStreamNextCursor,
): string | null => {
  switch (cursor.status) {
    case CITATION_STREAM_CURSOR_STATUS.CONTINUE:
      return cursor.after;
    case CITATION_STREAM_CURSOR_STATUS.EXHAUSTED:
      return null;
    default: {
      const exhaustive: never = cursor;
      return exhaustive;
    }
  }
};

const citationStreamCursorFromNext = (
  cursor: string | null,
): CitationStreamNextCursor =>
  cursor === null
    ? { status: CITATION_STREAM_CURSOR_STATUS.EXHAUSTED }
    : { after: cursor, status: CITATION_STREAM_CURSOR_STATUS.CONTINUE };

const citationPageCursor = (
  cursor: CitationStreamCursor,
): string | undefined =>
  cursor.status === CITATION_STREAM_CURSOR_STATUS.CONTINUE
    ? cursor.after
    : undefined;

export const encodeDecisionCitationCursor = ({
  from,
  to,
}: DecisionCitationNextCursorState): string | null => {
  if (
    from.status === CITATION_STREAM_CURSOR_STATUS.EXHAUSTED &&
    to.status === CITATION_STREAM_CURSOR_STATUS.EXHAUSTED
  ) {
    return null;
  }
  return encodePaginationCursor([
    encodeCitationStreamCursor(from),
    encodeCitationStreamCursor(to),
  ]);
};

const emptyCitationPage = () => ({
  items: [],
  limit: LIMITS.caseLawDecisionCitationPageSize,
  nextCursor: null,
});

export const readDecisionHandler = definePublicLawSharedQuery(
  PUBLIC_LAW_SHARED_QUERY.caseLawDecisionRead,
  async ({
    citationsCursor,
    subject: { id: decisionId, tx },
  }: ReadDecisionOptions) => {
    const citationCursors = decodeDecisionCitationCursor(citationsCursor);
    if (citationCursors === null) {
      return status(400, { message: "Invalid cursor" });
    }

    const decision = await tx.query.caseLawDecisions.findFirst({
      where: { id: { eq: decisionId } },
      columns: {
        id: true,
        caseNumber: true,
        slug: true,
        ecli: true,
        court: true,
        country: true,
        language: true,
        languageGroupKey: true,
        decisionDate: true,
        decisionType: true,
        documentAst: true,
        sections: true,
        sourceUrl: true,
        documentUrl: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
        // Object-storage keys: never returned to the client, only used
        // to fetch canonical payloads when corpus storage is enabled.
        astS3Key: true,
        textS3Key: true,
        contentHash: true,
        redactedAt: true,
        // fulltext: only as fallback when no AST
      },
      with: {
        identifiers: {
          columns: { type: true, value: true },
        },
        source: {
          // descriptor: only for `allowsDerivedAi` below, never returned to
          // the client. Redistribution was decided when the subject was
          // resolved.
          columns: { id: true, name: true, adapterKey: true, descriptor: true },
        },
      },
    });

    if (!decision) {
      // The subject existed moments ago; a redaction can race the read.
      return status(404, DECISION_NOT_FOUND);
    }

    const source =
      decision.source ?? panic("Case-law decision has no source relation");
    const identifiers = decisionIdentifierProjection(decision.identifiers, {
      caseNumber: decision.caseNumber,
      ecli: decision.ecli,
    });

    const [languageAlternates, citationsFromPage, citationsToPage] =
      await Promise.all([
        listPublicDecisionLanguageAlternates({
          tx,
          languageGroupKey: decision.languageGroupKey,
        }),
        citationCursors.from.status === CITATION_STREAM_CURSOR_STATUS.EXHAUSTED
          ? emptyCitationPage()
          : listOutgoingDecisionCitations({
              tx,
              cursor: citationPageCursor(citationCursors.from),
              decisionId,
            }),
        citationCursors.to.status === CITATION_STREAM_CURSOR_STATUS.EXHAUSTED
          ? emptyCitationPage()
          : listIncomingDecisionCitations({
              tx,
              cursor: citationPageCursor(citationCursors.to),
              decisionId,
            }),
      ]);

    if (!("items" in citationsFromPage)) {
      return citationsFromPage;
    }
    if (!("items" in citationsToPage)) {
      return citationsToPage;
    }
    const citationsNextCursor = encodeDecisionCitationCursor({
      from: citationStreamCursorFromNext(citationsFromPage.nextCursor),
      to: citationStreamCursorFromNext(citationsToPage.nextCursor),
    });

    // Prefer canonical AST from object storage when corpus storage is
    // enabled; fall back to the Postgres column so a read is never harder
    // than today.
    const astRead = await resolveAst({
      astS3Key: decision.astS3Key,
      contentHash: decision.contentHash,
      pgAst: decision.documentAst,
      decisionId,
    });
    const storedAst = astRead.payload;
    const astIsUsable = hasUsableAst(storedAst);
    // Block text a reader can rebuild from the `inlines` beside it does
    // not travel: ingestion derives every `plainText` with
    // `projectPlainText`, and `parseDocumentAst` refills them on arrival.
    const documentAst = astIsUsable
      ? omitDerivablePlainText(storedAst)
      : storedAst;

    // Only fetch fulltext if no usable documentAst (fallback).
    let fulltext: string | null = null;
    let corpusPayloadUnavailable = astRead.unavailable;
    if (!astIsUsable) {
      const textRead = await resolveFulltext({
        textS3Key: decision.textS3Key,
        contentHash: decision.contentHash,
        decisionId,
        tx,
      });
      fulltext = textRead.payload;
      corpusPayloadUnavailable =
        corpusPayloadUnavailable || textRead.unavailable;
    }

    // Nothing readable resolved, and there is a document to fetch. Which
    // of the two that is decides everything downstream: a decision nobody
    // has fetched yet is worth fetching for this reader
    // (`get-deferred-document.ts` turns `documentPending` into that
    // fetch), while one the source had nothing for is terminal, and
    // re-entering the fetch path on every view would cost a claim that can
    // never succeed. Kept as derived booleans rather than a call so this
    // module stays a read.
    const { documentPending, documentReadFailed, documentUnavailable } =
      decision.redactedAt === null
        ? await resolveDocumentState({
            hasReadableDocument: astIsUsable || Boolean(fulltext),
            corpusPayloadUnavailable,
            documentUrl: decision.documentUrl,
            corpusServed:
              corpusReadEnabled() &&
              decision.textS3Key !== null &&
              decision.contentHash !== null,
            contentHash: decision.contentHash,
            pgAstPresent: decision.documentAst !== null,
            resolvedFulltext: fulltext,
            readTextColumnWritten: async () =>
              await readDecisionTextColumnWritten(tx, decisionId),
          })
        : {
            documentPending: false,
            documentReadFailed: false,
            documentUnavailable: false,
          };

    return {
      documentPending,
      documentReadFailed,
      documentUnavailable,
      id: decision.id,
      caseNumber: decision.caseNumber,
      slug: decision.slug,
      ecli: decision.ecli,
      identifiers,
      court: decision.court,
      country: decision.country,
      language: decision.language,
      languageGroupKey: decision.languageGroupKey,
      decisionDate: decision.decisionDate,
      decisionType: decision.decisionType,
      documentAst,
      sections: decision.sections,
      sourceUrl: decision.sourceUrl,
      documentUrl: decision.documentUrl,
      metadata: decision.metadata,
      createdAt: decision.createdAt,
      updatedAt: decision.updatedAt,
      source: {
        id: source.id,
        name: source.name,
        adapterKey: source.adapterKey,
        // Derived licence bit (never the raw descriptor): AI consumers
        // must not feed the full text to a model when this is false.
        allowsDerivedAi: allowsDerivedAi(source.descriptor),
      },
      citationsFrom: citationsFromPage.items,
      citationsTo: citationsToPage.items,
      citationsNextCursor,
      languageAlternates,
      fulltext,
    };
  },
);

/**
 * A payload the read tried to resolve, and whether object storage
 * refused it outright.
 *
 * `readCorpusPayloadOrFallback` throws when the object is unreadable and
 * the row has no Postgres copy, which is every trimmed canonical row. It
 * throws so that a corpus outage cannot be served as a decision with no
 * body — but a public read has a third answer for exactly that, and it
 * is not an error: the document is not readable right now. Failing the
 * read instead takes the metadata, the citation graph and the case
 * number down with the body, for a decision the reader could otherwise
 * still recognise and cite.
 */
type CorpusReadOutcome<TPayload> = {
  payload: TPayload | null;
  unavailable: boolean;
};

/**
 * Contain an object-storage refusal, and only that. Anything else is a
 * defect in the read and still fails it.
 */
const containPayloadUnavailable = async <TPayload>(
  read: () => Promise<TPayload | null>,
  decisionId: SafeId<"caseLawDecision">,
): Promise<CorpusReadOutcome<TPayload>> => {
  const outcome = await Result.tryPromise(read);
  if (Result.isOk(outcome)) {
    return { payload: outcome.value, unavailable: false };
  }

  // `Result.tryPromise` reports a rejection as an `UnhandledException`
  // carrying the original as its cause.
  const raised =
    outcome.error instanceof UnhandledException
      ? outcome.error.cause
      : outcome.error;
  if (!CorpusPayloadUnavailableError.is(raised)) {
    throw raised;
  }

  captureError(raised, {
    decisionId,
    step: "readDecision.corpusPayloadUnavailable",
  });
  return { payload: null, unavailable: true };
};

type ResolveAstInput = {
  astS3Key: string | null;
  contentHash: string | null;
  pgAst: DocumentAst | EmptyAst | null;
  decisionId: SafeId<"caseLawDecision">;
};

const resolveAst = async ({
  astS3Key,
  contentHash,
  pgAst,
  decisionId,
}: ResolveAstInput): Promise<CorpusReadOutcome<DocumentAst | EmptyAst>> => {
  if (!corpusReadEnabled() || astS3Key === null || contentHash === null) {
    return { payload: parsePersistedCorpusAst(pgAst), unavailable: false };
  }
  return await containPayloadUnavailable(
    async () =>
      await readCorpusPayloadOrFallback({
        documentId: decisionId,
        key: astS3Key,
        step: "readDecision.corpusAst",
        read: async () => await readCorpusAst(astS3Key),
        fallback: () => parsePersistedCorpusAst(pgAst),
      }),
    decisionId,
  );
};

export type ResolveDocumentStateInput = {
  /** Whether the read resolved something a reader can actually read. */
  hasReadableDocument: boolean;
  /**
   * Whether object storage refused a payload this row is served from.
   * A trimmed canonical row has no Postgres copy to fall back to, so
   * there is nothing readable and nothing that says the source had
   * nothing either.
   */
  corpusPayloadUnavailable: boolean;
  documentUrl: string | null;
  /** Whether the payload above came from object storage. */
  corpusServed: boolean;
  contentHash: string | null;
  /**
   * Whether the row's own `document_ast` column still holds anything.
   * A trimmed, corpus-served decision has every payload column nulled.
   */
  pgAstPresent: boolean;
  resolvedFulltext: string | null;
  /**
   * Reads the row's own text column as a boolean — has it ever been
   * fetched — without pulling the document across. Called only where
   * nothing else can tell the two empty states apart.
   */
  readTextColumnWritten: () => Promise<boolean | null>;
};

type DocumentState = {
  documentPending: boolean;
  documentUnavailable: boolean;
  /**
   * Whether the pending state above is an object-storage failure rather
   * than a document nobody has fetched yet. The reader sees the same
   * thing either way, but the read-through must not: the publisher fetch
   * cannot repair a row whose payload is already stored, and its store
   * refuses a row that carries a corpus document, so treating an outage
   * as unfetched work costs an outbound download per affected decision
   * and holds the read for the fetch budget while it does.
   */
  documentReadFailed: boolean;
};

/**
 * Whether this decision's document is still to come, or is not coming.
 *
 * The row says which: a NULL `fulltext` has never been fetched, an empty
 * one was fetched and the source had nothing. Where the payload came
 * from the Postgres column that distinction is already in hand. Where
 * object storage served it, it is not — a metadata-first ingest writes
 * an empty payload, and an empty payload reads back as an empty string
 * whichever of the two states wrote it — so the column is re-read as a
 * boolean, without the document itself, and only where the content hash
 * says the objects are one of those empty shapes.
 *
 * The states this has to separate, and what each answers:
 *
 * | pg text | pg ast | content hash | resolved | state       |
 * | ------- | ------ | ------------ | -------- | ----------- |
 * | NULL    | any    | none         | nothing  | pending     |
 * | ''      | any    | none         | ''       | unavailable |
 * | text    | any    | none         | document | served      |
 * | NULL    | any    | empty shape  | ''       | pending     |
 * | ''      | any    | empty shape  | ''       | unavailable |
 * | NULL    | NULL   | row-specific | document | served      |
 * | text    | any    | row-specific | document | served      |
 * | NULL    | present| row-specific | ''       | pending     |
 * | any     | any    | any          | refused  | pending     |
 *
 * The sixth row is a trimmed canonical decision: its columns are empty
 * by design and object storage holds the document, so it is neither
 * pending nor unavailable — unless the payload did not arrive, which is
 * the `corpusPayloadUnavailable` case. That one reads as pending: there
 * is genuinely nothing to show, the row is not the terminal
 * "source had nothing" state, and the alternative is failing the read
 * and losing the metadata, citations and case number along with the
 * body. It stays pending rather than unavailable because the outage is
 * the object store's, not the court's, so the next read may well serve
 * the document.
 *
 * The last row is what separates that from a decision whose objects
 * merely mirror an empty payload. A row-specific hash proves only that
 * the objects are this row's, not that they hold anything: an empty
 * DocumentAst envelope carries the decision's own metadata and hashes
 * to a value no constant can name. The trim is what nulls the columns,
 * and it refuses a row whose objects do not hold what the columns hold,
 * so a surviving AST artifact means the corpus copy is verbatim empty
 * rather than served — the same discriminator the queue's pending gate
 * uses.
 */
export const resolveDocumentState = async ({
  hasReadableDocument,
  corpusPayloadUnavailable,
  documentUrl,
  corpusServed,
  contentHash,
  pgAstPresent,
  resolvedFulltext,
  readTextColumnWritten,
}: ResolveDocumentStateInput): Promise<DocumentState> => {
  const settled = { documentReadFailed: false, documentUnavailable: false };
  if (hasReadableDocument) {
    return { ...settled, documentPending: false };
  }

  // Ahead of every column test, including "nothing to fetch": with the
  // payload refused, the resolved text is null because the read could
  // not get it, not because the row was never fetched, and no column
  // can tell the two apart. Reporting "neither" here would render a
  // decision with no body as a complete one.
  if (corpusPayloadUnavailable) {
    return {
      documentPending: true,
      documentReadFailed: true,
      documentUnavailable: false,
    };
  }

  if (documentUrl === null) {
    return { ...settled, documentPending: false };
  }

  if (!corpusServed) {
    return {
      documentPending: resolvedFulltext === null,
      documentReadFailed: false,
      documentUnavailable: resolvedFulltext === "",
    };
  }

  if (corpusCarriesDocument(contentHash) && !pgAstPresent) {
    return { ...settled, documentPending: false };
  }

  const written = await readTextColumnWritten();

  return {
    documentPending: written === false,
    documentReadFailed: false,
    documentUnavailable: written === true,
  };
};

type ResolveFulltextInput = {
  textS3Key: string | null;
  contentHash: string | null;
  decisionId: SafeId<"caseLawDecision">;
  tx: CaseLawPublicReadTransaction;
};

const resolveFulltext = async ({
  textS3Key,
  contentHash,
  decisionId,
  tx,
}: ResolveFulltextInput): Promise<CorpusReadOutcome<string>> => {
  const postgresFulltext = async (): Promise<string | null> => {
    const fallback = await tx.query.caseLawDecisions.findFirst({
      where: { id: { eq: decisionId } },
      columns: { fulltext: true },
    });
    return fallback?.fulltext ?? null;
  };

  if (corpusReadEnabled() && textS3Key !== null && contentHash !== null) {
    return await containPayloadUnavailable(
      async () =>
        await readCorpusPayloadOrFallback({
          documentId: decisionId,
          key: textS3Key,
          step: "readDecision.corpusText",
          read: async () => await readCorpusText(textS3Key),
          fallback: postgresFulltext,
        }),
      decisionId,
    );
  }

  return { payload: await postgresFulltext(), unavailable: false };
};
