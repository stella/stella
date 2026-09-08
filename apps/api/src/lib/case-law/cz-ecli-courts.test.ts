import { describe, expect, test } from "bun:test";

import { COURT_WEIGHT_SEED } from "@/api/handlers/case-law/court-weight-seed";
import {
  CZ_ECLI_COURTS,
  czCourtFromEcli,
  czDecisionCourt,
} from "@/api/lib/case-law/cz-ecli-courts";

/** An ECLI in the shape the Czech portals publish, for an arbitrary court. */
const ecliOf = (code: string): string => `ECLI:CZ:${code}:2011:75.CO.19.2011.1`;

const declared = Object.entries(CZ_ECLI_COURTS);

describe("czCourtFromEcli", () => {
  test("names the court of every code the map declares", () => {
    const resolved = declared.map(([code]) => {
      const found = czCourtFromEcli(ecliOf(code));
      return [code, found.type === "named" ? found.court : found.type];
    });
    expect(resolved).toEqual(declared);
  });

  test("gives each court one name, so a court is one shelf", () => {
    const names = Object.values(CZ_ECLI_COURTS);
    expect(new Set(names).size).toBe(names.length);
  });

  test("reports a code it does not know rather than mapping it", () => {
    expect(czCourtFromEcli(ecliOf("XXXX"))).toEqual({
      type: "unknown-code",
      code: "XXXX",
    });
  });

  test("states nothing for a missing or non-Czech identifier", () => {
    expect(czCourtFromEcli(undefined).type).toBe("unstated");
    expect(czCourtFromEcli("ECLI:SK:NSSR:2020:1.Sz.1.2020.1").type).toBe(
      "unstated",
    );
    expect(czCourtFromEcli("not an ecli").type).toBe("unstated");
  });
});

describe("czDecisionCourt", () => {
  const publisher = {
    adapterKey: "cz-ns",
    publisherCourt: "Nejvyšší soud",
    sourceDocumentId: "0000000000000000000000000000000A",
  };

  test("attributes a decision to the court its ECLI names, not the publisher", () => {
    expect(
      czDecisionCourt({
        ...publisher,
        ecli: "ECLI:CZ:KSOS:2011:75.CO.19.2011.1",
        statedCourt: "Krajský soud v Ostravě",
      }),
    ).toBe("Krajský soud v Ostravě");
  });

  test("gives one court one name where the publisher spells it two ways", () => {
    const spellings = [
      "Krajský soud v Hradci Králové - pobočka Pardubice",
      "Krajský soud v Hradci Králové - pobočka v Pardubicích",
    ].map((statedCourt) =>
      czDecisionCourt({
        ...publisher,
        ecli: "ECLI:CZ:KSHKPA:2019:52.AF.4.2019.1",
        statedCourt,
      }),
    );
    expect(new Set(spellings).size).toBe(1);
  });

  test("falls back to the court the source states when the ECLI names none", () => {
    expect(
      czDecisionCourt({
        ...publisher,
        ecli: undefined,
        statedCourt: "Okresní soud v Ostravě",
      }),
    ).toBe("Okresní soud v Ostravě");
  });

  test("takes the publisher's court only when nothing states one", () => {
    expect(czDecisionCourt({ ...publisher, ecli: undefined })).toBe(
      "Nejvyšší soud",
    );
  });

  test("never resolves an unknown court code to the publisher's court", () => {
    expect(
      czDecisionCourt({
        ...publisher,
        ecli: ecliOf("ZZZZ"),
        statedCourt: "Okresní soud v Ostravě",
      }),
    ).toBe("Okresní soud v Ostravě");
    expect(czDecisionCourt({ ...publisher, ecli: ecliOf("ZZZZ") })).toBe(
      "ZZZZ",
    );
  });
});

/**
 * The rank the registry gives a court name, or the default tier for a court
 * no pattern names. Read off the seed rather than the table, because it is
 * the seed that has to agree with the names this map resolves to.
 */
const seededTier = (court: string): number =>
  Math.max(
    1,
    ...COURT_WEIGHT_SEED.filter(
      (row) =>
        row.country === "CZE" && new RegExp(row.courtPattern, "iu").test(court),
    ).map((row) => row.tier),
  );

describe("court weights", () => {
  /**
   * The names this map resolves to are what the authority tier is read off,
   * so a court it can name that outranks its place in the hierarchy would
   * carry weight it never had. Storing every one of these under the Supreme
   * Court's name is exactly that fault.
   */
  test("ranks no lower court as high as the Supreme Court", () => {
    const supreme = seededTier(CZ_ECLI_COURTS.NS);
    const lower = Object.entries(CZ_ECLI_COURTS)
      .filter(([code]) => !["NS", "NSS", "US"].includes(code))
      .filter(([, court]) => seededTier(court) >= supreme);
    expect(lower).toEqual([]);
  });

  test("ranks the Constitutional Court above the Supreme Court", () => {
    expect(seededTier(CZ_ECLI_COURTS.NS)).toBeLessThan(
      seededTier(CZ_ECLI_COURTS.US),
    );
  });
});
