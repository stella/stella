import { Value } from "@sinclair/typebox/value";
import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_CODE,
  LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_MESSAGE,
} from "@stll/api-contract/legislation-expression";
import { assertProperty } from "@stll/property-testing";

import {
  legislationFacetsSuccessResponseSchema,
  legislationShelfSuccessResponseSchema,
  listStatutesSuccessResponseSchema,
  projectInconsistentVersion,
  projectLegislationFacets,
  projectLegislationShelf,
  projectResolveStatutesResponse,
  projectStatuteListItem,
  projectStatuteSitemapShard,
  projectStatuteSitemapStatute,
  publisherWindowInconsistentResponseSchema,
  resolveStatutesSuccessResponseSchema,
  statuteSitemapShardsSuccessResponseSchema,
  statuteSitemapStatutesSuccessResponseSchema,
} from "@/api/handlers/legislation/catalog-response";
import { encodePaginationCursor } from "@/api/lib/pagination";
import { brandPersistedLegislationDocumentId } from "@/api/lib/safe-id-boundaries";
import { responseSchemaByteBound } from "@/api/tests/helpers/response-schema-byte-bound";

const id = brandPersistedLegislationDocumentId(
  "00000000-0000-7000-8000-000000000001",
);
const identity = (text: string) => ({
  id,
  eli: text,
  slug: text,
  title: text,
  country: text,
  language: text,
});
const shelfItem = (text: string) => ({
  ...identity(text),
  documentType: text,
  status: text,
  versionValidFrom: text,
});

const unicode = fc
  .array(
    fc.constantFrom("ě", "ľ", "😀", "e\u0301", "\u0000", '"', "\\", "\ud800"),
    {
      minLength: 1,
      maxLength: 30,
    },
  )
  .map((parts) => parts.join(""));

const families = [
  {
    title: "statute listing bounds serialized Unicode metadata",
    schema: listStatutesSuccessResponseSchema,
    response: (text: string) => ({
      items: [
        projectStatuteListItem({
          ...shelfItem(text),
          effectiveDate: text,
          versionValidTo: text,
          sourceUrl: text,
          documentUrl: text,
          citationCaseCount: Number.MAX_VALUE,
          firstVersionValidFrom: text,
          amendmentCount: -Number.MAX_VALUE,
          lastAmendedOn: text,
          validity: "in-force",
        }),
      ],
      // The cursor must round-trip: bound its producer, never truncate it.
      nextCursor: encodePaginationCursor([
        "search-v1",
        "1",
        Array.from(text.toWellFormed()).slice(0, 52).join(""),
        id,
      ]),
      limit: 1,
    }),
  },
  {
    title: "statute shelf bounds serialized Unicode metadata",
    schema: legislationShelfSuccessResponseSchema,
    response: (text: string) =>
      projectLegislationShelf({
        country: text,
        recentlyInForce: [shelfItem(text)],
        enteringIntoForce: [shelfItem(text)],
      }),
  },
  {
    title: "statute facets bound serialized Unicode bucket labels",
    schema: legislationFacetsSuccessResponseSchema,
    response: (text: string) =>
      projectLegislationFacets({
        documentType: [{ value: text, count: Number.MAX_VALUE }],
      }),
  },
  {
    title: "statute resolver bounds serialized Unicode matches and echoes",
    schema: resolveStatutesSuccessResponseSchema,
    response: (text: string) =>
      projectResolveStatutesResponse({
        items: [
          {
            country: text,
            eli: text,
            asOf: text,
            statute: {
              ...identity(text),
              versionValidFrom: text,
              versionValidTo: text,
              expressionKind: "consolidation",
              windowDisposition: "effective",
            },
            unresolvedReason: null,
          },
          {
            country: text,
            eli: text,
            asOf: text,
            statute: null,
            unresolvedReason: "pending_public",
            availability: {
              code: "public_country_unavailable",
              status: "unavailable",
              country: "SVK",
              reason: "pending_public",
              message: text,
              hint: text,
            },
          },
        ],
      }),
  },
  {
    title:
      "statute ELI gap response bounds serialized Unicode version metadata",
    schema: publisherWindowInconsistentResponseSchema,
    response: (text: string) => ({
      code: LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_CODE,
      message: LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_MESSAGE,
      versions: [
        projectInconsistentVersion({
          id: text,
          language: text,
          versionValidFrom: text,
          versionValidTo: text,
          basis: "missing-start",
        }),
      ],
    }),
  },
  {
    title: "statute sitemap index bounds serialized Unicode shard metadata",
    schema: statuteSitemapShardsSuccessResponseSchema,
    response: (text: string) => ({
      items: [
        projectStatuteSitemapShard({
          bucket: text,
          country: text,
          lastmod: text,
        }),
      ],
      limit: 1,
      nextCursor: null,
    }),
  },
  {
    title: "statute sitemap shard bounds serialized Unicode URL segments",
    schema: statuteSitemapStatutesSuccessResponseSchema,
    response: (text: string) => ({
      items: [
        projectStatuteSitemapStatute({
          country: text,
          slug: text,
          lastmod: text,
        }),
      ],
      limit: 1,
      nextCursor: null,
    }),
  },
];

for (const family of families) {
  test(family.title, () => {
    assertProperty(
      family.title,
      fc.property(unicode, (text) => {
        const overlong = text.repeat(Math.ceil(9000 / text.length));
        const response = family.response(overlong);
        expect(Value.Check(family.schema, response)).toBe(true);
        const serialized = JSON.stringify(response);
        expect(Buffer.byteLength(serialized, "utf-8")).toBeLessThanOrEqual(
          responseSchemaByteBound(family.schema),
        );
        expect(JSON.parse(serialized)).toEqual(response);
      }),
      { numRuns: 30 },
    );
  });
}
