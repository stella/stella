import * as v from "valibot";

import { COUNTRY_INPUT_MAX_CHARS } from "@stll/agent-input";
import {
  LEGISLATION_EXPRESSION_KINDS,
  LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT,
  LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_CODE,
  LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_MESSAGE,
  LEGISLATION_WINDOW_DISPOSITIONS,
} from "@stll/api-contract/legislation-expression";
import { LEGISLATION_LIST_VALIDITIES } from "@stll/api-contract/legislation-status";

import {
  PAGINATION_CURSOR_MAX_CHARS,
  resourceIdSchema,
} from "@/api/lib/custom-schema";
import { tPublicCountryUnavailable } from "@/api/lib/legal-search/public-law-country";
import { LIMITS } from "@/api/lib/limits";
import {
  PUBLIC_ERROR_TEXT_BYTES,
  publicInconsistentVersionsSchema,
} from "@/api/lib/search/public-error-response";
import {
  boundedString,
  nullableBoundedString,
  nullableText,
  truncateTextBytes,
} from "@/api/lib/search/response-text-bounds";

const textBytes = LIMITS.legislationSearchTextBytes;
const DATE_BYTES = 32;
// DB varchar(128); the facets read already limits its vocabulary.
export const LEGISLATION_DOCUMENT_TYPE_BUCKET_LIMIT =
  LIMITS.legislationDocumentTypeBucketLimit;

const identityFields = {
  id: resourceIdSchema("legislationDocument"),
  eli: boundedString(textBytes.eli),
  slug: nullableBoundedString(textBytes.slug),
  title: boundedString(textBytes.title),
  country: boundedString(textBytes.country),
  language: boundedString(textBytes.language),
};
const identitySchema = v.object(identityFields);

const shelfItemSchema = v.object({
  ...identityFields,
  documentType: nullableBoundedString(textBytes.documentType),
  status: boundedString(textBytes.status),
  versionValidFrom: nullableBoundedString(DATE_BYTES),
});

const listItemSchema = v.object({
  ...shelfItemSchema.entries,
  effectiveDate: nullableBoundedString(textBytes.effectiveDate),
  versionValidTo: nullableBoundedString(DATE_BYTES),
  sourceUrl: nullableBoundedString(textBytes.sourceUrl),
  documentUrl: nullableBoundedString(textBytes.sourceUrl),
  citationCaseCount: v.union([v.number(), v.null()]),
  firstVersionValidFrom: nullableBoundedString(DATE_BYTES),
  amendmentCount: v.number(),
  lastAmendedOn: nullableBoundedString(DATE_BYTES),
  validity: v.picklist(LEGISLATION_LIST_VALIDITIES),
});

export const listStatutesSuccessResponseSchema = v.object({
  items: v.pipe(
    v.array(listItemSchema),
    v.maxLength(LIMITS.legislationListPageSizeMax),
  ),
  nextCursor: nullableBoundedString(PAGINATION_CURSOR_MAX_CHARS),
  limit: v.number(),
});

export const legislationShelfSuccessResponseSchema = v.object({
  country: boundedString(textBytes.country),
  recentlyInForce: v.pipe(
    v.array(shelfItemSchema),
    v.maxLength(LIMITS.legislationShelfPerList),
  ),
  enteringIntoForce: v.pipe(
    v.array(shelfItemSchema),
    v.maxLength(LIMITS.legislationShelfPerList),
  ),
});

export const legislationFacetsSuccessResponseSchema = v.object({
  documentType: v.pipe(
    v.array(
      v.object({
        value: boundedString(textBytes.documentType),
        count: v.number(),
      }),
    ),
    v.maxLength(LEGISLATION_DOCUMENT_TYPE_BUCKET_LIMIT),
  ),
});

const resolvedStatuteSchema = v.object({
  ...identityFields,
  versionValidFrom: nullableBoundedString(DATE_BYTES),
  versionValidTo: nullableBoundedString(DATE_BYTES),
  expressionKind: v.picklist(LEGISLATION_EXPRESSION_KINDS),
  windowDisposition: v.picklist(LEGISLATION_WINDOW_DISPOSITIONS),
});

export const resolveStatutesSuccessResponseSchema = v.object({
  items: v.pipe(
    v.array(
      v.object({
        country: boundedString(COUNTRY_INPUT_MAX_CHARS * 4),
        eli: boundedString(textBytes.eli),
        asOf: boundedString(DATE_BYTES),
        statute: v.union([resolvedStatuteSchema, v.null()]),
        unresolvedReason: v.union([
          v.literal(LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT),
          tPublicCountryUnavailable.entries.reason,
          v.null(),
        ]),
        availability: v.optional(tPublicCountryUnavailable),
      }),
    ),
    v.maxLength(LIMITS.legislationResolveWorksMax),
  ),
});

export const publisherWindowInconsistentResponseSchema = v.object({
  code: v.literal(LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_CODE),
  message: v.literal(LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_MESSAGE),
  versions: publicInconsistentVersionsSchema,
});

export const statuteSitemapShardsSuccessResponseSchema = v.object({
  items: v.pipe(
    v.array(
      v.object({
        bucket: boundedString(3),
        country: boundedString(textBytes.country),
        lastmod: boundedString(DATE_BYTES),
      }),
    ),
    v.maxLength(LIMITS.statuteSitemapIndexEntryLimit),
  ),
  limit: v.literal(LIMITS.statuteSitemapIndexEntryLimit),
  nextCursor: v.null(),
});

