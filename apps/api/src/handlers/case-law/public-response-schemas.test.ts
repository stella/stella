import { expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";
import { UUID_PATTERN } from "@stll/uuid-codec";

import {
  citationsResponseSchema,
  citationSummaryResponseSchema,
  corpusStatusResponseSchema,
  coverageResponseSchema,
  decisionFacetsResponseSchema,
  latestDecisionsResponseSchema,
  leadingCitationsResponseSchema,
  listDecisionsResponseSchema,
  sitemapDecisionsResponseSchema,
  sitemapShardsResponseSchema,
} from "@/api/handlers/case-law/public-response-schemas";
import { toRouteJsonSchema } from "@/api/lib/json-schema/valibot-to-json-schema";
import { projectResponseText } from "@/api/lib/search/project-response-text";
import { responseByteBound } from "@/api/lib/search/response-byte-bound";
import { isRecord } from "@/api/lib/type-guards";

const responseContracts = {
  browse: listDecisionsResponseSchema,
  latest: latestDecisionsResponseSchema,
  facets: decisionFacetsResponseSchema,
  status: corpusStatusResponseSchema,
  coverage: coverageResponseSchema,
  citations: citationsResponseSchema,
  leading: leadingCitationsResponseSchema,
  summary: citationSummaryResponseSchema,
  sitemapShards: sitemapShardsResponseSchema,
  sitemapDecisions: sitemapDecisionsResponseSchema,
};

// Build the input class from the actual declared fields (the schema's JSON
// rendering), including every union branch across runs. A new text field
// therefore enters the stress input too.
const stressResponse = (
  schema: unknown,
  text: string,
  choice: number,
): unknown => {
  if (!isRecord(schema)) {
    return null;
  }
  if ("const" in schema) {
    return schema["const"];
  }
  const enumValues = schema["enum"];
  if (Array.isArray(enumValues)) {
    return enumValues.at(choice % enumValues.length);
  }
  const branches = schema["anyOf"];
  if (Array.isArray(branches)) {
    return stressResponse(
      branches.at(choice % branches.length),
      text,
      choice + 1,
    );
  }
  switch (schema["type"]) {
    case "string":
      return schema["pattern"] === UUID_PATTERN || schema["format"] === "uuid"
        ? "00000000-0000-4000-8000-000000000000"
        : text;
    case "integer":
      return typeof schema["minimum"] === "number"
        ? schema["minimum"]
        : Number.MAX_SAFE_INTEGER;
    case "number":
      return typeof schema["minimum"] === "number"
        ? schema["minimum"]
        : Number.MAX_VALUE;
    case "boolean":
      return true;
    case "null":
      return null;
    case "array":
      return [stressResponse(schema["items"], text, choice + 1)];
    case "object": {
      const properties = schema["properties"];
      if (!isRecord(properties)) {
        return {};
      }
      return Object.fromEntries(
        Object.entries(properties).map(([key, property]) => [
          key,
          stressResponse(property, text, choice + 1),
        ]),
      );
    }
    default:
      return null;
  }
};

const unicode = fc
  .array(fc.constantFrom("ě", "😀", "e\u0301", "\u0000", '"', "\\", "\ud800"), {
    minLength: 1,
    maxLength: 20,
  })
  .map((parts) => parts.join(""));

test("every public case-law response family bounds serialized multibyte responses", () => {
  assertProperty(
    "every public case-law response family bounds serialized multibyte responses",
    fc.property(
      fc.constantFrom(...Object.values(responseContracts)),
      unicode,
      fc.integer({ min: 0, max: 20 }),
      (schema, text, choice) => {
        const input = stressResponse(
          toRouteJsonSchema(schema),
          text.repeat(16_385),
          choice,
        );
        const output = projectResponseText(input, schema);
        expect(v.is(schema, output)).toBe(true);
        expect(
          Buffer.byteLength(JSON.stringify(output), "utf-8"),
        ).toBeLessThanOrEqual(responseByteBound(schema));
      },
    ),
    { numRuns: 30 * Object.keys(responseContracts).length },
  );
});

test("coverage responses accept more than 100 recorded years", () => {
  const response = stressResponse(
    toRouteJsonSchema(coverageResponseSchema),
    "coverage",
    0,
  );
  if (!isRecord(response) || !Array.isArray(response["countries"])) {
    throw new TypeError("Coverage response fixture must contain countries");
  }
  const country = response["countries"].at(0);
  if (!isRecord(country) || !Array.isArray(country["sources"])) {
    throw new TypeError("Coverage response fixture must contain sources");
  }
  const source = country["sources"].at(0);
  if (!isRecord(source)) {
    throw new TypeError("Coverage response fixture must contain a source");
  }
  source["knownGaps"] = {
    type: "reconciled",
    summary: { missing: 0, shortSlices: 0, unlistedSlices: 0 },
    years: Array.from({ length: 101 }, (_, year) => ({
      year,
      type: "complete",
    })),
  };

  expect(v.is(coverageResponseSchema, response)).toBe(true);
});
