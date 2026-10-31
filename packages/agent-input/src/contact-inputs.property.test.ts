import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { normalizeCurrencyCode } from "./currency-code";
import { normalizeDataBoxId } from "./data-box-id";
import { normalizeEmailAddress } from "./email-address";

const letters = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz");
const word = fc
  .array(letters, { minLength: 1, maxLength: 20 })
  .map((parts) => parts.join(""));
const padding = fc.constantFrom(" ", "\t", "\n", " \t ");

test("contact identifiers normalize padding and remain fixed points", () => {
  assertProperty(
    "contact identifiers normalize padding and remain fixed points",
    fc.property(word, word, padding, (local, domain, pad) => {
      const address = `${local.toUpperCase()}@${domain}.example`;
      const result = normalizeEmailAddress(`${pad}${address}${pad}`);
      expect(result).toMatchObject({ ok: true, value: address });
      expect(normalizeEmailAddress(address)).toEqual({
        ok: true,
        value: address,
      });
    }),
  );
});

test("data box IDs retain case and currency codes fold case", () => {
  assertProperty(
    "data box IDs retain case and currency codes fold case",
    fc.property(
      fc.array(letters, { minLength: 7, maxLength: 7 }),
      padding,
      (parts, pad) => {
        const id = parts.join("");
        expect(normalizeDataBoxId(`${pad}${id}${pad}`)).toMatchObject({
          ok: true,
          value: id,
        });
        expect(normalizeDataBoxId(id)).toEqual({ ok: true, value: id });
        const currency = id.slice(0, 3);
        expect(normalizeCurrencyCode(`${pad}${currency}${pad}`)).toMatchObject({
          ok: true,
          value: currency.toUpperCase(),
        });
        expect(normalizeCurrencyCode(currency.toUpperCase())).toEqual({
          ok: true,
          value: currency.toUpperCase(),
        });
      },
    ),
  );
});

test.each(["", "name", "Name <name@example.com>", "a@b", "a@@example.com"])(
  "an invalid email asks for an address: %s",
  (value) => {
    expect(normalizeEmailAddress(value)).toMatchObject({
      ok: false,
      expected: "an email address",
    });
  },
);

test.each(["", "abcdef", "abcdefgh", "abc_def", "abc def"])(
  "an invalid data box ID asks for its format: %s",
  (value) => {
    expect(normalizeDataBoxId(value)).toMatchObject({
      ok: false,
      expected: "a seven-character data box ID",
    });
  },
);
