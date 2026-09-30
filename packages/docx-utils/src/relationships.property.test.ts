import { expect, test } from "bun:test";
import fc from "fast-check";
import * as slimdom from "slimdom";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { ensureRelationship, findNextRId } from "./relationships";

const identifier = fc.oneof(
  fc.bigInt({ min: 0n, max: 10n ** 80n }).map((id) => `rId${id}`),
  fc.constantFrom("custom", "rId0001", "rId0", "rId9007199254740992"),
);
const existingRelationship = fc.record({
  id: identifier,
  quote: fc.constantFrom('"', "'"),
  whitespace: fc.constantFrom("", " ", "\t", "\n"),
});

const idsFromXml = (xml: string): string[] =>
  Array.from(
    slimdom.parseXmlDocument(xml).getElementsByTagNameNS("*", "Relationship"),
  ).map((child) => child.getAttribute("Id") ?? "");

const xmlAttributeValue = fc
  .array(fc.constantFrom("a", "č", "字", "&", "<", ">", '"', "'", "$", " "), {
    maxLength: 48,
  })
  .map((characters) => characters.join(""));

test(
  "relationship updates preserve identifier invariants",
  () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(existingRelationship, {
          selector: ({ id }) => id,
          maxLength: 24,
        }),
        fc.array(
          fc.record({ type: xmlAttributeValue, target: xmlAttributeValue }),
          { minLength: 1, maxLength: 12 },
        ),
        (existing, additions) => {
          let xml = `<Relationships>${existing
            .map(
              ({ id, quote, whitespace }) =>
                `<Relationship Id${whitespace}=${whitespace}${quote}${id}${quote} Type="old" Target="old.xml"/>`,
            )
            .join("")}</Relationships>`;
          const ids = new Set(existing.map(({ id }) => id));
          for (const { id } of existing) {
            expect(ensureRelationship(xml, id, "new", "new.xml")).toBe(xml);
          }
          for (const { type, target } of additions) {
            const id = findNextRId(xml);
            expect(ids.has(id)).toBe(false);
            const updated = ensureRelationship(xml, id, type, target);
            expect(ensureRelationship(updated, id, type, target)).toBe(updated);
            ids.add(id);
            expect(new Set(idsFromXml(updated))).toEqual(ids);
            expect(idsFromXml(updated)).toHaveLength(ids.size);
            xml = updated;
          }
        },
      ),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(5000),
);
