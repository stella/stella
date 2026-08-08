import { collapseSpacedLetters } from "@stll/text-normalize";

import { isDocumentAst } from "@/api/lib/case-law/document-ast";
import {
  DANGEROUS_CHARS,
  sanitizeMetadata,
  stripDangerousChars,
} from "@/api/lib/legal-search/corpus-sanitize";
import { EMPTY_AST } from "@/api/lib/legal-search/ingestion-types";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Sanitize text fields before DB insertion. Postgres rejects null bytes in
 * text columns. Keeping this at the ingestion boundary means adapters and
 * backfill jobs produce the same canonical representation.
 */
export const sanitizeResult = (result: IngestionResult): IngestionResult => {
  const strip = (value: string | undefined): string | undefined =>
    value ? stripDangerousChars(value) : undefined;

  const DECISION_TYPE_NOISE =
    /česk[áa]\s+republik[ay]|jm[ée]nem\s+republik[ay]/giu;

  const normalizeDecisionType = (
    raw: string | undefined,
  ): string | undefined => {
    if (!raw) {
      return undefined;
    }
    return (
      raw.replace(DECISION_TYPE_NOISE, "").trim().toLowerCase() || undefined
    );
  };

  const deepSanitize = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") {
      const stripped = value
        .replace(DANGEROUS_CHARS, "")
        .replace(/\u00A0/gu, " ");
      return key === "plainText" ? collapseSpacedLetters(stripped) : stripped;
    }
    if (Array.isArray(value)) {
      return value.map((item) => deepSanitize(item));
    }
    if (isRecord(value)) {
      const sanitized: Record<string, unknown> = {};
      for (const [entryKey, entryValue] of Object.entries(value)) {
        sanitized[entryKey] = deepSanitize(entryValue, entryKey);
      }
      return sanitized;
    }
    return value;
  };

  const sanitizedDocumentAst = deepSanitize(result.documentAst);
  const documentAst = isDocumentAst(sanitizedDocumentAst)
    ? sanitizedDocumentAst
    : EMPTY_AST;

  return {
    ...result,
    caseNumber: result.caseNumber.replace(DANGEROUS_CHARS, ""),
    sourceDocumentId: strip(result.sourceDocumentId),
    sourceDocumentIdAliases: result.sourceDocumentIdAliases
      ?.map((identity) => strip(identity))
      .filter((identity): identity is string => identity !== undefined),
    legacySourceUrls: result.legacySourceUrls
      ?.map((url) => strip(url))
      .filter((url): url is string => url !== undefined),
    sheetNumber: strip(result.sheetNumber),
    fulltext: result.fulltext
      ? collapseSpacedLetters(strip(result.fulltext) ?? "")
      : undefined,
    ecli: strip(result.ecli),
    decisionType: normalizeDecisionType(strip(result.decisionType)),
    sourceUrl: strip(result.sourceUrl),
    documentUrl: strip(result.documentUrl),
    metadata: sanitizeMetadata(result.metadata),
    publisherCitedCases: result.publisherCitedCases?.map((cited) =>
      stripDangerousChars(cited),
    ),
    sections: result.sections?.map((section) => ({
      ...section,
      title: section.title === null ? null : stripDangerousChars(section.title),
      text: collapseSpacedLetters(strip(section.text) ?? ""),
    })),
    documentAst,
    sourceRaw: strip(result.sourceRaw),
  };
};
