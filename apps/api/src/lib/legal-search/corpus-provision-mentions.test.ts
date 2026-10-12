import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { PROVISION_CITATION_PROFILES } from "@stll/legal-atlas/provision-citation-profiles";
import { assertProperty } from "@stll/property-testing";
import { normalizeUnicode, foldToAscii } from "@stll/text-normalize";

import { readCorpusProvisionMentions } from "./corpus-provision-mentions";
import { tokenizeCorpusFreeText } from "./corpus-query";

const { SVK: sk, CZE: cz } = PROVISION_CITATION_PROFILES;
const skCivilCode = { number: 40, year: 1964, collection: "Zb." };
const skOlderCivilCode = { number: 141, year: 1950, collection: "Zb." };

describe("required provision tokens", () => {
  test("reads declined Slovak titles and preserves section and act spans", () => {
    expect(
      readCorpusProvisionMentions(
        tokenizeCorpusFreeText(
          "§ 451 Občianskeho zákonníka bezdôvodné obohatenie",
        ),
        sk,
      ),
    ).toEqual([
      {
        sectionIndex: 0,
        actTokenRange: { start: 1, end: 3 },
        consumedRange: { start: 1, end: 3 },
        works: [skOlderCivilCode, skCivilCode],
      },
    ]);
  });

  test("consumes subdivision pairs before a case-sensitive alias", () => {
    expect(
      readCorpusProvisionMentions(
        tokenizeCorpusFreeText("§ 106 ods. 1 písm. a OZ"),
        sk,
      ),
    ).toEqual([
      {
        sectionIndex: 0,
        actTokenRange: { start: 5, end: 6 },
        consumedRange: { start: 1, end: 6 },
        works: [skCivilCode],
      },
    ]);
  });

  test("reads a numbered act after its lead-in and preserves its collection", () => {
    expect(
      readCorpusProvisionMentions(
        tokenizeCorpusFreeText("§ 451 zákona č. 40/1964 Zb."),
        sk,
      ),
    ).toEqual([
      {
        sectionIndex: 0,
        actTokenRange: { start: 2, end: 6 },
        consumedRange: { start: 1, end: 6 },
        works: [skCivilCode],
      },
    ]);
    expect(
      readCorpusProvisionMentions(
        tokenizeCorpusFreeText("§ 1 zákona č. 40/1964 Z. z."),
        sk,
      ).at(0)?.works,
    ).toEqual([{ ...skCivilCode, collection: "Z. z." }]);
    expect(
      readCorpusProvisionMentions(
        tokenizeCorpusFreeText("zákona č. 40/1964 Zb."),
        sk,
      ),
    ).toEqual([]);
  });

  test("folds titles with omitted diacritics without folding alias case", () => {
    expect(
      readCorpusProvisionMentions(
        tokenizeCorpusFreeText("§ 451 obcianskeho zakonnika"),
        sk,
      ).at(0)?.works,
    ).toEqual([skOlderCivilCode, skCivilCode]);
    for (const profile of [sk, cz]) {
      expect(
        readCorpusProvisionMentions(
          tokenizeCorpusFreeText("§ 451 oz"),
          profile,
        ),
      ).toEqual([]);
    }
  });

  test("rejects act numbers that cannot preserve their numeric identity", () => {
    for (const number of ["0", "9007199254740993", "9".repeat(400)]) {
      expect(
        readCorpusProvisionMentions(
          tokenizeCorpusFreeText(`§ 451 zákona č. ${number}/1964 Zb.`),
          sk,
        ),
      ).toEqual([]);
    }
  });

  test("does not mistake a civil procedure title for a civil code", () => {
    expect(
      readCorpusProvisionMentions(
        tokenizeCorpusFreeText("§ 451 Občianskeho súdneho poriadku zákonníka"),
        sk,
      ),
    ).toEqual([]);
  });

  test("never reads quoted phrases or crosses a phrase boundary", () => {
    for (const query of [
      '"§ 451 Občianskeho zákonníka"',
      '§ 451 "Občianskeho zákonníka"',
      '§ "451" OZ',
      '§ 451 "ods. 1" OZ',
    ]) {
      expect(
        readCorpusProvisionMentions(tokenizeCorpusFreeText(query), sk),
      ).toEqual([]);
    }
  });

  test("unions Czech recodification windows and reads explicit NOZ", () => {
    const oldestCode = { number: 141, year: 1950, collection: "Sb." };
    const oldCode = { number: 40, year: 1964, collection: "Sb." };
    const newCode = { number: 89, year: 2012, collection: "Sb." };
    expect(
      readCorpusProvisionMentions(
        tokenizeCorpusFreeText("§ 2079 občanského zákoníku"),
        cz,
      ).at(0)?.works,
    ).toEqual([oldestCode, oldCode, newCode]);
    expect(
      readCorpusProvisionMentions(tokenizeCorpusFreeText("§ 2079 OZ"), cz).at(0)
        ?.works,
    ).toEqual([oldCode, newCode]);
    expect(
      readCorpusProvisionMentions(tokenizeCorpusFreeText("§ 2079 NOZ"), cz).at(
        0,
      )?.works,
    ).toEqual([newCode]);
  });

  test("takes the longest matching title before a shorter alias", () => {
    const profile = {
      ...sk,
      titles: [
        {
          spellings: ["OZ procesný"],
          identifier: { number: 99, year: 1963, collection: "Zb." },
        },
      ],
    };
    expect(
      readCorpusProvisionMentions(
        tokenizeCorpusFreeText("§ 451 OZ procesný"),
        profile,
      ).at(0)?.works,
    ).toEqual([{ number: 99, year: 1963, collection: "Zb." }]);
  });

  test("returns disjoint spans for multiple provisions and rejects incomplete subdivisions", () => {
    const mentions = readCorpusProvisionMentions(
      tokenizeCorpusFreeText("§ 106 ods. 1 OZ § 451 OZ"),
      sk,
    );
    expect(mentions.map(({ sectionIndex }) => sectionIndex)).toEqual([0, 4]);
    expect(mentions.map(({ consumedRange }) => consumedRange)).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 6 },
    ]);
    expect(
      readCorpusProvisionMentions(tokenizeCorpusFreeText("§ 106 ods. OZ"), sk),
    ).toEqual([]);
  });
});

test("corpus-provision-mentions/profile-title-normalization", () => {
  const titles = Object.values(PROVISION_CITATION_PROFILES).flatMap((profile) =>
    profile.titles.flatMap((entry) =>
      "unit" in entry && entry.unit === "article"
        ? []
        : entry.spellings.map((spelling) => ({
            profile,
            spelling,
            identifier: entry.identifier,
          })),
    ),
  );
  assertProperty(
    "corpus-provision-mentions/profile-title-normalization",
    fc.property(
      fc.constantFrom(...titles),
      fc.constantFrom("typed", "lowercase", "ascii", "decomposed"),
      ({ profile, spelling, identifier }, form) => {
        const variants = {
          typed: spelling,
          lowercase: spelling.toLowerCase(),
          ascii: foldToAscii(spelling).toLowerCase(),
          decomposed: normalizeUnicode(spelling, "NFD"),
        };
        const tokens = tokenizeCorpusFreeText(`§ 451 ${variants[form]}`);
        const mentions = readCorpusProvisionMentions(tokens, profile);
        expect(mentions).toHaveLength(1);
        expect(mentions.at(0)?.works).toContainEqual(identifier);
        expect(mentions.at(0)?.actTokenRange).toEqual({
          start: 1,
          end: tokens.length,
        });
      },
    ),
  );
});
