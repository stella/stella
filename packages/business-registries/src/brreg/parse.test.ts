import { describe, expect, test } from "bun:test";

import { parseAddress, parseEnhet, parseSearchEntry } from "./parse.js";
import type { BrregRawAddress, BrregRawEnhet } from "./types.js";

const baseRaw: BrregRawEnhet = {
  organisasjonsnummer: "974760673",
  navn: "BRØNNØYSUNDREGISTRENE",
};

describe("parseAddress", () => {
  test("composes textAddress from lines, postal code, city and country", () => {
    const raw: BrregRawAddress = {
      adresse: ["Havnegata 48"],
      postnummer: "8910",
      poststed: "BRØNNØYSUND",
      land: "Norge",
      kommune: "BRØNNØY",
    };
    const out = parseAddress(raw);
    expect(out.street).toBe("Havnegata 48");
    expect(out.postalCode).toBe("8910");
    expect(out.city).toBe("BRØNNØYSUND");
    expect(out.country).toBe("Norge");
    expect(out.municipality).toBe("BRØNNØY");
    expect(out.textAddress).toBe("Havnegata 48, 8910 BRØNNØYSUND, Norge");
  });

  test("falls back to nulls on a sparse address", () => {
    const out = parseAddress({});
    expect(out.street).toBeNull();
    expect(out.postalCode).toBeNull();
    expect(out.city).toBeNull();
    expect(out.country).toBeNull();
    expect(out.textAddress).toBeNull();
  });

  test("composes textAddress from postal+city+country when no street lines are present", () => {
    const out = parseAddress({
      postnummer: "8910",
      poststed: "BRØNNØYSUND",
      land: "Norge",
    });
    expect(out.street).toBeNull();
    expect(out.textAddress).toBe("8910 BRØNNØYSUND, Norge");
  });
});

describe("parseEnhet", () => {
  test("maps minimal raw entity to domain", () => {
    const out = parseEnhet(baseRaw);
    expect(out.orgnr).toBe("974760673");
    expect(out.name).toBe("BRØNNØYSUNDREGISTRENE");
    expect(out.legalForm).toBeNull();
    expect(out.businessAddress).toBeNull();
    expect(out.industryCodes).toEqual([]);
    expect(out.status).toEqual({ type: "active" });
    expect(out.registryUrl).toBe(
      "https://virksomhet.brreg.no/nb/oppslag/enheter/974760673",
    );
  });

  test("flags bankruptcy", () => {
    const out = parseEnhet({ ...baseRaw, konkurs: true });
    expect(out.status).toEqual({ type: "bankruptcy" });
  });

  test("flags winding-up", () => {
    expect(parseEnhet({ ...baseRaw, underAvvikling: true }).status).toEqual({
      type: "winding_up",
    });
    expect(
      parseEnhet({
        ...baseRaw,
        underTvangsavviklingEllerTvangsopplosning: true,
      }).status,
    ).toEqual({ type: "winding_up" });
  });

  test("prefers deleted status over other flags", () => {
    const out = parseEnhet({
      ...baseRaw,
      konkurs: true,
      slettedato: "2024-01-15",
    });
    expect(out.status).toEqual({ type: "deleted", deletedAt: "2024-01-15" });
  });

  test("collects up to three industry codes in order", () => {
    const out = parseEnhet({
      ...baseRaw,
      naeringskode1: {
        kode: "84.110",
        beskrivelse: "Generell offentlig administrasjon",
      },
      naeringskode2: { kode: "84.130" },
      naeringskode3: { kode: "" },
    });
    expect(out.industryCodes).toEqual([
      { code: "84.110", description: "Generell offentlig administrasjon" },
      { code: "84.130", description: null },
    ]);
  });

  test("uses beliggenhetsadresse for sub-entities that lack forretningsadresse", () => {
    const out = parseEnhet({
      ...baseRaw,
      beliggenhetsadresse: {
        adresse: ["Storgata 1"],
        postnummer: "0155",
        poststed: "OSLO",
        land: "Norge",
      },
    });
    expect(out.businessAddress?.street).toBe("Storgata 1");
    expect(out.businessAddress?.city).toBe("OSLO");
  });

  test("prefers forretningsadresse when both physical-address fields are present", () => {
    const out = parseEnhet({
      ...baseRaw,
      forretningsadresse: { adresse: ["Havnegata 48"] },
      beliggenhetsadresse: { adresse: ["Storgata 1"] },
    });
    expect(out.businessAddress?.street).toBe("Havnegata 48");
  });
});

describe("parseSearchEntry", () => {
  test("produces a flat result with composite address", () => {
    const out = parseSearchEntry({
      ...baseRaw,
      forretningsadresse: {
        adresse: ["Havnegata 48"],
        postnummer: "8910",
        poststed: "BRØNNØYSUND",
        land: "Norge",
      },
    });
    expect(out).toEqual({
      orgnr: "974760673",
      name: "BRØNNØYSUNDREGISTRENE",
      address: "Havnegata 48, 8910 BRØNNØYSUND, Norge",
    });
  });

  test("nulls address when missing", () => {
    expect(parseSearchEntry(baseRaw).address).toBeNull();
  });
});
