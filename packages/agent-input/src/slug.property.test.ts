import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { agentInputNormalizationMetadata, normalizeAgentInput } from "./schema";
import { normalizeSlug } from "./slug";

const slug = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-"), {
    minLength: 1,
    maxLength: 100,
  })
  .map((characters) => characters.join(""));
const whitespace = fc
  .array(fc.constantFrom(" ", "\t", "\n", "\r", "\u00a0", "\u2003"), {
    maxLength: 10,
  })
  .map((characters) => characters.join(""));

test("slug spelling preserves identity and trims only outer whitespace", () => {
  assertProperty(
    "slug spelling preserves identity and trims only outer whitespace",
    fc.property(slug, whitespace, whitespace, (value, before, after) => {
      const input = `${before}${value}${after}`;
      const result = normalizeSlug(input);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(value);
        expect(result.note !== undefined).toBe(input !== value);
        expect(normalizeSlug(result.value)).toEqual({ ok: true, value });
      }
    }),
  );
});

test("slug normalization refuses changes to token identity", () => {
  assertProperty(
    "slug normalization refuses changes to token identity",
    fc.property(
      slug,
      fc.constantFrom("A", " ", "_", "/", "é", "💼"),
      (value, invalid) => {
        expect(normalizeSlug(`${value}${invalid}${value}`).ok).toBe(false);
      },
    ),
  );
  for (const input of [null, 1, {}, [], "", " \t"]) {
    expect(normalizeSlug(input).ok).toBe(false);
  }
});

test("slug dispatch and guidance use the shared reader", () => {
  const schema = {
    type: "string",
    ...agentInputNormalizationMetadata({ kind: "slug" }),
  };
  expect(schema.description).toContain("outer whitespace is trimmed");
  expect(normalizeAgentInput({ schema, value: " org-123 " })).toEqual({
    ok: true,
    value: "org-123",
    notes: ['Read " org-123 " as "org-123".'],
  });
  expect(normalizeAgentInput({ schema, value: "Org-123" })).toMatchObject({
    ok: false,
    issues: [{ expected: "a lowercase slug" }],
  });
});
