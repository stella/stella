import { Value } from "@sinclair/typebox/value";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { UUID_PATTERN } from "@stll/uuid-codec";

import {
  citationSummaryResponseSchema,
  citationsResponseSchema,
  corpusStatusResponseSchema,
  coverageResponseSchema,
  decisionFacetsResponseSchema,
  latestDecisionsResponseSchema,
  leadingCitationsResponseSchema,
  listDecisionsResponseSchema,
  sitemapDecisionsResponseSchema,
  sitemapShardsResponseSchema,
} from "@/api/handlers/case-law/public-response-schemas";
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

// Build the input class from the actual declared fields, including every union
// branch across runs. A new text field therefore enters the stress input too.
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
      return schema["pattern"] === UUID_PATTERN
        ? "00000000-0000-4000-8000-000000000000"
        : text;
    case "number":
    case "integer":
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

for (const [family, schema] of Object.entries(responseContracts)) {
  const title = `public case-law ${family} bounds serialized multibyte responses`;
  test(title, () => {
    assertProperty(
      title,
      fc.property(unicode, fc.integer({ min: 0, max: 20 }), (text, choice) => {
        const input = stressResponse(schema, text.repeat(16_385), choice);
        const output = projectResponseText(input, schema);
        expect(Value.Check(schema, output)).toBe(true);
        expect(
          Buffer.byteLength(JSON.stringify(output), "utf-8"),
        ).toBeLessThanOrEqual(responseByteBound(schema));
      }),
      { numRuns: 30 },
    );
  });
}
