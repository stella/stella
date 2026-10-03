import type { TSchema } from "@sinclair/typebox";
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
import { LIMITS } from "@/api/lib/limits";
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

const boundedResponseProperty = (
  schema: TSchema,
  responseWithText: (text: string) => unknown,
) =>
  fc.property(unicode, (text) => {
    const overlong = text.repeat(Math.ceil(9000 / text.length));
    const response = responseWithText(overlong);
    expect(Value.Check(schema, response)).toBe(true);
    const serialized = JSON.stringify(response);
    expect(Buffer.byteLength(serialized, "utf-8")).toBeLessThanOrEqual(
      responseSchemaByteBound(schema),
    );
    expect(JSON.parse(serialized)).toEqual(response);
  });

test("statute listing bounds serialized Unicode metadata", () => {
  assertProperty(
    "statute listing bounds serialized Unicode metadata",
    boundedResponseProperty(listStatutesSuccessResponseSchema, (text) => ({
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
    })),
    { numRuns: 30 },
  );
});

test("statute shelf bounds serialized Unicode metadata", () => {
  assertProperty(
    "statute shelf bounds serialized Unicode metadata",
    boundedResponseProperty(legislationShelfSuccessResponseSchema, (text) =>
      projectLegislationShelf({
        country: text,
        recentlyInForce: [shelfItem(text)],
        enteringIntoForce: [shelfItem(text)],
      }),
    ),
    { numRuns: 30 },
  );
});

test("statute facets bound serialized Unicode bucket labels", () => {
  assertProperty(
    "statute facets bound serialized Unicode bucket labels",
    boundedResponseProperty(legislationFacetsSuccessResponseSchema, (text) =>
      projectLegislationFacets({
        documentType: [{ value: text, count: Number.MAX_VALUE }],
      }),
    ),
    { numRuns: 30 },
  );
});

test("statute resolver bounds serialized Unicode matches and echoes", () => {
  assertProperty(
    "statute resolver bounds serialized Unicode matches and echoes",
    boundedResponseProperty(resolveStatutesSuccessResponseSchema, (text) =>
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
    ),
    { numRuns: 30 },
  );
});

test("statute ELI gap response bounds serialized Unicode version metadata", () => {
  assertProperty(
    "statute ELI gap response bounds serialized Unicode version metadata",
    boundedResponseProperty(
      publisherWindowInconsistentResponseSchema,
      (text) => ({
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
    ),
    { numRuns: 30 },
  );
});

test("statute sitemap index bounds serialized Unicode shard metadata", () => {
  assertProperty(
    "statute sitemap index bounds serialized Unicode shard metadata",
    boundedResponseProperty(
      statuteSitemapShardsSuccessResponseSchema,
      (text) => ({
        items: [
          projectStatuteSitemapShard({
            bucket: text,
            country: text,
            lastmod: text,
          }),
        ],
        limit: LIMITS.statuteSitemapIndexEntryLimit,
        nextCursor: null,
      }),
    ),
    { numRuns: 30 },
  );
});

test("statute sitemap shard bounds serialized Unicode URL segments", () => {
  assertProperty(
    "statute sitemap shard bounds serialized Unicode URL segments",
    boundedResponseProperty(
      statuteSitemapStatutesSuccessResponseSchema,
      (text) => ({
        items: [
          projectStatuteSitemapStatute({
            country: text,
            slug: text,
            lastmod: text,
          }),
        ],
        limit: LIMITS.statuteSitemapShardUrlLimit,
        nextCursor: null,
      }),
    ),
    { numRuns: 30 },
  );
});
