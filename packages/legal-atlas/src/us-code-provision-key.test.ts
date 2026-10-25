/**
 * US code citations through the jurisdiction-neutral identity boundary: a
 * located citation mints a provision key, the key parses back to the same
 * identity, and the grammar's work and anchor readings agree with it.
 */

import { describe, expect, test } from "bun:test";

import { PROVISION_CITATION_GRAMMARS } from "./provision-citation-grammars";
import { parseProvisionKey, provisionRefOf } from "./provision-key";

const usa = PROVISION_CITATION_GRAMMARS.USA;

const keyOf = (text: string) => {
  const [located] = usa.locateAbbreviatedProvisions(text);
  if (located === undefined) {
    throw new Error(`no citation in ${text}`);
  }
  const minted = provisionRefOf({
    jurisdiction: "USA",
    workIdentifier: located.abbreviation.canonicalAbbreviation,
    reference: located.reference,
  });
  if (minted.status !== "resolved") {
    throw new Error(`${text} did not mint: ${minted.status}`);
  }
  return { located, provision: minted.provision };
};

describe("US provision keys", () => {
  test("a located citation mints its section's identity and anchor", () => {
    const { located, provision } = keyOf("42 U.S.C. § 2000e-2(a)(1)");
    expect(provision).toMatchObject({
      jurisdiction: "USA",
      workIdentifier: "42 U.S.C. 2000e-2",
      workEli: "/us/usc/t42/s2000e-2",
      anchor: "s2000e-2/a/1",
    });
    expect(located.anchor).toBe(provision.anchor);
  });

  test("the key's canonical frame parses back to the same identity", () => {
    for (const text of [
      "42 U.S.C. § 1983",
      "12 C.F.R. § 1026.18(c)(1)(i)",
      "Treas. Reg. § 1.401(k)-1(a)(4)(iii)",
    ]) {
      const { provision } = keyOf(text);
      const frame = JSON.stringify([
        provision.jurisdiction,
        provision.workIdentifier,
        provision.anchor,
      ]);
      const decoded = parseProvisionKey(frame);
      expect(
        decoded === null
          ? null
          : [decoded.jurisdiction, decoded.workIdentifier, decoded.anchor],
      ).toEqual([
        provision.jurisdiction,
        provision.workIdentifier,
        provision.anchor,
      ]);
    }
  });

  test("a key names a work only by its canonical identifier", () => {
    for (const frame of [
      ["USA", "42 U.S.C. § 1983", "s1983"],
      ["USA", "42 USC 1983", "s1983"],
      ["USA", "55 U.S.C. 1", "s1"],
      ["USA", "42 U.S.C. 1983", "par_1983"],
      ["USA", "42 U.S.C. 1983", "s1983/"],
    ]) {
      expect(parseProvisionKey(JSON.stringify(frame))).toBeNull();
    }
  });

  test("the work a printed citation names resolves to its corpus ELI", () => {
    expect(usa.gazette.parse("42 U.S.C. § 1983")).toEqual({
      identifier: "42 U.S.C. 1983",
      eli: "/us/usc/t42/s1983",
    });
    expect(usa.gazette.parse("12 CFR 1026.18")).toEqual({
      identifier: "12 C.F.R. 1026.18",
      eli: "https://www.ecfr.gov/current/title-12/section-1026.18",
    });
    expect(
      usa.gazette.parse("42 U.S.C. § 1983 and 28 U.S.C. § 1331"),
    ).toBeNull();
    expect(usa.gazette.parse("the United States Code")).toBeNull();
  });

  test("a reference minted elsewhere is held to the codes' shapes", () => {
    const { located } = keyOf("42 U.S.C. § 1983(a)");
    for (const reference of [
      { ...located.reference, letter: "a" },
      { ...located.reference, unit: "article" as const },
      { ...located.reference, subsection: "a" },
    ]) {
      expect(
        provisionRefOf({
          jurisdiction: "USA",
          workIdentifier: "42 U.S.C. 1983",
          reference,
        }),
      ).toEqual({ status: "invalid_reference" });
    }
  });

  test("a regulation of part 0 mints its key; grammars that start at 1 refuse it", () => {
    const { located, provision } = keyOf("28 C.F.R. § 0.85(a)");
    expect(provision).toMatchObject({
      workIdentifier: "28 C.F.R. 0.85",
      anchor: "s0.85/a",
    });
    expect(
      PROVISION_CITATION_GRAMMARS.EU.normalizeReference({
        ...located.reference,
        unit: "article",
        section: 0,
        sectionSuffix: null,
        subsection: null,
      }),
    ).toBeNull();
  });

  test("labels read in the codes' own printed form", () => {
    const { provision } = keyOf("12 C.F.R. § 1026.18(c)(1)");
    expect(usa.citationForm.type).toBe("printed");
    expect(usa.citationForm.format(provision.reference)).toBe(
      "§ 1026.18(c)(1)",
    );
  });
});
