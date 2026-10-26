import { expect, test } from "bun:test";

import {
  classifyEuResourceType,
  EU_LEGISLATION_RESOURCE_TYPES,
  EU_SOFT_LAW_RESOURCE_TYPES,
} from "@/api/handlers/legislation/ingestion/eu-resource-type";

const legislationCases = [
  ["REG", "regulation", "ordinary"],
  ["REG_DEL", "regulation", "delegated"],
  ["REG_IMPL", "regulation", "implementing"],
  ["REG_FINANC", "regulation", "ordinary"],
  ["DIR", "directive", "ordinary"],
  ["DIR_DEL", "directive", "delegated"],
  ["DIR_IMPL", "directive", "implementing"],
  ["DEC", "decision", "ordinary"],
  ["DEC_DEL", "decision", "delegated"],
  ["DEC_IMPL", "decision", "implementing"],
  ["DEC_ENTSCHEID", "decision", "legacy"],
  ["TREATY", "treaty", "ordinary"],
] as const;

test("the classification matrix covers every supported publisher resource type", () => {
  expect(Object.keys(EU_LEGISLATION_RESOURCE_TYPES).toSorted()).toEqual(
    legislationCases.map(([code]) => code).toSorted(),
  );
});

test.each(legislationCases)(
  "classifies publisher type %s as %s/%s",
  (resourceType, documentType, subtype) => {
    const expected = { type: "legislation", documentType, subtype } as const;
    expect(classifyEuResourceType({ resourceType })).toEqual(expected);
    expect(
      classifyEuResourceType({
        resourceType: `http://publications.europa.eu/resource/authority/resource-type/${resourceType}`,
      }),
    ).toEqual(expected);
  },
);

test.each([
  ["M", "treaty"],
  ["E", "treaty"],
  ["P", "charter"],
  ["A", "treaty"],
  ["S", "treaty"],
] as const)(
  "publisher treaty type %s identifies a %s",
  (publisherCelexType, documentType) => {
    expect(
      classifyEuResourceType({ resourceType: "TREATY", publisherCelexType }),
    ).toEqual({
      type: "legislation",
      documentType,
      subtype: "ordinary",
    });
  },
);

const softLawCases = ["COMMUNIC", "GUIDELINE", "NOTICE", "INFO"] as const;

// Resource-type and CELEX-type fields observed in official CELLAR metadata.
// The reference identifier labels the fixture; classification never parses it.
test.each([
  ["32021R2139", "REG_DEL", "R", "regulation", "delegated"],
  ["32023R1773", "REG_IMPL", "R", "regulation", "implementing"],
  ["32022L2100", "DIR_DEL", "L", "directive", "delegated"],
  ["32014L0021", "DIR_IMPL", "L", "directive", "implementing"],
  ["32019D1597", "DEC_DEL", "D", "decision", "delegated"],
  ["32021D0914", "DEC_IMPL", "D", "decision", "implementing"],
  ["31986S2827", "DEC_ENTSCHEID", "S", "decision", "legacy"],
  ["12005SA051", "TREATY", "S", "treaty", "ordinary"],
  ["12016P/TXT", "TREATY", "P", "charter", "ordinary"],
] as const)(
  "classifies observed metadata %s (%s, %s) as %s/%s",
  (_reference, resourceType, publisherCelexType, documentType, subtype) => {
    expect(
      classifyEuResourceType({ resourceType, publisherCelexType }),
    ).toEqual({
      type: "legislation",
      documentType,
      subtype,
    });
  },
);

test("the soft-law disposition matrix covers its declared resource types", () => {
  expect([...softLawCases].toSorted()).toEqual(
    [...EU_SOFT_LAW_RESOURCE_TYPES].toSorted(),
  );
});

test.each(softLawCases)(
  "routes %s to its owning slice without ingesting it as legislation",
  (resourceType) => {
    expect(classifyEuResourceType({ resourceType })).toEqual({
      type: "soft-law",
      owner: "soft-law",
    });
  },
);

test.each([
  "CORRIGENDUM",
  "C",
  "UNKNOWN",
  "reg",
  "",
  "constructor",
  "__proto__",
])(
  "preserves unsupported resource type %p without a family guess",
  (resourceType) => {
    expect(
      classifyEuResourceType({ resourceType, publisherCelexType: "S" }),
    ).toEqual({
      type: "unsupported",
      resourceType,
    });
  },
);

test("a nonauthority URL is not normalized into a supported code", () => {
  const resourceType = "https://example.test/resource-type/REG";
  expect(classifyEuResourceType({ resourceType })).toEqual({
    type: "unsupported",
    resourceType,
  });
});
