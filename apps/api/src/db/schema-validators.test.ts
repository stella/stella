import { afterAll, describe, expect, expectTypeOf, test } from "bun:test";
import * as v from "valibot";

import { PROPERTY_CONTENT_TYPES } from "@stll/api-contract";
import type { CaseLawResearchAnswerType } from "@stll/api-contract";

import {
  type AiExtractablePropertyContent,
  fieldContentSchema,
  type PropertyContent,
  type PropertyContentType,
  propertyContentTypeSchema,
} from "@/api/db/schema-validators";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { defineEndpoint } from "@/api/lib/endpoints";
import { serveForTest } from "@/api/tests/helpers/test-server";

/**
 * A workspace field's currency is normalized where it is written, not where it
 * is read.
 *
 * Billing rejects a lower-case code outright; this boundary cannot, because
 * clients have always been free to send either case and `Intl` resolved both.
 * Normalizing on the way in is what keeps a stored "jpy" and a stored "JPY"
 * from being two currencies to anything that groups or compares the raw
 * string, with nothing left to migrate.
 *
 * Driven through a served route rather than through the handler: a handler
 * test builds its own body object and never runs the schema, so it could not
 * tell a transform that fires from one that does not.
 */

let received: unknown = null;
const server = serveForTest(
  createHttpApp({
    middleware: [],
    routes: routes({
      "/value": {
        POST: defineEndpoint.public(
          { body: v.object({ value: fieldContentSchema }) },
          ({ body: { value } }) => {
            received = value;
            return "ok";
          },
        ),
      },
    }),
  }),
);
afterAll(async () => {
  await server.stop();
});

const storedValue = async (payload: unknown): Promise<unknown> => {
  received = null;
  const response = await server.fetch("http://localhost/value", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: payload }),
  });
  expect(response.status).toBe(200);
  return received;
};

test("a lower-case money currency is stored upper case", async () => {
  expect(
    await storedValue({
      version: 1,
      type: "money",
      amountCents: 1500,
      currency: "jpy",
    }),
  ).toEqual({ version: 1, type: "money", amountCents: 1500, currency: "JPY" });
});

test("a mixed-case int currency is stored upper case", async () => {
  expect(
    await storedValue({ version: 1, type: "int", value: 42, currency: "cZk" }),
  ).toEqual({ version: 1, type: "int", value: 42, currency: "CZK" });
});

test("an int field without a currency keeps its null", async () => {
  expect(
    await storedValue({ version: 1, type: "int", value: 42, currency: null }),
  ).toEqual({ version: 1, type: "int", value: 42, currency: null });
});

test("an upper-case code passes through unchanged", async () => {
  expect(
    await storedValue({
      version: 1,
      type: "money",
      amountCents: 1500,
      currency: "KWD",
    }),
  ).toEqual({ version: 1, type: "money", amountCents: 1500, currency: "KWD" });
});

test.each([
  { kind: "unsupported_field", fieldType: "INCLUDEPICTURE" },
  {
    kind: "unsupported_reference",
    format: "text/html",
    element: "x-thing",
    attribute: "src",
  },
  { kind: "legacy_format", replacementExtension: ".xlsx" },
  { kind: "unsupported_encoding", encoding: "windows-1252" },
] as const)(
  "a conversion refusal is preserved in file state",
  async (refusal) => {
    const value = {
      version: 1,
      type: "file",
      id: "00000000-0000-4000-8000-000000000000",
      fileName: "brief.doc",
      mimeType: "application/msword",
      sizeBytes: 10,
      encrypted: false,
      sha256Hex: "0".repeat(64),
      pdfFileId: null,
      pdfDerivative: {
        status: "failed",
        reason: "processing",
        conversionRefusal: refusal,
      },
    };

    expect(await storedValue(value)).toEqual(value);
  },
);

describe("property content types", () => {
  test("the extractable subset is the property union minus the hand-entered kinds", () => {
    // The AI-extractable union is now its own schema rather than a type-level
    // `Exclude`, so bind the two: a member added to `propertyContentSchema`
    // that belongs in the extractable subset, or dropped from it, fails here.
    expectTypeOf<AiExtractablePropertyContent>().toEqualTypeOf<
      Exclude<PropertyContent, { type: "file" | "money" | "person" }>
    >();
    // A case-law question column is a property asked of a decision, so the
    // kinds a question may take are exactly the kinds the extractor can produce.
    expectTypeOf<
      AiExtractablePropertyContent["type"]
    >().toEqualTypeOf<CaseLawResearchAnswerType>();
  });

  test("the wire schema accepts exactly the contract's list", () => {
    // A stale copy of the list would still typecheck if it were merely a
    // subset, so the schema's members must be exactly the contract's.
    expectTypeOf<PropertyContentType>().toEqualTypeOf<
      (typeof PROPERTY_CONTENT_TYPES)[number]
    >();
    expect(
      propertyContentTypeSchema.options.map((member) => member.literal),
    ).toEqual([...PROPERTY_CONTENT_TYPES]);
  });

  test("omitting the field is rejected rather than defaulted", () => {
    // A default of the first member would turn a request that forgot
    // `contentType` into a silent "file" column.
    const request = v.object({ contentType: propertyContentTypeSchema });
    const decoded = v.safeParse(request, {});
    expect(decoded.success).toBe(false);
    expect(decoded.issues?.map((issue) => v.getDotPath(issue))).toEqual([
      "contentType",
    ]);
  });
});
