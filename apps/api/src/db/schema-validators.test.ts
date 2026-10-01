import { describe, expect, expectTypeOf, test } from "bun:test";
import { Elysia, t } from "elysia";

import { PROPERTY_CONTENT_TYPES } from "@stll/api-contract";
import type { CaseLawResearchAnswerType } from "@stll/api-contract";

import {
  fieldContentSchema,
  propertyContentTypeSchema,
  type AiExtractablePropertyContent,
  type PropertyContent,
  type PropertyContentType,
} from "@/api/db/schema-validators";

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
 * Driven through Elysia rather than through the handler: a handler test builds
 * its own body object and never runs the schema, so it could not tell a
 * transform that fires from one that does not.
 */

const storedValue = async (payload: unknown): Promise<unknown> => {
  let received: unknown = null;
  const app = new Elysia().post(
    "/value",
    ({ body: { value } }) => {
      received = value;
      return "ok";
    },
    { body: t.Object({ value: fieldContentSchema }) },
  );
  const response = await app.handle(
    new Request("http://localhost/value", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: payload }),
    }),
  );
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
      propertyContentTypeSchema.anyOf.map((member) => member.const),
    ).toEqual([...PROPERTY_CONTENT_TYPES]);
  });

  test("omitting the field is rejected rather than defaulted", () => {
    // `t.UnionEnum` would advertise a default of the first member, which turns
    // a request that forgot `contentType` into a silent "file" column.
    expect(propertyContentTypeSchema).not.toHaveProperty("default");
  });
});
