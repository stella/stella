import { t } from "elysia";
import type { Static } from "elysia";

import { COUNTRY_INPUT_MAX_CHARS } from "@stll/agent-input";
import {
  LEGISLATION_EXPRESSION_KINDS,
  LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT,
  LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_CODE,
  LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_MESSAGE,
  LEGISLATION_WINDOW_DISPOSITIONS,
} from "@stll/api-contract/legislation-expression";
import { LEGISLATION_LIST_VALIDITIES } from "@stll/api-contract/legislation-status";

import { PAGINATION_CURSOR_MAX_CHARS, tSafeId } from "@/api/lib/custom-schema";
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
  id: tSafeId("legislationDocument"),
  eli: boundedString(textBytes.eli),
  slug: nullableBoundedString(textBytes.slug),
  title: boundedString(textBytes.title),
  country: boundedString(textBytes.country),
  language: boundedString(textBytes.language),
};
const identitySchema = t.Object(identityFields, {
  additionalProperties: false,
});

const shelfItemSchema = t.Object(
  {
    ...identityFields,
    documentType: nullableBoundedString(textBytes.documentType),
    status: boundedString(textBytes.status),
    versionValidFrom: nullableBoundedString(DATE_BYTES),
  },
  { additionalProperties: false },
);

const listItemSchema = t.Object(
  {
    ...shelfItemSchema.properties,
    effectiveDate: nullableBoundedString(textBytes.effectiveDate),
    versionValidTo: nullableBoundedString(DATE_BYTES),
    sourceUrl: nullableBoundedString(textBytes.sourceUrl),
    documentUrl: nullableBoundedString(textBytes.sourceUrl),
    citationCaseCount: t.Union([t.Number(), t.Null()]),
    firstVersionValidFrom: nullableBoundedString(DATE_BYTES),
    amendmentCount: t.Number(),
    lastAmendedOn: nullableBoundedString(DATE_BYTES),
    validity: t.UnionEnum(LEGISLATION_LIST_VALIDITIES),
  },
  { additionalProperties: false },
);

export const listStatutesSuccessResponseSchema = t.Object(
  {
    items: t.Array(listItemSchema, {
      maxItems: LIMITS.legislationListPageSizeMax,
    }),
    nextCursor: nullableBoundedString(PAGINATION_CURSOR_MAX_CHARS),
    limit: t.Number(),
  },
  { additionalProperties: false },
);

export const legislationShelfSuccessResponseSchema = t.Object(
  {
    country: boundedString(textBytes.country),
    recentlyInForce: t.Array(shelfItemSchema, {
      maxItems: LIMITS.legislationShelfPerList,
    }),
    enteringIntoForce: t.Array(shelfItemSchema, {
      maxItems: LIMITS.legislationShelfPerList,
    }),
  },
  { additionalProperties: false },
);

export const legislationFacetsSuccessResponseSchema = t.Object(
  {
    documentType: t.Array(
      t.Object(
        {
          value: boundedString(textBytes.documentType),
          count: t.Number(),
        },
        { additionalProperties: false },
      ),
      { maxItems: LEGISLATION_DOCUMENT_TYPE_BUCKET_LIMIT },
    ),
  },
  { additionalProperties: false },
);

const resolvedStatuteSchema = t.Object(
  {
    ...identityFields,
    versionValidFrom: nullableBoundedString(DATE_BYTES),
    versionValidTo: nullableBoundedString(DATE_BYTES),
    expressionKind: t.UnionEnum(LEGISLATION_EXPRESSION_KINDS),
    windowDisposition: t.UnionEnum(LEGISLATION_WINDOW_DISPOSITIONS),
  },
  { additionalProperties: false },
);

export const resolveStatutesSuccessResponseSchema = t.Object(
  {
    items: t.Array(
      t.Object(
        {
          // Echoed country accepts the same human input spellings as the request.
          country: boundedString(COUNTRY_INPUT_MAX_CHARS * 4),
          eli: boundedString(textBytes.eli),
          asOf: boundedString(DATE_BYTES),
          statute: t.Union([resolvedStatuteSchema, t.Null()]),
          unresolvedReason: t.Union([
            t.Literal(LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT),
            tPublicCountryUnavailable.properties.reason,
            t.Null(),
          ]),
          availability: t.Optional(tPublicCountryUnavailable),
        },
        { additionalProperties: false },
      ),
      { maxItems: LIMITS.legislationResolveWorksMax },
    ),
  },
  { additionalProperties: false },
);