export const statuteSitemapStatutesSuccessResponseSchema = v.object({
  items: v.pipe(
    v.array(
      v.object({
        country: boundedString(textBytes.country),
        slug: boundedString(textBytes.slug),
        lastmod: boundedString(DATE_BYTES),
      }),
    ),
    v.maxLength(LIMITS.statuteSitemapShardUrlLimit),
  ),
  limit: v.literal(LIMITS.statuteSitemapShardUrlLimit),
  nextCursor: v.null(),
});

// Preserve persisted UUID brands and enum discriminators while bounding display
// text at the response boundary. Whole statute bodies never enter this projection.
const projectStatuteCatalogIdentity = <
  Item extends v.InferOutput<typeof identitySchema>,
>(
  item: Item,
) => ({
  ...item,
  eli: truncateTextBytes(item.eli, textBytes.eli),
  slug: nullableText(item.slug, textBytes.slug),
  title: truncateTextBytes(item.title, textBytes.title),
  country: truncateTextBytes(item.country, textBytes.country),
  language: truncateTextBytes(item.language, textBytes.language),
});

const projectStatuteShelfItem = <
  Item extends v.InferOutput<typeof shelfItemSchema>,
>(
  item: Item,
) => ({
  ...projectStatuteCatalogIdentity(item),
  documentType: nullableText(item.documentType, textBytes.documentType),
  status: truncateTextBytes(item.status, textBytes.status),
  versionValidFrom: nullableText(item.versionValidFrom, DATE_BYTES),
});

export const projectStatuteListItem = (
  item: v.InferOutput<typeof listItemSchema>,
) => ({
  ...projectStatuteShelfItem(item),
  effectiveDate: nullableText(item.effectiveDate, textBytes.effectiveDate),
  versionValidTo: nullableText(item.versionValidTo, DATE_BYTES),
  sourceUrl: nullableText(item.sourceUrl, textBytes.sourceUrl),
  documentUrl: nullableText(item.documentUrl, textBytes.sourceUrl),
  firstVersionValidFrom: nullableText(item.firstVersionValidFrom, DATE_BYTES),
  lastAmendedOn: nullableText(item.lastAmendedOn, DATE_BYTES),
});

const projectResolvedStatute = (
  item: v.InferOutput<typeof resolvedStatuteSchema>,
) => ({
  ...projectStatuteCatalogIdentity(item),
  versionValidFrom: nullableText(item.versionValidFrom, DATE_BYTES),
  versionValidTo: nullableText(item.versionValidTo, DATE_BYTES),
});

export const projectLegislationFacets = (
  facets: v.InferOutput<typeof legislationFacetsSuccessResponseSchema>,
) => ({
  documentType: facets.documentType.map((bucket) => ({
    value: truncateTextBytes(bucket.value, textBytes.documentType),
    count: bucket.count,
  })),
});

export const projectStatuteSitemapShard = (
  item: v.InferOutput<
    typeof statuteSitemapShardsSuccessResponseSchema
  >["items"][number],
) => ({
  bucket: truncateTextBytes(item.bucket, 3),
  country: truncateTextBytes(item.country, textBytes.country),
  lastmod: truncateTextBytes(item.lastmod, DATE_BYTES),
});

export const projectStatuteSitemapStatute = (
  item: v.InferOutput<
    typeof statuteSitemapStatutesSuccessResponseSchema
  >["items"][number],
) => ({
  country: truncateTextBytes(item.country, textBytes.country),
  slug: truncateTextBytes(item.slug, textBytes.slug),
  lastmod: truncateTextBytes(item.lastmod, DATE_BYTES),
});

export const projectResolveStatutesResponse = (
  response: v.InferOutput<typeof resolveStatutesSuccessResponseSchema>,
) => ({
  items: response.items.map((item) => ({
    ...item,
    country: truncateTextBytes(item.country, COUNTRY_INPUT_MAX_CHARS * 4),
    eli: truncateTextBytes(item.eli, textBytes.eli),
    asOf: truncateTextBytes(item.asOf, DATE_BYTES),
    statute:
      item.statute === null ? null : projectResolvedStatute(item.statute),
    ...(item.availability === undefined
      ? {}
      : {
          availability: {
            ...item.availability,
            message: truncateTextBytes(
              item.availability.message,
              PUBLIC_ERROR_TEXT_BYTES.message,
            ),
            hint: truncateTextBytes(
              item.availability.hint,
              PUBLIC_ERROR_TEXT_BYTES.hint,
            ),
          },
        }),
  })),
});

export const projectInconsistentVersion = (
  version: v.InferOutput<
    typeof publisherWindowInconsistentResponseSchema
  >["versions"][number],
) => ({
  ...version,
  id: truncateTextBytes(version.id, textBytes.documentId),
  language: truncateTextBytes(version.language, textBytes.language),
  versionValidFrom: nullableText(
    version.versionValidFrom,
    PUBLIC_ERROR_TEXT_BYTES.versionDate,
  ),
  versionValidTo: nullableText(
    version.versionValidTo,
    PUBLIC_ERROR_TEXT_BYTES.versionDate,
  ),
});

export const projectLegislationShelf = (
  shelf: v.InferOutput<typeof legislationShelfSuccessResponseSchema>,
) => ({
  country: truncateTextBytes(shelf.country, textBytes.country),
  recentlyInForce: shelf.recentlyInForce.map(projectStatuteShelfItem),
  enteringIntoForce: shelf.enteringIntoForce.map(projectStatuteShelfItem),
});
