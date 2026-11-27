import { describe, expect, test } from "bun:test";

import { readLetterHead } from "@/api/lib/templates/house-style/letter-head";
import { manifestOf } from "@/api/lib/templates/house-style/manifest.test-helpers";

// All names and addresses here are invented.
describe("readLetterHead", () => {
  test("reads the addressee, the date and the reference in front of the salutation", () => {
    const { blocks } = manifestOf([
      "Alfa Dodávky s.r.o.",
      "k rukám Ing. Jany Novákové",
      "Dlouhá 12",
      "110 00 Praha 1",
      "",
      "V Brně dne 6. 1. 2026",
      "Naše značka: 123/2026",
      "Věc: Výzva k úhradě",
      "Vážená paní inženýrko,",
      "obracíme se na Vás ve věci neuhrazené faktury ze dne 1. 12. 2025.",
      "S pozdravem",
    ]);
    expect(readLetterHead(blocks)).toEqual({
      addressee: ["p0", "p1", "p2", "p3"],
      date: "p5",
      reference: "p6",
    });
  });

  test("a sentence with a date in it is no date line, and a blank line parts the sender's address from the addressee's", () => {
    const { blocks } = manifestOf([
      "Gama Stavby a.s.",
      "Krátká 2",
      "602 00 Brno",
      "",
      "Alfa Dodávky s.r.o.",
      "Dlouhá 12",
      "110 00 Praha 1",
      "",
      "Dne 6. 1. 2026 jsme obdrželi Váš dopis.",
      "Vážená paní inženýrko,",
      "odpovídáme na Vaši výzvu.",
    ]);
    expect(readLetterHead(blocks)).toMatchObject({
      // The block nearest to the salutation: the addressee's alone.
      addressee: ["p4", "p5", "p6"],
      date: null,
    });
  });

  test("an English and a German head", () => {
    expect(
      readLetterHead(
        manifestOf([
          "Our ref: AB/2026/17",
          "4 September 2026",
          "Beta Holdings Ltd",
          "1 Long Street",
          "London SW1A 1AA",
          "Dear Sirs,",
          "We write further to your letter.",
        ]).blocks,
      ),
    ).toEqual({ addressee: ["p2", "p3", "p4"], date: "p1", reference: "p0" });
    expect(
      readLetterHead(
        manifestOf([
          "Gamma GmbH",
          "Kurze Gasse 3",
          "66123 Saarbrücken",
          "Sehr geehrte Damen und Herren,",
          "wir nehmen Bezug auf Ihr Schreiben.",
        ]).blocks,
      ),
    ).toEqual({ addressee: ["p0", "p1", "p2"], date: null, reference: null });
  });

  test("no salutation, or nothing in front of it that reads as a head, is no letter head", () => {
    expect(
      readLetterHead(
        manifestOf(["SMLOUVA", "Článek I.", "Text ustanovení."]).blocks,
      ),
    ).toBeNull();
    // Lines without a postal code are not taken for an address; a sentence
    // with a date in it is no date line.
    expect(
      readLetterHead(
        manifestOf([
          "Odpověď na dotazy uchazečů",
          "Veřejná zakázka na dodávky",
          "Dne 6. 1. 2026 jsme obdrželi žádost o vysvětlení zadávací dokumentace.",
          "Vážení uchazeči,",
          "odpovídáme na Vaše dotazy.",
        ]).blocks,
      ),
    ).toBeNull();
  });
});
