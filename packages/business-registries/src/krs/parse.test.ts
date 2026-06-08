import { describe, expect, test } from "bun:test";

import { parseAddress, parseEntity, parseStatus } from "./parse.js";
import type { KrsLookupResponse, KrsRawAdres } from "./types.js";

describe("parseAddress", () => {
  test("composes a Polish street address from atoms", () => {
    const address = parseAddress({
      ulica: "JAGIELLOŃSKA",
      nrDomu: "74",
      miejscowosc: "WARSZAWA",
      kodPocztowy: "03-301",
      poczta: "WARSZAWA",
      kraj: "POLSKA",
    });
    expect(address.street).toBe("JAGIELLOŃSKA 74");
    expect(address.postalCode).toBe("03-301");
    expect(address.city).toBe("WARSZAWA");
    expect(address.country).toBe("POLSKA");
    expect(address.textAddress).toBe(
      "JAGIELLOŃSKA 74, 03-301 WARSZAWA, POLSKA",
    );
  });

  test("renders nrDomu / nrLokalu with a slash separator", () => {
    // Polish addresses commonly carry both a building number and an
    // apartment / suite number; the registry stores them separately
    // and we render `12 / 5` so the formatted output matches the
    // citizen-facing convention.
    const address = parseAddress({
      ulica: "MARSZAŁKOWSKA",
      nrDomu: "12",
      nrLokalu: "5",
      miejscowosc: "WARSZAWA",
      kodPocztowy: "00-001",
      kraj: "POLSKA",
    });
    expect(address.street).toBe("MARSZAŁKOWSKA 12 / 5");
  });

  test("falls back to the house segment when no street is set", () => {
    // Small municipalities sometimes file an address without
    // `ulica`; the parser must surface what it has rather than
    // emitting a null street line for an otherwise-complete record.
    const address = parseAddress({
      nrDomu: "10",
      miejscowosc: "MAŁA WIEŚ",
      kodPocztowy: "12-345",
      kraj: "POLSKA",
    });
    expect(address.street).toBe("10");
    expect(address.textAddress).toBe("10, 12-345 MAŁA WIEŚ, POLSKA");
  });

  test("returns nulls when no address fields are populated", () => {
    const empty: KrsRawAdres = {};
    expect(parseAddress(empty)).toEqual({
      street: null,
      postalCode: null,
      city: null,
      country: null,
      textAddress: null,
    });
  });
});

