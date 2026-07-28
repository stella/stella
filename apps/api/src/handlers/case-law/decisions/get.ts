import { panic } from "better-result";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { status } from "elysia";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { corpusStorageMode } from "@/api/env-base";
import {
  allowsDerivedAi,
  isRedistributable,
} from "@/api/handlers/case-law/corpus-source";
import {
  readCorpusAst,
  readCorpusPayloadOrFallback,
  readCorpusText,
} from "@/api/handlers/case-law/corpus-storage";
import { hasUsableAst } from "@/api/handlers/case-law/document-ast";
import type { EmptyAst } from "@/api/handlers/case-law/ingestion/adapter";
import { redistributableCaseLawSource } from "@/api/handlers/case-law/redistribution";
import { corpusCarriesDocument } from "@/api/handlers/case-law/stored-payload";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { LIMITS } from "@/api/lib/limits";

type PublicDecisionLanguageAlternate = {
  caseNumber: string;
  country: string;
  court: string;
  decisionDate: string | null;
  id: string;
  language: string;
  slug: string | null;
  updatedAt: Date;
};

const LANGUAGE_SEGMENT_REGEX = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/u;

const normalizePublicDecisionLanguage = (
  language: string | undefined,
): string | null => {
  const normalized = language?.trim().toLowerCase().replace(/_/gu, "-");
  if (!normalized) {
    return null;
  }

  return LANGUAGE_SEGMENT_REGEX.test(normalized) ? normalized : null;
};

const dedupeAlternatesByLanguage = (
  alternates: readonly PublicDecisionLanguageAlternate[],
): PublicDecisionLanguageAlternate[] => {
  const seenLanguages = new Set<string>();
  const dedupedAlternates: PublicDecisionLanguageAlternate[] = [];

  for (const alternate of alternates) {
    const normalizedLanguage = normalizePublicDecisionLanguage(
      alternate.language,
    );
    if (normalizedLanguage === null || seenLanguages.has(normalizedLanguage)) {
      continue;
    }

    seenLanguages.add(normalizedLanguage);
    dedupedAlternates.push(alternate);
  }

  return dedupedAlternates;
};

const listPublicDecisionLanguageAlternates = async ({
  caseLawDb,
  languageGroupKey,
}: {
  caseLawDb: CaseLawPublicReadDb;
  languageGroupKey: string | null;
}): Promise<PublicDecisionLanguageAlternate[]> => {
  if (languageGroupKey === null) {
    return [];
  }

  const alternates = await caseLawDb((tx) =>
    tx
      .select({
        id: caseLawDecisions.id,
        caseNumber: caseLawDecisions.caseNumber,
        slug: caseLawDecisions.slug,
        country: caseLawDecisions.country,
        court: caseLawDecisions.court,
        decisionDate: caseLawDecisions.decisionDate,
        language: caseLawDecisions.language,
        updatedAt: caseLawDecisions.updatedAt,
      })
      .from(caseLawDecisions)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawDecisions.sourceId),
      )
      .where(
        and(
          eq(caseLawDecisions.languageGroupKey, languageGroupKey),
          redistributableCaseLawSource,
        ),
      )
      .orderBy(asc(caseLawDecisions.language), asc(caseLawDecisions.id))
      // Bound the per-group read: a languageGroupKey normally holds only this
      // decision's language variants, but a malformed/over-merged key could
      // match many rows and make this public read unbounded — the sitemap path
      // caps the same read for the same reason. Capped variants still dedupe.
      .limit(LIMITS.caseLawLanguageAlternatesPerGroupMax),
  );
  const dedupedAlternates = dedupeAlternatesByLanguage(alternates);

  return dedupedAlternates.length > 1 ? dedupedAlternates : [];
};

const corpusReadEnabled = (): boolean => corpusStorageMode !== "off";

