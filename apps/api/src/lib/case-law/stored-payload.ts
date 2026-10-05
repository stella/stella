/**
 * One definition of "this decision holds a document", shared by
 * everything that has to decide whether a payload is safe to overwrite,
 * safe to drop, or still worth fetching.
 *
 * The question is asked in three places that must agree — the ingestion
 * refresh, the deferred-document queue, and the column trim — and each
 * of them destroys or re-fetches a document when it gets the answer
 * wrong. It is answered without reading the payload: the text can be
 * megabytes, and two of the three callers ask it inside a loop.
 */

import { notInArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { hasUsableAst } from "@stll/legal-ast/document-ast";

import { caseLawDecisions } from "@/api/db/schema";
import type { CorpusPayload } from "@/api/lib/legal-search/corpus-storage";
import {
  EMPTY_CORPUS_CONTENT_HASHES,
  storedCorpusWriteIsCompleteSql,
} from "@/api/lib/legal-search/corpus-storage";

/**
 * A jsonb array's length, or 0 for anything that is not an array.
 * `jsonb_array_length` raises on a non-array, and these columns hold
 * `{}` (the empty-AST placeholder) as often as they hold a document.
 */
const jsonbArrayLength = (column: SQL | typeof caseLawDecisions.sections) =>
  sql`coalesce(jsonb_array_length(case when jsonb_typeof(${column}) = 'array' then ${column} else '[]'::jsonb end), 0)`;

type DecisionPayloadColumns = Pick<
  typeof caseLawDecisions,
  | "fulltext"
  | "documentAst"
  | "sections"
  | "contentHash"
  | "textS3Key"
  | "normalizedS3Key"
  | "astS3Key"
>;

/**
 * Whether the row's own Postgres columns hold a document.
 *
 * An empty string is the "fetched, and the source had nothing" marker
 * rather than a document, and `{}` is the placeholder an adapter without
 * a parser emits, so neither counts.
 */
const pgPayloadCarriesDocumentFor = ({
  fulltext,
  documentAst,
  sections,
}: Pick<
  DecisionPayloadColumns,
  "fulltext" | "documentAst" | "sections"
>): SQL<boolean> => sql<boolean>`(
  coalesce(${fulltext}, '') <> ''
  or ${jsonbArrayLength(sql`${documentAst} -> 'blocks'`)} > 0
  or ${jsonbArrayLength(sections)} > 0
)`;

export const pgPayloadCarriesDocument =
  pgPayloadCarriesDocumentFor(caseLawDecisions);

/** Whether either storage location holds a readable decision document. */
export const rowHoldsDocumentFor = (
  table: DecisionPayloadColumns,
): SQL<boolean> => sql<boolean>`(
  ${pgPayloadCarriesDocumentFor(table)}
  or (
    ${storedCorpusWriteIsCompleteSql(table)}
    and ${notInArray(table.contentHash, [...EMPTY_CORPUS_CONTENT_HASHES])}
  )
)`;

export const rowHoldsDocument = rowHoldsDocumentFor(caseLawDecisions);

/**
 * Public reads cannot inspect the normalized corpus key. Confirm the readable
 * pointers instead: completed corpus writes persist all keys atomically, and
 * an isolated normalized key is never a confirmed document write.
 */
export const publicRowHoldsDocumentFor = (
  table: Omit<DecisionPayloadColumns, "normalizedS3Key">,
): SQL<boolean> => sql<boolean>`(
  ${pgPayloadCarriesDocumentFor(table)}
  or (
    ${table.textS3Key} is not null
    and ${table.astS3Key} is not null
    and ${table.contentHash} is not null
    and ${notInArray(table.contentHash, [...EMPTY_CORPUS_CONTENT_HASHES])}
  )
)`;

export const publicRowHoldsDocument =
  publicRowHoldsDocumentFor(caseLawDecisions);

/**
 * The same question as `pgPayloadCarriesDocument`, asked of a payload
 * already in hand rather than of a row. The two must agree: this one
 * judges what the trim is about to delete, that one filters rows the
 * trim and the ingestion refresh never load.
 */
export const payloadCarriesDocument = ({
  text,
  sections,
  ast,
}: CorpusPayload): boolean =>
  (text ?? "") !== "" || hasUsableAst(ast) || (sections?.length ?? 0) > 0;

/**
 * Whether a content hash names the payload a metadata-first ingest
 * writes before the document exists. Such objects are present, keyed and
 * readable, and hold nothing — so their existence proves only that the
 * corpus was written to, never that it holds a document.
 */
export const namesEmptyCorpusPayload = (contentHash: string | null): boolean =>
  contentHash !== null && EMPTY_CORPUS_CONTENT_HASHES.includes(contentHash);

/**
 * Whether object storage holds a document for this row: it has been
 * written to, and what it holds is not one of the empty shapes.
 */
export const corpusCarriesDocument = (contentHash: string | null): boolean =>
  contentHash !== null && !namesEmptyCorpusPayload(contentHash);
