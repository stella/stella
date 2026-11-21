/**
 * Provision anchors are links readers follow and keys stored rows carry, so
 * the anchor a provision mints must not move under it. This file mints the
 * anchors of a fixed set of real citations through every public minting
 * entry point (the citation grammars, the minting boundary, the citation
 * profiles' resolver) and derives what reads them (lineage, search keys, the
 * heading a subdivision is filed under), then compares the result byte for
 * byte with the committed golden file's values. The golden values were
 * produced by this code before anchors were minted through the statute
 * anchor scheme; a changed line is a changed link.
 */

import { expect, test } from "bun:test";

import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import { statuteAnchorNestingFor } from "@stll/api-contract/statute-anchor-schemes";
import { provisionHeadingAnchor } from "@stll/legal-ast/provision-preview";
import { CZ_PROFILE } from "@stll/legal-atlas/cz-provision-citation-profile";
import { PROVISION_CITATION_GRAMMARS } from "@stll/legal-atlas/provision-citation-grammars";
import {
  anchorProvisionCitation,
  renderProvisionAnchor,
  resolveProvisionCitation,
} from "@stll/legal-atlas/provision-citation-resolve";
import { provisionRefOf } from "@stll/legal-atlas/provision-key";
import { SK_PROFILE } from "@stll/legal-atlas/sk-provision-citation-profile";

import { provisionAnchorLineage } from "./provision-anchor-lineage";
import { provisionFilterKey, provisionKeysOfLinks } from "./provision-keys";

const GOLDEN = new URL(
  "__goldens__/provision-anchors.golden.json",
  import.meta.url,
);

const CITED_ON = "2026-10-14";

type Golden = Record<string, unknown>;

/** Citations as a court prints them, read by the citing country's grammar. */
const LOCATED: readonly (readonly [CaseLawJurisdiction, string])[] = [
  ["CZE", "§ 65 odst. 1 s. ř. s."],
  ["CZE", "§ 110 s. ř. s."],
  ["CZE", "§ 103 odst. 1 písm. a) s. ř. s."],
  ["CZE", "§ 103 odst. 1 písm. d/ s. ř. s."],
  ["CZE", "§ 104 odst. 3 písm. a) bod 1 s. ř. s."],
  ["CZE", "§ 48 písm. a) s. ř. s."],
  ["CZE", "§ 85 a § 46 odst. 1 písm. a) s. ř. s."],
  ["CZE", "§ 35a odst. 2 s. ř. s."],
  ["CZE", "§ 75 odst. 2 věta první s. ř. s."],
  ["SVK", "§ 6 ods. 2 písm. d) SSP"],
  ["SVK", "§ 10 SSP"],
  ["SVK", "§ 17 písm. a) SSP"],
  ["SVK", "§439 ods.2 písm.d) bod1 SSP"],
  ["SVK", "(§ 439 ods. 2 písm. d/ SSP)"],
  ["SVK", "§ 13 ods. 3 SSP v spojení s § 17 písm. a) SSP"],
  ["SVK", "§ 18 ods. 2 prvá veta SSP"],
  ["SVK", "§ 9 ods. 1 a § 18 ods. 2 prvá veta SSP"],
  ["EU", "Article 6(1)(a) GDPR"],
  ["EU", "Article 5(1)(a) GDPR"],
  ["EU", "Article 17 GDPR"],
  ["EU", "Article 4(7) GDPR"],
  ["EU", "Article 267 TFEU"],
  ["EU", "čl. 6 odst. 1 písm. a) GDPR"],
  ["USA", "42 U.S.C. § 1983"],
  ["USA", "42 U.S.C. § 2000e-2(a)(1)"],
  ["USA", "42 U.S.C. § 2000e-2(k)(1)(A)(i)"],
  ["USA", "15 U.S.C. § 78j(b)"],
  ["USA", "29 U.S.C. § 1132(a)(1)(B)"],
  ["USA", "12 C.F.R. § 1026.18(c)(1)(i)"],
  ["USA", "Treas. Reg. § 1.401(k)-1(a)(4)"],
];

