import { expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  PROVISION_KEY_MAX_BYTES,
  PROVISION_KEYS_MAX_COUNT,
  PROVISION_KEYS_MAX_SERIALIZED_BYTES,
  provisionFilterKey,
  provisionKey,
  type ProvisionKeyFilter,
  provisionKeysOfLinks,
} from "@/api/lib/case-law/provision-keys";

const WORK = "262/2006 Sb.";

const SECTION_316 = {
  work: WORK,
  unit: "section",
  section: 316,
} as const satisfies ProvisionKeyFilter;
const SECTION_31 = { ...SECTION_316, section: 31 } as const;

test("a link contributes one key per anchor prefix", () => {
  expect(
    provisionKeysOfLinks([
      { workIdentifier: WORK, anchor: "par_316-odst_2-pism_a" },
    ]),
  ).toEqual({
    keys: [
      "262/2006 Sb.|par_316",
      "262/2006 Sb.|par_316-odst_2",
      "262/2006 Sb.|par_316-odst_2-pism_a",
    ],
    dropped: 0,
  });
});

test("keys are distinct and sorted whatever order the links come in", () => {
  const links = [
    { workIdentifier: WORK, anchor: "par_316-odst_3" },
    { workIdentifier: "89/2012 Sb.", anchor: "par_1" },
    { workIdentifier: WORK, anchor: "par_316-odst_2" },
    { workIdentifier: WORK, anchor: "par_316-odst_2" },
  ];
  const expected = provisionKeysOfLinks(links);
  expect(expected.keys).toEqual([
    "262/2006 Sb.|par_316",
    "262/2006 Sb.|par_316-odst_2",
    "262/2006 Sb.|par_316-odst_3",
    "89/2012 Sb.|par_1",
  ]);
  expect(provisionKeysOfLinks(links.toReversed())).toEqual(expected);
});

test("a section never reaches a longer section number", () => {
  const { keys } = provisionKeysOfLinks([
    { workIdentifier: WORK, anchor: "par_316" },
  ]);
  expect(keys).not.toContain(provisionFilterKey(SECTION_31));
  expect(keys).toContain(provisionFilterKey(SECTION_316));
});

test("an empty anchor or an empty segment contributes nothing", () => {
  expect(
    provisionKeysOfLinks([
      { workIdentifier: WORK, anchor: "" },
      { workIdentifier: WORK, anchor: "par_1--odst_2" },
    ]),
  ).toEqual({ keys: [], dropped: 0 });
});

test("a key past its byte bound is dropped and counted, never cut", () => {
  const long = `par_${"1".repeat(PROVISION_KEY_MAX_BYTES)}`;
  expect(
    provisionKeysOfLinks([{ workIdentifier: WORK, anchor: long }]),
  ).toEqual({ keys: [], dropped: 1 });
  // The encoding adds the two quotes.
  const fits = `par_${"1".repeat(PROVISION_KEY_MAX_BYTES - 2 - WORK.length - 5)}`;
  expect(provisionKey(WORK, fits)).toHaveLength(PROVISION_KEY_MAX_BYTES - 2);
  expect(
    provisionKeysOfLinks([{ workIdentifier: WORK, anchor: fits }]).dropped,
  ).toBe(0);
});

test("a set past the cap keeps the shallowest keys and counts the rest", () => {
  const links = Array.from({ length: 300 }, (_, index) => ({
    workIdentifier: WORK,
    anchor: `par_${String(index + 1)}-odst_1`,
  }));
  const { keys, dropped } = provisionKeysOfLinks(links);
  // 300 sections and 300 subsections are 600 keys; the cap keeps 256 of them.
  expect(keys).toHaveLength(PROVISION_KEYS_MAX_COUNT);
  expect(dropped).toBe(600 - PROVISION_KEYS_MAX_COUNT);
  expect(keys.every((key) => !key.includes("odst_"))).toBe(true);
  expect(keys).toEqual(keys.toSorted());
  // The same links in another order keep the same keys.
  expect(provisionKeysOfLinks(links.toReversed())).toEqual({ keys, dropped });
});

test("a set exactly at the cap is whole", () => {
  const links = Array.from(
    { length: PROVISION_KEYS_MAX_COUNT },
    (_, index) => ({
      workIdentifier: WORK,
      anchor: `par_${String(index + 1)}`,
    }),
  );
  const { keys, dropped } = provisionKeysOfLinks(links);
  expect(keys).toHaveLength(PROVISION_KEYS_MAX_COUNT);
  expect(dropped).toBe(0);
});

test("a filter queries by the key of its deepest named level", () => {
  expect(provisionFilterKey(SECTION_316)).toBe("262/2006 Sb.|par_316");
  expect(provisionFilterKey({ ...SECTION_316, subsection: "2" })).toBe(
    "262/2006 Sb.|par_316-odst_2",
  );
  expect(
    provisionFilterKey({ ...SECTION_316, subsection: "2", letter: "a" }),
  ).toBe("262/2006 Sb.|par_316-odst_2-pism_a");
  expect(
    provisionFilterKey({
      ...SECTION_316,
      subsection: "2",
      letter: "a",
      point: "3",
    }),
  ).toBe("262/2006 Sb.|par_316-odst_2-pism_a-bod_3");
});

