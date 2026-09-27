import { describe, expect, test } from "bun:test";

import { courtAbbreviation } from "@/api/lib/case-law/court-abbreviations";

type Case = {
  name: string;
  country: string;
  court: string;
  ecli?: string | null;
  expected: string | undefined;
};

/**
 * The ECLI decides wherever it names a court: its third segment is the court's
 * national code, and a seat-bearing code reads as its family.
 */
const ECLI_CASES: readonly Case[] = [
  {
    name: "CZ supreme court",
    country: "CZE",
    court: "Nejvyšší soud",
    ecli: "ECLI:CZ:NS:2019:25.CDO.1734.2018.1",
    expected: "NS",
  },
  {
    name: "CZ supreme administrative court",
    country: "CZE",
    court: "Nejvyšší správní soud",
    ecli: "ECLI:CZ:NSS:2021:6.AFS.34.2021.44",
    expected: "NSS",
  },
  {
    name: "CZ constitutional court",
    country: "CZE",
    court: "Ústavní soud",
    ecli: "ECLI:CZ:US:1997:1.US.281.97",
    expected: "ÚS",
  },
  {
    name: "CZ regional court reads as its family",
    country: "CZE",
    court: "Krajský soud v Ostravě",
    ecli: "ECLI:CZ:KSOS:2011:75.CO.19.2011.1",
    expected: "KS",
  },
  {
    name: "CZ regional court branch reads as its family",
    country: "CZE",
    court: "Krajský soud v Hradci Králové – pobočka v Pardubicích",
    ecli: "ECLI:CZ:KSHKPA:2020:52.CO.10.2020.1",
    expected: "KS",
  },
  {
    name: "CZ city court reads as its family",
    country: "CZE",
    court: "Městský soud v Praze",
    ecli: "ECLI:CZ:MSPH:2018:11.CO.4.2018.1",
    expected: "MS",
  },
  {
    name: "CZ district court reads as its family",
    country: "CZE",
    court: "Okresní soud Plzeň-město",
    ecli: "ECLI:CZ:OSPZ:2016:11.C.153.2016.1",
    expected: "OS",
  },
  {
    name: "CZ high court reads as its family",
    country: "CZE",
    court: "Vrchní soud v Olomouci",
    ecli: "ECLI:CZ:VSOL:2015:1.VSOL.100.2015.1",
    expected: "VS",
  },
  {
    name: "SK constitutional court",
    country: "SVK",
    court: "Ústavný súd SR",
    ecli: "ECLI:SK:USSR:2020:1.US.1.2020.1",
    expected: "ÚS",
  },
  {
    name: "SK supreme court code is not an NS-prefixed family",
    country: "SVK",
    court: "Najvyšší súd Slovenskej republiky",
    ecli: "ECLI:SK:NSSR:2019:1.Cdo.1.2019.1",
    expected: "NS",
  },
  {
    name: "SK supreme administrative court",
    country: "SVK",
    court: "Najvyšší správny súd SR",
    ecli: "ECLI:SK:NSSSR:2022:1.Sak.1.2022.1",
    expected: "NSS",
  },
  {
    name: "SK district court reads as its family",
    country: "SVK",
    court: "Okresný súd Bratislava I",
    ecli: "ECLI:SK:OSBA1:2019:0T.42.2019.1",
    expected: "OS",
  },
  {
    name: "PL supreme court",
    country: "POL",
    court: "Sąd Najwyższy",
    ecli: "ECLI:PL:SN:2020:I.CSK.1.20",
    expected: "SN",
  },
  {
    name: "PL supreme administrative court",
    country: "POL",
    court: "Naczelny Sąd Administracyjny",
    ecli: "ECLI:PL:NSA:2020:II.FSK.1.18",
    expected: "NSA",
  },
  {
    name: "PL constitutional tribunal",
    country: "POL",
    court: "Trybunał Konstytucyjny",
    ecli: "ECLI:PL:TK:2019:K.1.19",
    expected: "TK",
  },
  {
    name: "PL voivodeship administrative court wins over the appellate prefix",
    country: "POL",
    court: "Wojewódzki Sąd Administracyjny w Warszawie",
    ecli: "ECLI:PL:WSAWA:2021:III.SA.WA.1.21",
    expected: "WSA",
  },
  {
    name: "PL appellate court reads as its family",
    country: "POL",
    court: "Sąd Apelacyjny w Katowicach",
    ecli: "ECLI:PL:SAKA:2018:I.ACa.1.18",
    expected: "SA",
  },
  {
    name: "PL district court reads as its family",
    country: "POL",
    court: "Sąd Rejonowy w Białymstoku",
    ecli: "ECLI:PL:SRBIA:2015:II.Co.433.15",
    expected: "SR",
  },
  {
    name: "PL regional court reads as its family",
    country: "POL",
    court: "Sąd Okręgowy w Warszawie",
    ecli: "ECLI:PL:SOWA:2017:XXV.C.1.17",
    expected: "SO",
  },
  {
    name: "EU court of justice",
    country: "EU",
    court: "Court of Justice",
    ecli: "ECLI:EU:C:2019:772",
    expected: "CJEU",
  },
  {
    name: "EU general court",
    country: "EU",
    court: "General Court",
    ecli: "ECLI:EU:T:2020:394",
    expected: "GC",
  },
];

