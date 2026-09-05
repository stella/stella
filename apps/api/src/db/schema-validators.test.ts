import { expect, test } from "bun:test";
import { Elysia, t } from "elysia";

import { fieldContentSchema } from "@/api/db/schema-validators";

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
