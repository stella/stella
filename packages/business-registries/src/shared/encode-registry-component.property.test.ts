import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { encodeRegistryComponent } from "./encode-registry-component.js";
import { registryString } from "./property-test-helpers.test.js";

test(
  "URL components round-trip Unicode scalar values",
  () => {
    fc.assert(
      fc.property(registryString, (source) => {
        const scalarText = Array.from(source, (character) => {
          const code = character.codePointAt(0) ?? 0;
          return character.length === 1 && code >= 0xd8_00 && code <= 0xdf_ff
            ? "\ufffd"
            : character;
        }).join("");
        const encoded = encodeRegistryComponent(source);
        expect(decodeURIComponent(encoded)).toBe(scalarText);
        expect(encoded).toBe(encodeURIComponent(scalarText));
      }),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(10_000),
);
