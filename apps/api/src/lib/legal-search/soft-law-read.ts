import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";

import type { GuidanceKind } from "@stll/legal-ast/document-kind";

import type { Transaction } from "@/api/db/root";
import {
  softLawDocumentLocators,
  softLawDocuments,
  softLawDocumentVersions,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import { publicLawReadDb } from "@/api/lib/public-law-read-db";

import { softLawBodyVector, softLawTitleVector } from "./soft-law-search-sql";
import {
  hasSoftLawSetting,
  softLawAccessOf,
  type SoftLawReadSurface,
  type SoftLawServingSetting,
  softLawServingSettingOf,
  softLawSurfaceEntries,
} from "./soft-law-serving";
import type { SoftLawMetadata } from "./soft-law-types";
import { SOFT_LAW_AUTHORITIES } from "./soft-law-types";

const SOFT_LAW_HEADLINE_TEXT_CHARS = 20_000;
export const SOFT_LAW_SEARCH_PAGE_SIZE_MAX = 50;
/** Search answers from one bounded statement, so deep pages stay inside the budget. */
const SOFT_LAW_SEARCH_OFFSET_MAX = 1000;

/** What every served result is, stated so a reader cannot take it for case law. */
export const SOFT_LAW_DOCUMENT_CLASS = "regulator_guidance" as const;
export const SOFT_LAW_NATURE_NOTICE =
  "Guidance issued by a regulator. This is not a court decision.";

export const SOFT_LAW_TEXT_STATE = {
  available: "available",
  withheldBySource: "withheld_by_source_setting",
  notExtracted: "not_extracted",
} as const;

type SoftLawReadTransaction = Pick<Transaction, "select">;

const titleVector = softLawTitleVector(softLawDocuments.title);
const bodyVector = softLawBodyVector(softLawDocumentVersions.extractedText);

const tsQuery = (query: string) =>
  sql`websearch_to_tsquery('simple', search_fold(${query}))`;
/** Keeps a query typed with diacritics highlighting the text it matched. */
const headlineQuery = (query: string) =>
  sql`(websearch_to_tsquery('simple', lower(${query})) || ${tsQuery(query)})`;

const currentPublisherUrl = sql<string | null>`(
  SELECT ${softLawDocumentLocators.url}
  FROM ${softLawDocumentLocators}
  WHERE ${softLawDocumentLocators.documentId} = ${softLawDocuments.id}
    AND ${softLawDocumentLocators.state} = 'current'
  ORDER BY ${softLawDocumentLocators.lastSeenAt} DESC
  LIMIT 1
)`;

const documentColumns = {
  id: softLawDocuments.id,
  authority: softLawDocuments.authority,
  jurisdiction: softLawDocuments.jurisdiction,
  kind: softLawDocuments.kind,
  title: softLawDocuments.title,
  statedReference: softLawDocuments.statedReference,
  issuedOn: softLawDocuments.issuedOn,
  validityState: softLawDocuments.validityState,
  validityBasis: softLawDocuments.validityBasis,
  metadata: softLawDocumentVersions.metadata,
  extractionQuality: softLawDocumentVersions.extractionQuality,
  publisherUrl: currentPublisherUrl,
};

type DocumentColumns = {
  id: SafeId<"softLawDocument">;
  authority: string;
  jurisdiction: string;
  kind: GuidanceKind;
  title: string;
  statedReference: string | null;
  issuedOn: string | null;
  validityState: string;
  validityBasis: string;
  metadata: SoftLawMetadata;
  extractionQuality: string;
  publisherUrl: string | null;
};

const servedEnvelope = (
  row: DocumentColumns,
  setting: Exclude<SoftLawServingSetting, { serve: "none" }>,
) => ({
  documentId: row.id,
  documentClass: SOFT_LAW_DOCUMENT_CLASS,
  notice: SOFT_LAW_NATURE_NOTICE,
  issuer: {
    authority: row.authority,
    name: hasSoftLawSetting(row.authority)
      ? SOFT_LAW_AUTHORITIES[row.authority].name
      : row.authority,
    jurisdiction: row.jurisdiction,
  },
  kind: row.kind,
  sourceKind: row.metadata.sourceKind ?? null,
  title: row.title,
  reference: row.statedReference,
  issuedOn: row.issuedOn,
  validity: { state: row.validityState, basis: row.validityBasis },
  language:
    row.metadata.expression?.type === "identified"
      ? row.metadata.expression.language
      : null,
  publisherUrl: row.publisherUrl,
  attribution: {
    ...setting.attribution,
    conditions: [...setting.attribution.conditions],
  },
});

type SearchSoftLawOptions = {
  query: string;
  surface: SoftLawReadSurface;
  limit: number;
  offset: number;
  authority?: string | undefined;
  jurisdiction?: string | undefined;
  kind?: GuidanceKind | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
};

/**
 * One bounded statement: served authorities first, title and body matched
 * through their own expressions, no count. A source that may only show
 * metadata on this surface is matched on its title alone, so its text cannot
 * answer a query.
 */
export const searchSoftLawDocuments = async (
  tx: SoftLawReadTransaction,
  options: SearchSoftLawOptions,
) => {
  const entries = softLawSurfaceEntries(options.surface);
  const textAuthorities = entries
    .filter(({ access }) => access === "text")
    .map(({ authority }) => authority);
  const query = tsQuery(options.query);
  const headline = sql<string | null>`CASE
    WHEN ${inArray(softLawDocuments.authority, textAuthorities)}
      AND ${softLawDocumentVersions.extractedText} IS NOT NULL
      AND to_tsvector('simple'::regconfig, search_fold(left(${softLawDocumentVersions.extractedText}, ${sql.raw(String(SOFT_LAW_HEADLINE_TEXT_CHARS))}))) @@ ${query}
    THEN ts_headline(
      'simple',
      left(${softLawDocumentVersions.extractedText}, ${sql.raw(String(SOFT_LAW_HEADLINE_TEXT_CHARS))}),
      ${headlineQuery(options.query)},
      'MaxFragments=1,MaxWords=35,MinWords=15'
    )
  END`;
  const rows = await tx
    .select({ ...documentColumns, headline })
    .from(softLawDocuments)
    .innerJoin(
      softLawDocumentVersions,
      and(
        eq(softLawDocumentVersions.documentId, softLawDocuments.id),
        isNull(softLawDocumentVersions.observedTo),
      ),
    )
    .where(
      and(
        eq(softLawDocuments.listingState, "listed"),
        inArray(
          softLawDocuments.authority,
          entries.map(({ authority }) => authority),
        ),
        ...entries
          .filter(({ withheldKinds }) => withheldKinds.length > 0)
          .map(
            ({ authority, withheldKinds }) =>
              sql`NOT (${softLawDocuments.authority} = ${authority} AND ${inArray(softLawDocuments.kind, [...withheldKinds])})`,
          ),
        options.authority === undefined
          ? undefined
          : eq(softLawDocuments.authority, options.authority),
        options.jurisdiction === undefined
          ? undefined
          : eq(softLawDocuments.jurisdiction, options.jurisdiction),
        options.kind === undefined
          ? undefined
          : eq(softLawDocuments.kind, options.kind),
        options.dateFrom === undefined
          ? undefined
          : gte(softLawDocuments.issuedOn, options.dateFrom),
        options.dateTo === undefined
          ? undefined
          : lte(softLawDocuments.issuedOn, options.dateTo),
        or(
          sql`${titleVector} @@ ${query}`,
          and(
            inArray(softLawDocuments.authority, textAuthorities),
            sql`${bodyVector} @@ ${query}`,
          ),
        ),
      ),
    )
    .orderBy(
      sql`ts_rank(${titleVector}, ${query}) DESC`,
      sql`${softLawDocuments.issuedOn} DESC NULLS LAST`,
      desc(softLawDocuments.id),
    )
    .limit(options.limit + 1)
    .offset(options.offset);
  const page = rows.slice(0, options.limit);
  const nextOffset = options.offset + options.limit;
  return {
    items: page.flatMap((row) => {
      const setting = softLawServingSettingOf(row.authority);
      const access = softLawAccessOf(setting, {
        surface: options.surface,
        kind: row.kind,
      });
      if (access === "none" || setting.serve === "none") {
        return [];
      }
      return [
        {
          ...servedEnvelope(row, setting),
          access,
          snippet:
            access === "text" && row.headline !== null
              ? row.headline.replaceAll(/<\/?b>/gu, "")
              : null,
        },
      ];
    }),
    nextOffset:
      rows.length > options.limit && nextOffset <= SOFT_LAW_SEARCH_OFFSET_MAX
        ? nextOffset
        : null,
  };
};

type ReadSoftLawOptions = {
  documentId: SafeId<"softLawDocument">;
  surface: SoftLawReadSurface;
};

/** One served document, or `null` when it is unknown or not served on this surface. */
export const readSoftLawDocument = async (
  tx: SoftLawReadTransaction,
  { documentId, surface }: ReadSoftLawOptions,
) => {
  const row = (
    await tx
      .select({
        ...documentColumns,
        extractedText: softLawDocumentVersions.extractedText,
      })
      .from(softLawDocuments)
      .innerJoin(
        softLawDocumentVersions,
        and(
          eq(softLawDocumentVersions.documentId, softLawDocuments.id),
          isNull(softLawDocumentVersions.observedTo),
        ),
      )
      .where(
        and(
          eq(softLawDocuments.id, documentId),
          eq(softLawDocuments.listingState, "listed"),
        ),
      )
      .limit(1)
  ).at(0);
  if (row === undefined) {
    return null;
  }
  const setting = softLawServingSettingOf(row.authority);
  const access = softLawAccessOf(setting, { surface, kind: row.kind });
  if (access === "none" || setting.serve === "none") {
    return null;
  }
  const envelope = servedEnvelope(row, setting);
  if (access === "metadata") {
    return {
      ...envelope,
      access,
      textState: SOFT_LAW_TEXT_STATE.withheldBySource,
      text: null,
    };
  }
  return row.extractedText === null
    ? {
        ...envelope,
        access,
        textState: SOFT_LAW_TEXT_STATE.notExtracted,
        text: null,
      }
    : {
        ...envelope,
        access,
        textState: SOFT_LAW_TEXT_STATE.available,
        text: row.extractedText,
      };
};

/** A search through the public-law reader, inside its request budget. */
export const searchServedSoftLaw = async (options: SearchSoftLawOptions) =>
  await publicLawReadDb(
    async (tx) => await searchSoftLawDocuments(tx, options),
  );

/** A read through the public-law reader, inside its request budget. */
export const readServedSoftLaw = async (options: ReadSoftLawOptions) =>
  await publicLawReadDb(async (tx) => await readSoftLawDocument(tx, options));

/** An offset cursor: the single-statement search has no stable keyset across ranks. */
export const encodeSoftLawCursor = (offset: number) =>
  encodePaginationCursor([offset]);

export const decodeSoftLawCursor = (value: string): number | null => {
  const offset = decodePaginationCursor(value)?.[0];
  return typeof offset === "number" &&
    Number.isInteger(offset) &&
    offset >= 0 &&
    offset <= SOFT_LAW_SEARCH_OFFSET_MAX
    ? offset
    : null;
};