export const readDecisionHandler = async (
  decisionId: SafeId<"caseLawDecision">,
  caseLawDb: CaseLawPublicReadDb,
) => {
  const decision = await caseLawDb((tx) =>
    tx.query.caseLawDecisions.findFirst({
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
        // fulltext: only as fallback when no AST
        // sections: frontend doesn't use these
      },
      with: {
        source: {
          // descriptor: only for the redistribution gate below,
          // never returned to the client.
          columns: { id: true, name: true, adapterKey: true, descriptor: true },
        },
        citationsFrom: {
          columns: {
            id: true,
            citationText: true,
            citedDecisionId: true,
            sectionIndex: true,
          },
        },
        citationsTo: {
          columns: {
            id: true,
            citationText: true,
            citingDecisionId: true,
            sectionIndex: true,
          },
        },
      },
    }),
  );

  if (!decision) {
    return status(404, { message: "Decision not found" });
  }

  const source =
    decision.source ?? panic("Case-law decision has no source relation");
  if (!isRedistributable(source.descriptor)) {
    return status(404, { message: "Decision not found" });
  }

  const languageAlternates = await listPublicDecisionLanguageAlternates({
    caseLawDb,
    languageGroupKey: decision.languageGroupKey,
  });

  // Citations may point at decisions from non-redistributable sources;
  // drop those so the response cannot leak restricted decisions' ids.
  // Unresolved citations (null citedDecisionId) carry only text and stay.
  const relatedIdCandidates = decision.citationsFrom
    .map((citation) => citation.citedDecisionId)
    .concat(decision.citationsTo.map((citation) => citation.citingDecisionId));
  const relatedDecisionIds = [
    ...new Set(relatedIdCandidates.filter((value) => value !== null)),
  ];
  const redistributableRelatedIds = new Set(
    relatedDecisionIds.length === 0
      ? []
      : (
          await caseLawDb((tx) =>
            tx
              .select({ id: caseLawDecisions.id })
              .from(caseLawDecisions)
              .innerJoin(
                caseLawSources,
                eq(caseLawSources.id, caseLawDecisions.sourceId),
              )
              .where(
                and(
                  inArray(caseLawDecisions.id, relatedDecisionIds),
                  redistributableCaseLawSource,
                ),
              ),
          )
        ).map((row) => row.id),
  );
  const citationsFrom = decision.citationsFrom.filter(
    (citation) =>
      citation.citedDecisionId === null ||
      redistributableRelatedIds.has(citation.citedDecisionId),
  );
  const citationsTo = decision.citationsTo.filter((citation) =>
    redistributableRelatedIds.has(citation.citingDecisionId),
  );

  // Prefer canonical AST from object storage when corpus storage is
  // enabled; fall back to the Postgres column so a read is never harder
  // than today.
  const documentAst = await resolveAst({
    astS3Key: decision.astS3Key,
    contentHash: decision.contentHash,
    pgAst: decision.documentAst,
    decisionId,
  });

  // Only fetch fulltext if no usable documentAst (fallback).
  let fulltext: string | null = null;
  if (!hasUsableAst(documentAst)) {
    fulltext = await resolveFulltext({
      textS3Key: decision.textS3Key,
      contentHash: decision.contentHash,
      decisionId,
      caseLawDb,
    });
  }

  // Nothing readable resolved, and there is a document to fetch. Which
  // of the two that is decides everything downstream: a decision nobody
  // has fetched yet is worth fetching for this reader
  // (`get-deferred-document.ts` turns `documentPending` into that
  // fetch), while one the source had nothing for is terminal, and
  // re-entering the fetch path on every view would cost a claim that can
  // never succeed. Kept as derived booleans rather than a call so this
  // module stays a read.
  const { documentPending, documentUnavailable } = await resolveDocumentState({
    hasReadableDocument: hasUsableAst(documentAst) || Boolean(fulltext),
    documentUrl: decision.documentUrl,
    corpusServed:
      corpusReadEnabled() &&
      decision.textS3Key !== null &&
      decision.contentHash !== null,
    contentHash: decision.contentHash,
    pgAstPresent: decision.documentAst !== null,
    resolvedFulltext: fulltext,
    readTextColumnWritten: async () => {
      const [row] = await caseLawDb((tx) =>
        tx
          .select({
            written: sql<boolean>`${caseLawDecisions.fulltext} IS NOT NULL`,
          })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.id, decisionId))
          .limit(1),
      );
      return row?.written ?? null;
    },
  });

  return {
    documentPending,
    documentUnavailable,
    id: decision.id,
    caseNumber: decision.caseNumber,
    slug: decision.slug,
    ecli: decision.ecli,
    court: decision.court,
    country: decision.country,
    language: decision.language,
    languageGroupKey: decision.languageGroupKey,
    decisionDate: decision.decisionDate,
    decisionType: decision.decisionType,
    documentAst,
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
    citationsFrom,
    citationsTo,
    languageAlternates,
    fulltext,
  };
};