/** A printed reference and its work, minted through the minting boundary. */
const REFERENCES: readonly (readonly [CaseLawJurisdiction, string, string])[] =
  [
    ["CZE", "262/2006 Sb.", "§ 316"],
    ["CZE", "262/2006 Sb.", "§ 316 odst. 2"],
    ["CZE", "262/2006 Sb.", "§ 316 odst. 2 písm. a)"],
    ["CZE", "262/2006 Sb.", "§ 52 písm. g)"],
    ["CZE", "586/1992 Sb.", "§ 6 odst. 1 písm. b) bod 1"],
    ["CZE", "262/2006 Sb.", "§ 1a"],
    ["CZE", "262/2006 Sb.", "§ 5A odst. 2B písm. K)"],
    ["SVK", "162/2015 Z. z.", "§ 6 ods. 2 písm. d)"],
    ["SVK", "162/2015 Z. z.", "§ 439 ods. 2 písm. d) bod 1"],
    ["SVK", "162/2015 Z. z.", "§ 17 písm. a)"],
    ["SVK", "311/2001 Z. z.", "§ 5a"],
    ["SVK", "311/2001 Z. z.", "§ 63 ods. 1 písm. b) bod 2"],
    ["EU", "32016R0679", "Article 5(1)(a)"],
    ["EU", "32016R0679", "Article 6(1)"],
    ["EU", "32016R0679", "Article 17"],
    ["USA", "42 U.S.C. 2000e-2", "§ 2000e-2(a)(1)"],
    ["USA", "42 U.S.C. 1983", "§ 1983"],
    ["USA", "12 C.F.R. 1026.18", "§ 1026.18(c)(1)(i)"],
  ];

/** Citations a caller names, resolved through a citation profile. */
const RESOLVED = [
  [CZ_PROFILE, "§ 316 odst. 2 zákona č. 262/2006 Sb."],
  [CZ_PROFILE, "§ 52 písm. g) zákoníku práce"],
  [CZ_PROFILE, "§ 2910 OZ"],
  [CZ_PROFILE, "§ 1a ZP"],
  [CZ_PROFILE, "čl. 10 Listiny"],
  [CZ_PROFILE, "§ 106 odst. 4 písm. e) ZP"],
  [CZ_PROFILE, "§ 10 písm. ch) ZP"],
  [CZ_PROFILE, "§ 6 odst. 1 písm. b) bod 1 zákona č. 586/1992 Sb."],
  [CZ_PROFILE, "§ 316 odst. 2 věta první ZP"],
  [SK_PROFILE, "§ 2 ods. 1 písm. a) zákona č. 311/2001 Z. z."],
  [SK_PROFILE, "§ 70 ods. 1 zákona o ústavnom súde"],
  [SK_PROFILE, "§ 63 ods. 1 písm. b) bod 2 zákona č. 311/2001 Z. z."],
  [SK_PROFILE, "čl. 46 ods. 1 Ústavy Slovenskej republiky"],
  [SK_PROFILE, "§ 5a zákona č. 311/2001 Z. z."],
] as const;

type Path = Parameters<typeof renderProvisionAnchor>[1];

const path = (overrides: Partial<Path>): Path => ({
  unit: "section",
  section: 1,
  sectionSuffix: null,
  subsection: null,
  letter: null,
  point: null,
  ...overrides,
});

/** Provision paths rendered straight through each profile's scheme. */
const RENDERED: readonly (readonly [string, Path])[] = [
  ["section", path({ section: 316 })],
  ["section suffix", path({ section: 72, sectionSuffix: "a" })],
  ["article", path({ unit: "article", section: 10 })],
  [
    "article subsection",
    path({ unit: "article", section: 46, subsection: "1" }),
  ],
  ["subsection", path({ section: 316, subsection: "2" })],
  ["flat letter", path({ section: 52, letter: "g" })],
  [
    "full path",
    path({
      section: 72,
      sectionSuffix: "a",
      subsection: "1",
      letter: "a",
      point: "1",
    }),
  ],
  ["letter and point", path({ section: 6, letter: "b", point: "2" })],
];

/** Stored anchors, the publisher's own spelling included. */
const STORED: readonly (readonly [CaseLawJurisdiction, string])[] = [
  ["CZE", "par_316"],
  ["CZE", "par_316-odst_2-pism_a-bod_1"],
  ["CZE", "par_5-odst_1-pism_c~2"],
  ["CZE", "par_72a-odst_1~2"],
  ["CZE", "cl_10-odst_1"],
  ["SVK", "paragraf-19.odsek-2.pismeno-l.bod-1.bod-1a"],
  ["SVK", "paragraf-439.odsek-2.pismeno-d"],
  ["SVK", "clanok-46.odsek-1"],
  ["EU", "art_5-par_1-pt_a"],
  ["EU", "art_6-par_1-pt_a-num_2"],
  ["EU", "art_17"],
  ["USA", "s2000e-2/a/1"],
  ["USA", "s1983"],
  ["USA", "s1.401(k)-1/a/4"],
  ["USA", "s1026.18/c/1/i"],
  ["GBR", "section-5-1"],
  ["POL", "art_5-ust_1"],
];

