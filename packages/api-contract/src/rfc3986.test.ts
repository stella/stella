import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { encodeRfc3986Component } from "./rfc3986";

const RFC3986_EXTRA_COMPONENT_CHARACTERS = ["!", "'", "(", ")", "*"] as const;
const RFC3986_ENCODED_COMPONENT = /^(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})*$/u;

const unicodeScalar = fc.oneof(
  fc.integer({ min: 0, max: 0xd7_ff }),
  fc.integer({ min: 0xe0_00, max: 0x10_ff_ff }),
);

const componentWithExtraCharacter = fc
  .tuple(
    fc.array(unicodeScalar, { maxLength: 24 }),
    fc.constantFrom(...RFC3986_EXTRA_COMPONENT_CHARACTERS),
    fc.array(unicodeScalar, { maxLength: 24 }),
  )
  .map(
    ([prefix, extra, suffix]) =>
      `${String.fromCodePoint(...prefix)}${extra}${String.fromCodePoint(...suffix)}`,
  );

const unreservedCharacter = fc
  .oneof(
    fc.integer({ min: 0x30, max: 0x39 }),
    fc.integer({ min: 0x41, max: 0x5a }),
    fc.integer({ min: 0x61, max: 0x7a }),
    fc.constantFrom(0x2d, 0x2e, 0x5f, 0x7e),
  )
  .map((codePoint) => String.fromCodePoint(codePoint));

const unreservedComponent = fc
  .array(unreservedCharacter, { maxLength: 64 })
  .map((characters) => characters.join(""));

describe("RFC 3986 component encoding", () => {
  test("escapes every delimiter left unescaped by encodeURIComponent", () => {
    expect(encodeRfc3986Component("AZaz09-._~!'()*")).toBe(
      "AZaz09-._~%21%27%28%29%2A",
    );
  });

  test("round-trips Unicode components and emits only unreserved characters or escapes", () => {
    fc.assert(
      fc.property(componentWithExtraCharacter, (component) => {
        const encoded = encodeRfc3986Component(component);

        expect(encoded).toMatch(RFC3986_ENCODED_COMPONENT);
        expect(decodeURIComponent(encoded)).toBe(component);
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("leaves arbitrary unreserved components unchanged", () => {
    fc.assert(
      fc.property(unreservedComponent, (component) => {
        expect(encodeRfc3986Component(component)).toBe(component);
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });
});