export const publisherWindowInconsistentResponseSchema = t.Object(
  {
    code: t.Literal(LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_CODE),
    message: t.Literal(LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_MESSAGE),
    versions: publicInconsistentVersionsSchema,
  },
  { additionalProperties: false },
);

export const statuteSitemapShardsSuccessResponseSchema = t.Object(
  {
    items: t.Array(
      t.Object(
        {
          bucket: boundedString(3),
          country: boundedString(textBytes.country),
          lastmod: boundedString(DATE_BYTES),
        },
        { additionalProperties: false },
      ),
      { maxItems: LIMITS.statuteSitemapIndexEntryLimit },
    ),
    limit: t.Literal(LIMITS.statuteSitemapIndexEntryLimit),
    nextCursor: t.Null(),
  },
  { additionalProperties: false },
);

export const statuteSitemapStatutesSuccessResponseSchema = t.Object(
  {
    items: t.Array(
      t.Object(
        {
          country: boundedString(textBytes.country),
          slug: boundedString(textBytes.slug),
          lastmod: boundedString(DATE_BYTES),
        },
        { additionalProperties: false },
      ),
      { maxItems: LIMITS.statuteSitemapShardUrlLimit },
    ),
    limit: t.Literal(LIMITS.statuteSitemapShardUrlLimit),
    nextCursor: t.Null(),
  },
  { additionalProperties: false },
);

// Preserve persisted UUID brands and enum discriminators while bounding display
// text at the response boundary. Whole statute bodies never enter this projection.
const projectStatuteCatalogIdentity = <
  Item extends Static<typeof identitySchema>,
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

const projectStatuteShelfItem = <Item extends Static<typeof shelfItemSchema>>(
  item: Item,
) => ({
  ...projectStatuteCatalogIdentity(item),
  documentType: nullableText(item.documentType, textBytes.documentType),
  status: truncateTextBytes(item.status, textBytes.status),
  versionValidFrom: nullableText(item.versionValidFrom, DATE_BYTES),
});

export const projectStatuteListItem = (
  item: Static<typeof listItemSchema>,
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
  item: Static<typeof resolvedStatuteSchema>,
) => ({
  ...projectStatuteCatalogIdentity(item),
  versionValidFrom: nullableText(item.versionValidFrom, DATE_BYTES),
  versionValidTo: nullableText(item.versionValidTo, DATE_BYTES),
});

export const projectLegislationFacets = (
  facets: Static<typeof legislationFacetsSuccessResponseSchema>,
) => ({
  documentType: facets.documentType.map((bucket) => ({
    value: truncateTextBytes(bucket.value, textBytes.documentType),
    count: bucket.count,
  })),
});

export const projectStatuteSitemapShard = (
  item: Static<
    typeof statuteSitemapShardsSuccessResponseSchema
  >["items"][number],
) => ({
  bucket: truncateTextBytes(item.bucket, 3),
  country: truncateTextBytes(item.country, textBytes.country),
  lastmod: truncateTextBytes(item.lastmod, DATE_BYTES),
});

export const projectStatuteSitemapStatute = (
  item: Static<
    typeof statuteSitemapStatutesSuccessResponseSchema
  >["items"][number],
) => ({
  country: truncateTextBytes(item.country, textBytes.country),
  slug: truncateTextBytes(item.slug, textBytes.slug),
  lastmod: truncateTextBytes(item.lastmod, DATE_BYTES),
});

export const projectResolveStatutesResponse = (
  response: Static<typeof resolveStatutesSuccessResponseSchema>,
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
  version: Static<
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
  shelf: Static<typeof legislationShelfSuccessResponseSchema>,
) => ({
  country: truncateTextBytes(shelf.country, textBytes.country),
  recentlyInForce: shelf.recentlyInForce.map(projectStatuteShelfItem),
  enteringIntoForce: shelf.enteringIntoForce.map(projectStatuteShelfItem),
});