const headingAnchor = (jurisdiction: CaseLawJurisdiction, anchor: string) =>
  provisionHeadingAnchor(anchor, statuteAnchorNestingFor(jurisdiction));

const mint = (): Golden => {
  const golden: Golden = {};
  for (const [jurisdiction, text] of LOCATED) {
    const grammar = PROVISION_CITATION_GRAMMARS[jurisdiction];
    golden[`located ${jurisdiction} ${text}`] =
      grammar.status === "supported"
        ? grammar
            .locateAbbreviatedProvisions(text)
            .map(({ abbreviation, anchor }) => `${abbreviation.eli} ${anchor}`)
        : null;
  }
  for (const [jurisdiction, workIdentifier, printed] of REFERENCES) {
    const grammar = PROVISION_CITATION_GRAMMARS[jurisdiction];
    if (grammar.status !== "supported") {
      golden[`minted ${jurisdiction} ${workIdentifier} ${printed}`] = null;
      continue;
    }
    const reference = grammar.parseReference(printed);
    const anchor = reference === null ? null : grammar.anchor(reference);
    const minted =
      reference === null
        ? null
        : provisionRefOf({ jurisdiction, workIdentifier, reference });
    golden[`minted ${jurisdiction} ${workIdentifier} ${printed}`] = {
      anchor,
      parsedBack:
        anchor === null
          ? null
          : (() => {
              const parsed = grammar.parseAnchor(anchor);
              return parsed === null ? null : grammar.anchor(parsed);
            })(),
      provision:
        minted?.status === "resolved"
          ? `${minted.provision.workIdentifier} ${minted.provision.anchor}`
          : (minted?.status ?? null),
    };
  }
  for (const [profile, text] of RESOLVED) {
    const result = resolveProvisionCitation({
      text,
      profile,
      citedOn: CITED_ON,
    });
    golden[`resolved ${profile.jurisdiction} ${text}`] =
      result.status === "resolved"
        ? {
            anchor: result.anchor,
            readBack: anchorProvisionCitation({
              anchor: result.anchor,
              jurisdiction: profile.jurisdiction,
              workIdentifier: result.workIdentifier,
            }),
            workIdentifier: result.workIdentifier,
          }
        : result.status;
  }
  for (const profile of [CZ_PROFILE, SK_PROFILE]) {
    for (const [label, provision] of RENDERED) {
      golden[`rendered ${profile.jurisdiction} ${label}`] =
        renderProvisionAnchor(profile, provision);
    }
  }
  for (const [jurisdiction, anchor] of STORED) {
    golden[`lineage ${jurisdiction} ${anchor}`] = provisionAnchorLineage({
      jurisdiction,
      anchor,
    });
    golden[`heading ${jurisdiction} ${anchor}`] = headingAnchor(
      jurisdiction,
      anchor,
    );
  }
  golden["keys CZE"] = provisionKeysOfLinks(
    STORED.filter(([jurisdiction]) => jurisdiction === "CZE").map(
      ([, anchor]) => ({ workIdentifier: "262/2006 Sb.", anchor }),
    ),
  );
  golden["filter keys CZE"] = [
    provisionFilterKey({ work: "262/2006 Sb.", unit: "section", section: 316 }),
    provisionFilterKey({
      work: "262/2006 Sb.",
      unit: "section",
      section: 316,
      subsection: "2",
      letter: "A",
    }),
    provisionFilterKey({
      work: "262/2006 Sb.",
      unit: "section",
      section: 72,
      sectionSuffix: "a",
      subsection: "01",
      letter: "a",
      point: "1",
    }),
    provisionFilterKey({
      work: "2/1993 Sb.",
      unit: "article",
      section: 10,
      subsection: "1",
    }),
    provisionFilterKey({
      work: "262/2006 Sb.",
      unit: "section",
      section: 52,
      letter: "g",
    }),
  ];
  return golden;
};

/**
 * One canonical serialization of both sides, so the comparison is exact on
 * every key, its order and every value, whatever line layout the formatter
 * gives the committed file.
 */
const serialize = (golden: unknown): string => JSON.stringify(golden, null, 2);

test("every minted and derived provision anchor matches the golden file byte for byte", async () => {
  const committed: unknown = JSON.parse(await Bun.file(GOLDEN).text());
  expect(serialize(mint())).toBe(serialize(committed));
});
