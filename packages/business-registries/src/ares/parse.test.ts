import { describe, expect, test } from "bun:test";

import { enrichWithVr, parseAddress, parseResRecord } from "./parse.js";
import type { AresVrResponse } from "./types.js";

describe("parseAddress", () => {
  test("treats null numeric address fields as missing", () => {
    const address = parseAddress({
      cisloDomovni: null,
      cisloOrientacni: null,
      psc: null,
      pscTxt: "110 00",
    });

    expect(address.houseNumber).toBeNull();
    expect(address.orientationNumber).toBeNull();
    expect(address.postalCode).toBe("110 00");
  });
});

describe("enrichWithVr", () => {
  test.each([
    ["MSPH", "Městský soud v Praze"],
    ["KSCB", "Krajský soud v Českých Budějovicích"],
    ["KSPL", "Krajský soud v Plzni"],
    ["KSUL", "Krajský soud v Ústí nad Labem"],
    ["KSHK", "Krajský soud v Hradci Králové"],
    ["KSBR", "Krajský soud v Brně"],
    ["KSOS", "Krajský soud v Ostravě"],
    ["Městský soud v Praze", "Městský soud v Praze"],
    ["UNKNOWN", "UNKNOWN"],
  ])("expands court %s without changing the file reference", (court, name) => {
    const company = parseResRecord({
      ico: "27082440",
      obchodniJmeno: "Alza.cz a.s.",
      primarniZaznam: true,
    });
    const vr = {
      icoId: company.ico,
      zaznamy: [
        {
          primarniZaznam: true,
          spisovaZnacka: [{ soud: court, oddil: "B", vlozka: "8573" }],
        },
      ],
    } satisfies AresVrResponse;
    const result = enrichWithVr(company, vr);
    expect(result.courtFile).toEqual({
      court: name,
      section: "B",
      insert: "8573",
    });
  });

  test("keeps raw share capital text when the VR value is not numeric", () => {
    const company = parseResRecord({
      ico: "12345678",
      obchodniJmeno: "Example s.r.o.",
      primarniZaznam: true,
    });
    const vr = {
      icoId: "12345678",
      zaznamy: [
        {
          primarniZaznam: true,
          zakladniKapital: [
            {
              vklad: {
                hodnota: "not-a-number",
                typObnos: "KORUNY",
              },
            },
          ],
        },
      ],
    } satisfies AresVrResponse;

    expect(enrichWithVr(company, vr).shareCapital).toBe("not-a-number Kč");
  });

  test.each([
    ["50000;00", "50 000,- Kč"],
    ["50000;25", "50 000,25 Kč"],
    ["9007199254740993;75", "9 007 199 254 740 993,75 Kč"],
    ["0;50", "0,50 Kč"],
  ])("preserves the capital amount %s in Czech output", (value, expected) => {
    const company = parseResRecord({
      ico: "12345678",
      obchodniJmeno: "Example s.r.o.",
      primarniZaznam: true,
    });
    const result = enrichWithVr(company, {
      icoId: company.ico,
      zaznamy: [
        {
          primarniZaznam: true,
          zakladniKapital: [{ vklad: { hodnota: value, typObnos: "KORUNY" } }],
          statutarniOrgany: [
            {
              zpusobJednani: [
                { hodnota: "  Jednatel   jedná samostatně. " },
                { hodnota: "Podepisuje se za společnost." },
                { hodnota: "Neplatné pravidlo.", datumVymazu: "2020-01-01" },
              ],
            },
          ],
        },
      ],
    });
    expect(result.shareCapital).toBe(expected);
    expect(result.actingClause).toBe(
      "Jednatel jedná samostatně.\n\nPodepisuje se za společnost.",
    );
  });
});
