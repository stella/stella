import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { normalizeStringList } from "./string-list";

const splitArb = fc.constantFrom("never", "delimiters" as const);

/** Whether a string is an array's JSON, the one scalar both modes parse. */
const isJsonStringArray = (text: string): boolean => {
  if (!text.trim().startsWith("[")) {
    return false;
  }
  const parsed = Result.try((): unknown => JSON.parse(text));
  return (
    parsed.isOk() &&
    Array.isArray(parsed.value) &&
    parsed.value.every((item: unknown) => typeof item === "string")
  );
};

describe("lists of strings", () => {
  test("an array of strings round-trips unchanged with nothing to report", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), splitArb, (items, split) => {
        expect(normalizeStringList(items, { split })).toEqual({
          ok: true,
          value: items,
        });
      }),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("an array's JSON reads back as the array in either mode", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), splitArb, (items, split) => {
        const result = normalizeStringList(JSON.stringify(items), { split });
        expect(result.ok && result.value).toEqual(items);
      }),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("free text is always one item, whatever it contains", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        fc.pre(!isJsonStringArray(text));
        const result = normalizeStringList(text, { split: "never" });
        expect(result.ok && result.value).toEqual([text]);
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("delimited tokens read back as the tokens", () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[^\s,;[][^,;\r\n]*[^\s,;]$|^[^\s,;[]$/u), {
          minLength: 1,
          maxLength: 8,
        }),
        (tokens) => {
          const result = normalizeStringList(tokens.join(", "), {
            split: "delimiters",
          });
          expect(result.ok && result.value).toEqual(tokens);
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });
});