export const readDecisionBySlugHandler = async (
  slug: string,
  caseLawDb: CaseLawPublicReadDb,
  language?: string,
) => {
  const normalizedLanguage = normalizePublicDecisionLanguage(language);
  if (language !== undefined && normalizedLanguage === null) {
    return status(404, { message: "Decision not found" });
  }

  const decision = await caseLawDb((tx) =>
    tx
      .select({ id: caseLawDecisions.id })
      .from(caseLawDecisions)
      .where(
        normalizedLanguage
          ? and(
              eq(caseLawDecisions.slug, slug),
              sql`replace(lower(${caseLawDecisions.language}), '_', '-') = ${normalizedLanguage}`,
            )
          : eq(caseLawDecisions.slug, slug),
      )
      .limit(1),
  );

  const firstDecision = decision.at(0);
  if (!firstDecision) {
    return status(404, { message: "Decision not found" });
  }

  return await readDecisionHandler(firstDecision.id, caseLawDb);
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
}: ResolveAstInput): Promise<DocumentAst | EmptyAst | null> => {
  if (!corpusReadEnabled() || astS3Key === null || contentHash === null) {
    return pgAst;
  }
  return await readCorpusPayloadOrFallback({
    documentId: decisionId,
    key: astS3Key,
    step: "readDecision.corpusAst",
    read: async () => await readCorpusAst(astS3Key),
    fallback: () => pgAst,
  });
};

export type ResolveDocumentStateInput = {
  /** Whether the read resolved something a reader can actually read. */
  hasReadableDocument: boolean;
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
 *
 * The sixth row is a trimmed canonical decision: its columns are empty
 * by design and object storage holds the document, so it is neither
 * pending nor unavailable — and if its payload failed to arrive, that is
 * an object-storage failure the read raises rather than a document
 * waiting to be fetched.
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
  documentUrl,
  corpusServed,
  contentHash,
  pgAstPresent,
  resolvedFulltext,
  readTextColumnWritten,
}: ResolveDocumentStateInput): Promise<DocumentState> => {
  if (hasReadableDocument || documentUrl === null) {
    return { documentPending: false, documentUnavailable: false };
  }

  if (!corpusServed) {
    return {
      documentPending: resolvedFulltext === null,
      documentUnavailable: resolvedFulltext === "",
    };
  }

  if (corpusCarriesDocument(contentHash) && !pgAstPresent) {
    return { documentPending: false, documentUnavailable: false };
  }

  const written = await readTextColumnWritten();

  return {
    documentPending: written === false,
    documentUnavailable: written === true,
  };
};

type ResolveFulltextInput = {
  textS3Key: string | null;
  contentHash: string | null;
  decisionId: SafeId<"caseLawDecision">;
  caseLawDb: CaseLawPublicReadDb;
};

const resolveFulltext = async ({
  textS3Key,
  contentHash,
  decisionId,
  caseLawDb,
}: ResolveFulltextInput): Promise<string | null> => {
  const postgresFulltext = async (): Promise<string | null> => {
    const fallback = await caseLawDb((tx) =>
      tx.query.caseLawDecisions.findFirst({
        where: { id: { eq: decisionId } },
        columns: { fulltext: true },
      }),
    );
    return fallback?.fulltext ?? null;
  };

  if (corpusReadEnabled() && textS3Key !== null && contentHash !== null) {
    return await readCorpusPayloadOrFallback({
      documentId: decisionId,
      key: textS3Key,
      step: "readDecision.corpusText",
      read: async () => await readCorpusText(textS3Key),
      fallback: postgresFulltext,
    });
  }

  return await postgresFulltext();
};