describe("parseStatus", () => {
  test("maps an entity with no lifecycle entries to `active`", () => {
    expect(parseStatus(undefined, "CD PROJEKT SPÓŁKA AKCYJNA")).toEqual({
      type: "active",
    });
    expect(parseStatus({}, "CD PROJEKT SPÓŁKA AKCYJNA")).toEqual({
      type: "active",
    });
  });

  test("maps `postepowanieUpadlosciowe` entries to `bankruptcy`", () => {
    expect(
      parseStatus(
        { postepowanieUpadlosciowe: [{ data: "01.01.2026" }] },
        "ACME SPÓŁKA AKCYJNA W UPADŁOŚCI",
      ),
    ).toEqual({ type: "bankruptcy" });
  });

  test("maps an explicit liquidation proceeding to `liquidating`", () => {
    expect(
      parseStatus(
        {
          postepowanieRestrukturyzacyjneNaprawczePrzymusowaRestrukturyzacjaUporzadkowanaLikwidacja:
            [
              {
                otwarciePostepowaniaRestrukturyzacyjnegoNaprawczegoPrzymusowejRestrukturyzacjiUporzadkowanejLikwidacji:
                  { rodzajPostepowania: "POSTĘPOWANIE LIKWIDACYJNE" },
              },
            ],
        },
        "ACME SP. Z O.O.",
      ),
    ).toEqual({ type: "liquidating" });
  });

  test("maps an orderly-liquidation proceeding to `liquidating`", () => {
    expect(
      parseStatus(
        {
          postepowanieRestrukturyzacyjneNaprawczePrzymusowaRestrukturyzacjaUporzadkowanaLikwidacja:
            [
              {
                otwarciePostepowaniaRestrukturyzacyjnegoNaprawczegoPrzymusowejRestrukturyzacjiUporzadkowanejLikwidacji:
                  { rodzajPostepowania: "UPORZĄDKOWANA LIKWIDACJA" },
              },
            ],
        },
        "ACME SP. Z O.O.",
      ),
    ).toEqual({ type: "liquidating" });
  });

  test("maps a restructuring proceeding to `restructuring`, NOT `liquidating`", () => {
    // The combined dzial6 array conflates restructuring with
    // liquidation. Collapsing every entry to `liquidating` would
    // misstate live restructurings as dissolutions — the bot caught
    // this against the committed Getin Noble fixture, which carries
    // `rodzajPostepowania: "PRZYMUSOWA RESTRUKTURYZACJA"`.
    expect(
      parseStatus(
        {
          postepowanieRestrukturyzacyjneNaprawczePrzymusowaRestrukturyzacjaUporzadkowanaLikwidacja:
            [
              {
                otwarciePostepowaniaRestrukturyzacyjnegoNaprawczegoPrzymusowejRestrukturyzacjiUporzadkowanejLikwidacji:
                  { rodzajPostepowania: "PRZYMUSOWA RESTRUKTURYZACJA" },
              },
            ],
        },
        "ACME SP. Z O.O.",
      ),
    ).toEqual({ type: "restructuring" });
  });

  test("maps a repair (naprawcze) proceeding to `restructuring`", () => {
    expect(
      parseStatus(
        {
          postepowanieRestrukturyzacyjneNaprawczePrzymusowaRestrukturyzacjaUporzadkowanaLikwidacja:
            [
              {
                otwarciePostepowaniaRestrukturyzacyjnegoNaprawczegoPrzymusowejRestrukturyzacjiUporzadkowanejLikwidacji:
                  { rodzajPostepowania: "POSTĘPOWANIE NAPRAWCZE" },
              },
            ],
        },
        "ACME SP. Z O.O.",
      ),
    ).toEqual({ type: "restructuring" });
  });

  test("ANY liquidation entry wins when proceedings are mixed", () => {
    expect(
      parseStatus(
        {
          postepowanieRestrukturyzacyjneNaprawczePrzymusowaRestrukturyzacjaUporzadkowanaLikwidacja:
            [
              {
                otwarciePostepowaniaRestrukturyzacyjnegoNaprawczegoPrzymusowejRestrukturyzacjiUporzadkowanejLikwidacji:
                  { rodzajPostepowania: "PRZYMUSOWA RESTRUKTURYZACJA" },
              },
              {
                otwarciePostepowaniaRestrukturyzacyjnegoNaprawczegoPrzymusowejRestrukturyzacjiUporzadkowanejLikwidacji:
                  { rodzajPostepowania: "POSTĘPOWANIE LIKWIDACYJNE" },
              },
            ],
        },
        "ACME SP. Z O.O.",
      ),
    ).toEqual({ type: "liquidating" });
  });

  test("ignores closed combined proceedings before setting status", () => {
    expect(
      parseStatus(
        {
          postepowanieRestrukturyzacyjneNaprawczePrzymusowaRestrukturyzacjaUporzadkowanaLikwidacja:
            [
              {
                zakonczeniePostepowaniaRestrukturyzacyjnegoNaprawczegoPrzymusowejRestrukturyzacjiUporzadkowanejLikwidacji:
                  { rodzajPostepowania: "POSTĘPOWANIE LIKWIDACYJNE" },
              },
            ],
        },
        "ACME SP. Z O.O.",
      ),
    ).toEqual({ type: "active" });
  });

  test("treats empty combined close placeholders as still open", () => {
    expect(
      parseStatus(
        {
          postepowanieRestrukturyzacyjneNaprawczePrzymusowaRestrukturyzacjaUporzadkowanaLikwidacja:
            [
              {
                otwarciePostepowaniaRestrukturyzacyjnegoNaprawczegoPrzymusowejRestrukturyzacjiUporzadkowanejLikwidacji:
                  { rodzajPostepowania: "PRZYMUSOWA RESTRUKTURYZACJA" },
                zakonczeniePostepowaniaRestrukturyzacyjnegoNaprawczegoPrzymusowejRestrukturyzacjiUporzadkowanejLikwidacji:
                  {},
              },
            ],
        },
        "ACME SP. Z O.O.",
      ),
    ).toEqual({ type: "restructuring" });
  });

  test("ignores closed bankruptcy proceedings before setting status", () => {
    expect(
      parseStatus(
        {
          postepowanieUpadlosciowe: [
            { opisZakonczeniaProcesuUpadlosci: { data: "01.02.2024" } },
          ],
        },
        "ACME SP. Z O.O.",
      ),
    ).toEqual({ type: "active" });
  });

  test("treats empty bankruptcy close placeholders as still open", () => {
    expect(
      parseStatus(
        {
          postepowanieUpadlosciowe: [{ opisZakonczeniaProcesuUpadlosci: {} }],
        },
        "ACME SP. Z O.O.",
      ),
    ).toEqual({ type: "bankruptcy" });
  });

  test("an unlabelled proceeding defaults to `restructuring`", () => {
    // Safer default than `liquidating` — KRS omits the kind on older
    // records but we should not assert dissolution without evidence.
    expect(
      parseStatus(
        {
          postepowanieRestrukturyzacyjneNaprawczePrzymusowaRestrukturyzacjaUporzadkowanaLikwidacja:
            [{}],
        },
        "ACME SP. Z O.O.",
      ),
    ).toEqual({ type: "restructuring" });
  });

  test("name suffix wins when proceedings are unlabelled", () => {
    expect(
      parseStatus(
        {
          postepowanieRestrukturyzacyjneNaprawczePrzymusowaRestrukturyzacjaUporzadkowanaLikwidacja:
            [{}],
        },
        "ACME SPÓŁKA AKCYJNA W LIKWIDACJI",
      ),
    ).toEqual({ type: "liquidating" });
    expect(
      parseStatus(
        {
          postepowanieRestrukturyzacyjneNaprawczePrzymusowaRestrukturyzacjaUporzadkowanaLikwidacja:
            [{}],
        },
        "ACME SPÓŁKA AKCYJNA W UPADŁOŚCI",
      ),
    ).toEqual({ type: "bankruptcy" });
  });

  test("maps `wykreslenia` to `dissolved` even when other arrays are present", () => {
    expect(
      parseStatus(
        {
          wykreslenia: [{ data: "01.01.2026" }],
          postepowanieUpadlosciowe: [{ data: "01.01.2025" }],
        },
        "ACME",
      ),
    ).toEqual({ type: "dissolved" });
  });

  test("falls back to the name suffix when dzial6 is empty", () => {
    // KRS appends `W UPADŁOŚCI` / `W LIKWIDACJI` to the registered
    // name during proceedings. The suffix is part of the official
    // name, not a derived field, so it remains a valid secondary
    // signal when dzial6 has not caught up.
    expect(
      parseStatus(undefined, "GETIN NOBLE BANK SPÓŁKA AKCYJNA W UPADŁOŚCI"),
    ).toEqual({ type: "bankruptcy" });
    expect(parseStatus(undefined, "ACME SPÓŁKA AKCYJNA W LIKWIDACJI")).toEqual({
      type: "liquidating",
    });
  });

  test("name suffix matches case-insensitively", () => {
    expect(parseStatus(undefined, "Acme Spółka Akcyjna w upadłości")).toEqual({
      type: "bankruptcy",
    });
  });
});

