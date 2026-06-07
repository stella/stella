import { and, asc, eq, sql } from "drizzle-orm";
import { status } from "elysia";

import type { DocumentAst } from "@stll/case-law/document-ast";

import { caseLawDecisions } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import {
  readCorpusAst,
  readCorpusText,
} from "@/api/handlers/case-law/corpus-storage";
import { hasUsableAst } from "@/api/handlers/case-law/document-ast";
import type { EmptyAst } from "@/api/handlers/case-law/ingestion/adapter";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";

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
      .where(eq(caseLawDecisions.languageGroupKey, languageGroupKey))
      .orderBy(asc(caseLawDecisions.language), asc(caseLawDecisions.id)),
  );
  const dedupedAlternates = dedupeAlternatesByLanguage(alternates);

  return dedupedAlternates.length > 1 ? dedupedAlternates : [];
};

const corpusReadEnabled = (): boolean => envBase.CORPUS_STORAGE_ENABLED;

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
        // fulltext: only as fallback when no AST
        // sections: frontend doesn't use these
      },
      with: {
        source: {
          columns: { id: true, name: true, adapterKey: true },
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

  const languageAlternates = await listPublicDecisionLanguageAlternates({
    caseLawDb,
    languageGroupKey: decision.languageGroupKey,
  });

  // Prefer canonical AST from object storage when corpus storage is
  // enabled; fall back to the Postgres column so a read is never harder
  // than today.
  const documentAst = await resolveAst({
    astS3Key: decision.astS3Key,
    pgAst: decision.documentAst,
    decisionId,
  });

  // Only fetch fulltext if no usable documentAst (fallback).
  let fulltext: string | null = null;
  if (!hasUsableAst(documentAst)) {
    fulltext = await resolveFulltext({
      textS3Key: decision.textS3Key,
      decisionId,
      caseLawDb,
    });
  }

  return {
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
    source: decision.source,
    citationsFrom: decision.citationsFrom,
    citationsTo: decision.citationsTo,
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
  pgAst: DocumentAst | EmptyAst | null;
  decisionId: SafeId<"caseLawDecision">;
};

const resolveAst = async ({
  astS3Key,
  pgAst,
  decisionId,
}: ResolveAstInput): Promise<DocumentAst | EmptyAst | null> => {
  if (!corpusReadEnabled() || astS3Key === null) {
    return pgAst;
  }
  try {
    return await readCorpusAst(astS3Key);
  } catch (error) {
    captureError(error, { decisionId, step: "readDecision.corpusAst" });
    return pgAst;
  }
};

type ResolveFulltextInput = {
  textS3Key: string | null;
  decisionId: SafeId<"caseLawDecision">;
  caseLawDb: CaseLawPublicReadDb;
};

const resolveFulltext = async ({
  textS3Key,
  decisionId,
  caseLawDb,
}: ResolveFulltextInput): Promise<string | null> => {
  if (corpusReadEnabled() && textS3Key !== null) {
    try {
      return await readCorpusText(textS3Key);
    } catch (error) {
      captureError(error, { decisionId, step: "readDecision.corpusText" });
    }
  }
  const fallback = await caseLawDb((tx) =>
    tx.query.caseLawDecisions.findFirst({
      where: { id: { eq: decisionId } },
      columns: { fulltext: true },
    }),
  );
  return fallback?.fulltext ?? null;
};