test("the section suffix belongs to the section and the article unit renders cl_", () => {
  expect(provisionFilterKey({ ...SECTION_316, sectionSuffix: "a" })).toBe(
    "262/2006 Sb.|par_316a",
  );
  expect(provisionFilterKey({ ...SECTION_316, sectionSuffix: "A" })).toBe(
    "262/2006 Sb.|par_316a",
  );
  expect(
    provisionFilterKey({ ...SECTION_316, unit: "article", subsection: "01" }),
  ).toBe("262/2006 Sb.|cl_316-odst_1");
});

test("a level left out is left out of the anchor, as in a link that did not cite it", () => {
  expect(provisionFilterKey({ ...SECTION_316, letter: "a" })).toBe(
    "262/2006 Sb.|par_316-pism_a",
  );
  expect(
    provisionKeysOfLinks([{ workIdentifier: WORK, anchor: "par_316-pism_a" }])
      .keys,
  ).toContain(provisionFilterKey({ ...SECTION_316, letter: "a" }));
});

const levelArbitrary = fc.record({
  section: fc.integer({ min: 1, max: 9999 }),
  sectionSuffix: fc.option(fc.constantFrom("a", "b", "z"), { nil: undefined }),
  subsection: fc.option(fc.constantFrom("1", "2", "10", "3a"), {
    nil: undefined,
  }),
  letter: fc.option(fc.constantFrom("a", "b", "z"), { nil: undefined }),
  point: fc.option(fc.constantFrom("1", "2", "12"), { nil: undefined }),
});

const anchorOf = ({
  section,
  sectionSuffix,
  subsection,
  letter,
  point,
}: {
  section: number;
  sectionSuffix: string | undefined;
  subsection: string | undefined;
  letter: string | undefined;
  point: string | undefined;
}): string =>
  [
    `par_${String(section)}${sectionSuffix ?? ""}`,
    ...(subsection === undefined ? [] : [`odst_${subsection}`]),
    ...(letter === undefined ? [] : [`pism_${letter}`]),
    ...(point === undefined ? [] : [`bod_${point}`]),
  ].join("-");

test("the writer and the reader agree: a link answers the filter at every depth it names", () => {
  fc.assert(
    fc.property(levelArbitrary, (reference) => {
      const { keys } = provisionKeysOfLinks([
        { workIdentifier: WORK, anchor: anchorOf(reference) },
      ]);
      // The filter at the link's own depth is among the link's keys.
      expect(keys).toContain(
        provisionFilterKey({ work: WORK, unit: "section", ...reference }),
      );
      // So is the filter at the section alone, whatever the link goes on to say.
      expect(keys).toContain(
        provisionFilterKey({
          work: WORK,
          unit: "section",
          section: reference.section,
          ...(reference.sectionSuffix === undefined
            ? {}
            : { sectionSuffix: reference.sectionSuffix }),
        }),
      );
    }),
    propertyConfig({ numRuns: 200 }),
  );
});

test("keys of any links are distinct, sorted, bounded, and independent of order", () => {
  fc.assert(
    fc.property(
      fc.array(
        levelArbitrary.map((reference) => ({
          workIdentifier: WORK,
          anchor: anchorOf(reference),
        })),
        { maxLength: 120 },
      ),
      (links) => {
        const { keys, dropped } = provisionKeysOfLinks(links);
        expect(keys.length).toBeLessThanOrEqual(PROVISION_KEYS_MAX_COUNT);
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys).toEqual(keys.toSorted());
        expect(provisionKeysOfLinks(links.toReversed())).toEqual({
          keys,
          dropped,
        });
      },
    ),
    propertyConfig({ numRuns: 200 }),
  );
});

test("the worst-case key set, as the projection serializes it, fits the passage budget", () => {
  // Keys of the longest admitted size, more than the cap, through the real
  // reduction; escaped characters are the worst case for the encoding.
  const fillerLength = PROVISION_KEY_MAX_BYTES - 2 - WORK.length - 1 - 4 - 8;
  const links = Array.from(
    { length: PROVISION_KEYS_MAX_COUNT + 40 },
    (_, index) => ({
      workIdentifier: WORK,
      anchor: `par_${"1".repeat(fillerLength)}${String(index).padStart(8, "0")}`,
    }),
  );
  const { keys, dropped } = provisionKeysOfLinks(links);
  expect(keys).toHaveLength(PROVISION_KEYS_MAX_COUNT);
  expect(dropped).toBe(40);
  const serialized = JSON.stringify({ provision_keys: keys });
  const arrayBytes = new TextEncoder().encode(JSON.stringify(keys)).length;
  expect(serialized).toContain(JSON.stringify(keys));
  expect(arrayBytes).toBeLessThanOrEqual(PROVISION_KEYS_MAX_SERIALIZED_BYTES);
  // The cap is the largest that fits: one more such key would not.
  expect(arrayBytes + PROVISION_KEY_MAX_BYTES + 1).toBeGreaterThan(
    PROVISION_KEYS_MAX_SERIALIZED_BYTES,
  );
  // And a key with characters the encoding escapes is measured encoded.
  const escaped = provisionKeysOfLinks([
    {
      workIdentifier: WORK,
      anchor: `par_${'"'.repeat(PROVISION_KEY_MAX_BYTES / 2)}`,
    },
  ]);
  expect(escaped.keys).toEqual([]);
  expect(escaped.dropped).toBe(1);
});
