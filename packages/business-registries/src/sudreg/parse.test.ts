import { describe, expect, test } from "bun:test";

import { SudregParseError } from "./errors.js";
import { parseAddress, parseCompanyPage } from "./parse.js";

const FIXTURE = new URL("__fixtures__/company.html", import.meta.url);

describe("SUDREG parser", () => {
  test("parses the registry sections without a DOM implementation", async () => {
    const html = await Bun.file(FIXTURE).text();
    expect(parseCompanyPage(html, "080000014")).toEqual({
      mbs: "080000014",
      name: "PRIMJER DIONIČKO DRUŠTVO & PARTNERI",
      address: {
        street: "Trg primjera",
        houseNumber: "10",
        orientationNumber: "2",
        orientationLetter: "A",
        municipalityPart: "Zagreb",
        municipality: "Zagreb",
        textAddress: "Zagreb (Grad Zagreb), Trg primjera 10/2 A",
      },
      shareCapital: "850.068.230,00 euro",
      legalForm: "dioničko društvo",
      warnings: [],
      registryUrl:
        "https://sudreg.pravosudje.hr/ords/r/esudreg/public/28?p28_sbt_mbs=080000014",
    });
  });

  test("handles a municipality without a Grad or Općina wrapper", () => {
    expect(parseAddress("Rijeka\nUlica lipa 12")).toEqual({
      address: {
        street: "Ulica lipa",
        houseNumber: "12",
        orientationNumber: null,
        orientationLetter: null,
        municipalityPart: null,
        municipality: "Rijeka",
        textAddress: "Rijeka, Ulica lipa 12",
      },
      warnings: [],
    });
  });

  test("parses a roman orientation suffix without losing the street", () => {
    expect(parseAddress("Rijeka\nUlica lipa 12/V")).toEqual({
      address: {
        street: "Ulica lipa",
        houseNumber: "12",
        orientationNumber: null,
        orientationLetter: "V",
        municipalityPart: null,
        municipality: "Rijeka",
        textAddress: "Rijeka, Ulica lipa 12/V",
      },
      warnings: [],
    });
  });

  test.each([
    ["Ilica 12A", "12", null, "A"],
    ["Ilica 12/2A", "12", "2", "A"],
    ["Ilica 12/V", "12", null, "V"],
    ["Ilica 12/2 A", "12", "2", "A"],
  ])(
    "parses compact Croatian street number %s",
    (line, houseNumber, orientationNumber, orientationLetter) => {
      expect(parseAddress(`Zagreb\n${line}`).address).toMatchObject({
        street: "Ilica",
        houseNumber,
        orientationNumber,
        orientationLetter,
      });
    },
  );

  test("accepts the alternate official company-name heading", () => {
    expect(
      parseCompanyPage(
        '<h2 class="srn-kat-title">MBS</h2><table><tr><td>050023577</td></tr></table><h2 class="srn-kat-title">Naziv</h2><table><tr><td>PRIMJER d.o.o.</td></tr></table>',
        "050023577",
      )?.name,
    ).toBe("PRIMJER d.o.o.");
  });

  test("rejects a response for a different registry identifier", () => {
    expect(() =>
      parseCompanyPage(
        '<h2 class="srn-kat-title">MBS</h2><table><tr><td>080000014</td></tr></table><h2 class="srn-kat-title">Tvrtka</h2><table><tr><td>PRIMJER d.o.o.</td></tr></table>',
        "050023577",
      ),
    ).toThrow(SudregParseError);
  });

  test("surfaces a warning instead of guessing an unknown parenthesized address", () => {
    expect(parseAddress("Zagreb (nepoznato)\nIlica 1").warnings).toEqual([
      { type: "unexpected-address-format" },
    ]);
  });

  test("returns null for the registry not-found sentinel", () => {
    expect(
      parseCompanyPage(
        "U sudskom registru nije evidentirano društvo sa zadanim matičnim brojem",
        "080015009",
      ),
    ).toBeNull();
  });

  test("fails loudly when the response no longer contains the company name", () => {
    expect(() =>
      parseCompanyPage(
        '<h2 class="srn-kat-title">MBS</h2><table><tr><td>080000014</td></tr></table>',
        "080000014",
      ),
    ).toThrow(SudregParseError);
  });
});
