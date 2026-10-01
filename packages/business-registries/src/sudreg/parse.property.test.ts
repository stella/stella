import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { decodeRegistryNumericEntity } from "../shared/decode-registry-numeric-entity.js";
import {
  expectRegistryOutcome,
  registryString,
} from "../shared/property-test-helpers.test.js";
import { parseAddress, parseCompanyPage } from "./parse.js";

const sectionHtml = (title: string, content: string) =>
  `<div id="div_kat_0"><h2 class="srn-kat-title">${title}</h2><table class="srn-l1-table"><tr><td>${content}</td></tr></table></div>`;
const numericEntity = fc.oneof(
  fc
    .integer({ min: 0, max: 0x1f_ff_ff })
    .map((value) => ({ value, digits: String(value), hexadecimal: false })),
  fc
    .integer({ min: 0, max: 0x1f_ff_ff })
    .map((value) => ({ value, digits: value.toString(16), hexadecimal: true })),
  fc
    .constantFrom(0, 0xd8_00, 0xdb_ff, 0xdc_00, 0xdf_ff, 0x10_ff_ff, 0x11_00_00)
    .chain((value) =>
      fc.boolean().map((hexadecimal) => ({
        value,
        digits: hexadecimal ? value.toString(16) : String(value),
        hexadecimal,
      })),
    ),
  fc
    .tuple(fc.boolean(), fc.integer({ min: 20, max: 4000 }))
    .map(([hexadecimal, count]) => ({
      value: Infinity,
      digits: (hexadecimal ? "f" : "9").repeat(count),
      hexadecimal,
    })),
);

test(
  "company pages preserve unrepresentable numeric entities and decode scalar values",
  () => {
    fc.assert(
      fc.property(numericEntity, (entity) => {
        const printed = `&#${entity.hexadecimal ? "x" : ""}${entity.digits};`;
        const scalar =
          entity.value > 0 &&
          entity.value <= 0x10_ff_ff &&
          !(entity.value >= 0xd8_00 && entity.value <= 0xdf_ff);
        const content = scalar ? String.fromCodePoint(entity.value) : printed;
        expect(decodeRegistryNumericEntity(printed)).toBe(content);
        const name = `name${printed}suffix`;
        const html =
          sectionHtml("MBS", "080000014") + sectionHtml("Tvrtka", name);
        const parsed = expectRegistryOutcome(() =>
          parseCompanyPage(html, "080000014"),
        );
        const printedContent =
          content === "\n" || !/^\s$/u.test(content) ? content : " ";
        expect(parsed?.name).toBe(`name${printedContent}suffix`);
        expect(parsed?.mbs).toBe("080000014");
      }),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "unknown named entities remain printed text",
  () => {
    fc.assert(
      fc.property(
        fc.constantFrom("constructor", "tostring", "hasownproperty", "unknown"),
        (name) => {
          const printed = `&${name};`;
          const parsed = expectRegistryOutcome(() =>
            parseCompanyPage(sectionHtml("Tvrtka", printed), "080000014"),
          );
          expect(parsed?.name).toBe(printed);
        },
      ),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "HTML and address parsing always returns domain values or registry errors",
  () => {
    fc.assert(
      fc.property(registryString, registryString, (html, id) => {
        const parsed = expectRegistryOutcome(() =>
          parseCompanyPage(sectionHtml("Tvrtka", html), id),
        );
        if (parsed) {
          expect(parsed.mbs).toBe(id);
          expect(typeof parsed.name).toBe("string");
          expect(typeof parsed.registryUrl).toBe("string");
        }
        const address = expectRegistryOutcome(() => parseAddress(html));
        expect(Array.isArray(address?.warnings)).toBe(true);
        if (address?.address) {
          expect(typeof address.address.textAddress).toBe("string");
        }
      }),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(10_000),
);