/** No ECLI: only the apex courts have a name a reader abbreviates. */
const NAME_CASES: readonly Case[] = [
  {
    name: "CZ constitutional court by name",
    country: "CZE",
    court: "Ústavní soud",
    expected: "ÚS",
  },
  {
    name: "CZ supreme administrative court is not read as the supreme court",
    country: "CZE",
    court: "Nejvyšší správní soud",
    expected: "NSS",
  },
  {
    name: "CZ supreme court by name",
    country: "CZE",
    court: "Nejvyšší soud",
    expected: "NS",
  },
  {
    name: "SK constitutional court by name",
    country: "SVK",
    court: "Ústavný súd Slovenskej republiky",
    expected: "ÚS",
  },
  {
    name: "SK supreme administrative court by name",
    country: "SVK",
    court: "Najvyšší správny súd Slovenskej republiky",
    expected: "NSS",
  },
  {
    name: "SK supreme court by name",
    country: "SVK",
    court: "Najvyšší súd Slovenskej republiky",
    expected: "NS",
  },
  {
    name: "PL constitutional tribunal by name",
    country: "POL",
    court: "Trybunał Konstytucyjny",
    expected: "TK",
  },
  {
    name: "PL supreme administrative court by name",
    country: "POL",
    court: "Naczelny Sąd Administracyjny",
    expected: "NSA",
  },
  {
    name: "PL supreme court by name",
    country: "POL",
    court: "Sąd Najwyższy",
    expected: "SN",
  },
  {
    name: "HU constitutional court by name",
    country: "HUN",
    court: "Alkotmánybíróság",
    expected: "AB",
  },
  {
    name: "HU supreme court by name",
    country: "HUN",
    court: "Kúria",
    expected: "Kúria",
  },
  {
    name: "HU supreme court under its pre-2012 name",
    country: "HUN",
    court: "Legfelsőbb Bíróság",
    expected: "LB",
  },
  {
    name: "US supreme court by its canonical name",
    country: "USA",
    court: "Supreme Court of the United States",
    expected: "SCOTUS",
  },
  {
    name: "EU court of justice by name",
    country: "EU",
    court: "Court of Justice",
    expected: "CJEU",
  },
  {
    name: "EU general court by name",
    country: "EU",
    court: "General Court",
    expected: "GC",
  },
];

/** Nothing states an abbreviation, so the chip is absent rather than invented. */
const UNKNOWN_CASES: readonly Case[] = [
  {
    name: "a regional court with no ECLI",
    country: "CZE",
    court: "Krajský soud v Ostravě",
    expected: undefined,
  },
  {
    name: "a district court with no ECLI",
    country: "POL",
    court: "Sąd Rejonowy w Białymstoku",
    expected: undefined,
  },
  {
    name: "a Hungarian regional court, which is not apex",
    country: "HUN",
    court: "Fővárosi Törvényszék",
    expected: undefined,
  },
  {
    name: "a US court outside the enrolled apex",
    country: "USA",
    court: "United States Court of Appeals for the Ninth Circuit",
    expected: undefined,
  },
  {
    name: "a state supreme court, which is not the federal apex",
    country: "USA",
    court: "Supreme Court of California",
    expected: undefined,
  },
  {
    name: "an ECLI court code the tables do not know",
    country: "CZE",
    court: "Zvláštní soud",
    ecli: "ECLI:CZ:ZZZ:2020:1.A.1.2020.1",
    expected: undefined,
  },
  {
    name: "an ECLI of a jurisdiction with no code table",
    country: "CZE",
    court: "Oberster Gerichtshof",
    ecli: "ECLI:AT:OGH0002:2020:0010OB00001.20A.0101.000",
    expected: undefined,
  },
  {
    name: "a country with no apex patterns",
    country: "AUT",
    court: "Oberster Gerichtshof",
    expected: undefined,
  },
  {
    name: "a malformed ECLI falls through to the name",
    country: "CZE",
    court: "Krajský soud v Brně",
    ecli: "not-an-ecli",
    expected: undefined,
  },
  {
    name: "a null ECLI",
    country: "CZE",
    court: "Krajský soud v Brně",
    ecli: null,
    expected: undefined,
  },
];

describe("courtAbbreviation", () => {
  describe.each([
    ["from an ECLI court code", ECLI_CASES],
    ["from an apex-court name", NAME_CASES],
    ["with nothing to read it from", UNKNOWN_CASES],
  ] as const)("%s", (_group, cases) => {
    test.each(cases.map((testCase) => [testCase.name, testCase] as const))(
      "%s",
      (_name, { country, court, ecli, expected }) => {
        expect(courtAbbreviation({ country, court, ecli })).toBe(expected);
      },
    );
  });

  test("a malformed ECLI still takes the apex-court name", () => {
    expect(
      courtAbbreviation({
        country: "CZE",
        court: "Ústavní soud",
        ecli: "ECLI-broken",
      }),
    ).toBe("ÚS");
  });

  test("the ECLI outranks the name it disagrees with", () => {
    // The Supreme Court's database publishes regional judgments; the ECLI is
    // what says the row is not the publisher's own.
    expect(
      courtAbbreviation({
        country: "CZE",
        court: "Nejvyšší soud",
        ecli: "ECLI:CZ:KSOS:2011:75.CO.19.2011.1",
      }),
    ).toBe("KS");
  });
});
