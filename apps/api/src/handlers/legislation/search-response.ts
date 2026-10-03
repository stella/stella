import { panic } from "better-result";
import type { Static } from "elysia";

import {
  LEGISLATION_SEARCH_MATCH_TYPES,
  SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET,
  SEARCH_TOTAL_NOT_COUNTED,
} from "@stll/api-contract/search";

import type { searchLegislationSuccessResponseSchema } from "@/api/handlers/legislation/search-schema";
import { CORPUS_SEARCH_CURSOR_WITH_PHASE_MAX_LENGTH } from "@/api/lib/legal-search/corpus-search-cursor";
import { LIMITS } from "@/api/lib/limits";
import {
  truncateTextBytes,
  truncateHeadlineBytes,
  nullableText,
} from "@/api/lib/search/response-text-bounds";

// The response projection owns display truncation; corpus storage retains the
// official text. Applying it after retrieval keeps both backends identical.
type LegislationSearchHit = Static<
  typeof searchLegislationSuccessResponseSchema
>["items"][number];
type TextField = {
  [Key in keyof LegislationSearchHit]: LegislationSearchHit[Key] extends
    | string
    | null
    ? Key
    : never;
}[keyof LegislationSearchHit];

const textBytes = LIMITS.legislationSearchTextBytes satisfies Record<
  TextField,
  number
>;

export const projectLegislationSearchHit = (
  hit: LegislationSearchHit,
): LegislationSearchHit => ({
  match: hit.match,
  documentId: truncateTextBytes(hit.documentId, textBytes.documentId),
  eli: truncateTextBytes(hit.eli, textBytes.eli),
  slug: nullableText(hit.slug, textBytes.slug),
  title: truncateTextBytes(hit.title, textBytes.title),
  country: truncateTextBytes(hit.country, textBytes.country),
  language: truncateTextBytes(hit.language, textBytes.language),
  documentType: nullableText(hit.documentType, textBytes.documentType),
  status: truncateTextBytes(hit.status, textBytes.status),
  effectiveDate: nullableText(hit.effectiveDate, textBytes.effectiveDate),
  sourceUrl: nullableText(hit.sourceUrl, textBytes.sourceUrl),
  headline:
    hit.headline === null
      ? null
      : truncateHeadlineBytes(hit.headline, textBytes.headline),
  score: hit.score,
});

const longestMatchType =
  LEGISLATION_SEARCH_MATCH_TYPES.toSorted(
    (left, right) => right.length - left.length,
  ).at(0) ?? panic("Legislation search must declare a match type");

const emptyHit = {
  match: { type: longestMatchType },
  documentId: "",
  eli: "",
  slug: "",
  title: "",
  country: "",
  language: "",
  documentType: "",
  status: "",
  effectiveDate: "",
  sourceUrl: "",
  headline: "",
  // A finite JSON number occupies at most 25 ASCII bytes, including sign,
  // decimal point and exponent. Reserve its full width below.
  score: 0,
} satisfies LegislationSearchHit;

const JSON_NUMBER_MAX_BYTES = 25;
const JSON_ESCAPED_UTF8_BYTE_MAX_BYTES = 6;
const nullableFields = Object.values(emptyHit).filter(
  (value) => value === "",
).length;
const hitBytes =
  Buffer.byteLength(JSON.stringify(emptyHit), "utf-8") +
  Object.values(textBytes).reduce((sum, limit) => sum + limit, 0) *
    JSON_ESCAPED_UTF8_BYTE_MAX_BYTES +
  nullableFields * ("null".length - JSON.stringify("").length) +
  JSON_NUMBER_MAX_BYTES -
  1;

// Derived from per-field bounds and the actual envelope's punctuation/keys;
// control characters cost six JSON bytes for each original UTF-8 byte.
export const PUBLIC_LEGISLATION_SEARCH_RESPONSE_MAX_BYTES =
  Buffer.byteLength(
    JSON.stringify({
      items: Array.from(
        { length: LIMITS.publicStatuteSearchPageSizeMax },
        () => null,
      ),
      nextCursor: "",
      // The longest pagination outcome the schema admits.
      paginationOutcome: SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET,
      total: SEARCH_TOTAL_NOT_COUNTED,
    }),
    "utf-8",
  ) +
  LIMITS.publicStatuteSearchPageSizeMax * (hitBytes - "null".length) +
  CORPUS_SEARCH_CURSOR_WITH_PHASE_MAX_LENGTH *
    JSON_ESCAPED_UTF8_BYTE_MAX_BYTES +
  ("null".length - JSON.stringify("").length);
