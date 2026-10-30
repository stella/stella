import { expect, test } from "bun:test";
import fc from "fast-check";

import { cents } from "@stll/money";
import { assertProperty } from "@stll/property-testing";

import { buildCzechQrPaymentPayload } from "./qr-payment";

const iban = "CZ3301000000000002970297";

const parsePayload = (payload: string): Record<string, string> =>
  Object.fromEntries(
    payload.split("*").map((field, index) => {
      if (index === 0) {
        return ["format", field];
      }
      if (index === 1) {
        return ["version", field];
      }
      const separator = field.indexOf(":");
      return [field.slice(0, separator), field.slice(separator + 1)];
    }),
  );

test("Czech payment payload parses back to its payment fields", () => {
  assertProperty(
    "Czech payment payload parses back to its payment fields",
    fc.property(
      fc.integer({ min: 1, max: 100_000_000 }),
      fc.stringMatching(/^\d{1,10}$/u),
      fc
        .string({ minLength: 1, maxLength: 20 })
        .filter((value) => !/[\s%*]/u.test(value)),
      (amountMinor, variableSymbol, message) => {
        const result = buildCzechQrPaymentPayload({
          documentType: "invoice",
          iban,
          amountMinor: cents(amountMinor),
          currency: "czk",
          variableSymbol,
          message,
        }).unwrap();
        expect(result.status).toBe("payable");
        if (result.status !== "payable") {
          return;
        }

        const fields = parsePayload(result.payload);
        expect(fields).toEqual({
          format: "SPD",
          version: "1.0",
          ACC: iban,
          AM: `${Math.floor(amountMinor / 100)}.${String(amountMinor % 100).padStart(2, "0")}`,
          CC: "CZK",
          "X-VS": variableSymbol,
          MSG: message,
        });
      },
    ),
    { numRuns: 300 },
  );
});