describe("parseEntity (fixture-driven)", () => {
  test("parses the CD Projekt fixture", async () => {
    const body = await Bun.file(
      new URL("__fixtures__/lookup-cd-projekt.json", import.meta.url),
    ).json();
    // SAFETY: fixtures are captured directly from the live KRS API.
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    const entity = parseEntity(body as KrsLookupResponse, "0000006865");

    expect(entity.krsNumber).toBe("0000006865");
    expect(entity.register).toBe("RejP");
    expect(entity.name).toBe("CD PROJEKT SPÓŁKA AKCYJNA");
    expect(entity.legalForm).toBe("SPÓŁKA AKCYJNA");
    expect(entity.identifiers.nip).toBe("7342867148");
    expect(entity.identifiers.regon).toBe("49270733300000");
    // Share capital surfaced verbatim from
    // dzial1.kapital.wysokoscKapitaluZakladowego (Polish comma decimal).
    expect(entity.shareCapital).toEqual({
      amount: "99910510,00",
      currency: "PLN",
    });
    expect(entity.address?.street).toBe("JAGIELLOŃSKA 74");
    expect(entity.address?.postalCode).toBe("03-301");
    expect(entity.address?.city).toBe("WARSZAWA");
    expect(entity.address?.country).toBe("POLSKA");
    expect(entity.registeredSeat?.voivodeship).toBe("MAZOWIECKIE");
    expect(entity.registeredSeat?.locality).toBe("WARSZAWA");
    expect(entity.email).toBe("GIELDA@CDPROJEKT.COM");
    expect(entity.website).toBe("WWW.CDPROJEKT.COM");
    expect(entity.status).toEqual({ type: "active" });
    expect(entity.registeredAt).toBe("06.04.2001");
    expect(entity.registryUrl).toContain("rejestr=P");
    expect(entity.registryUrl).toContain("/OdpisAktualny/0000006865");
  });

  test("parses the Caritas association (RejS) fixture", async () => {
    const body = await Bun.file(
      new URL("__fixtures__/lookup-caritas.json", import.meta.url),
    ).json();
    // SAFETY: fixtures captured live.
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    const entity = parseEntity(body as KrsLookupResponse, "0000198645");

    expect(entity.register).toBe("RejS");
    expect(entity.name).toContain("CARITAS");
    expect(entity.registryUrl).toContain("rejestr=S");
    expect(entity.status).toEqual({ type: "active" });
  });

  test("parses the Getin Noble bankruptcy fixture", async () => {
    const body = await Bun.file(
      new URL("__fixtures__/lookup-getin-noble.json", import.meta.url),
    ).json();
    // SAFETY: fixtures captured live.
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    const entity = parseEntity(body as KrsLookupResponse, "0000304735");
    expect(entity.name).toContain("W UPADŁOŚCI");
    expect(entity.status).toEqual({ type: "bankruptcy" });
  });

  test("tolerates a missing dzial1 entirely", () => {
    // Defensive: every nested field is optional in the typings. A
    // malformed-but-200 response must not produce a 500.
    const minimal: KrsLookupResponse = { odpis: { naglowekA: {} } };
    const entity = parseEntity(minimal, "0000006865");
    expect(entity.krsNumber).toBe("0000006865");
    expect(entity.name).toBe("0000006865");
    expect(entity.legalForm).toBeNull();
    expect(entity.identifiers).toEqual({ nip: null, regon: null });
    expect(entity.shareCapital).toBeNull();
    expect(entity.address).toBeNull();
    expect(entity.registeredSeat).toBeNull();
    // Defaults to RejP because the discriminator is absent.
    expect(entity.register).toBe("RejP");
  });

  test("builds the registry URL with the short rejestr code", () => {
    const minimal: KrsLookupResponse = {
      odpis: { naglowekA: { rejestr: "RejS" } },
    };
    const entity = parseEntity(minimal, "0000198645");
    expect(entity.registryUrl).toBe(
      "https://api-krs.ms.gov.pl/api/krs/OdpisAktualny/0000198645?rejestr=S&format=json",
    );
  });
});
