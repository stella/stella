import { describe, expect, test } from "bun:test";

import { parseAddress, parseCompany, parseSearchEntry } from "./parse.js";
import type { PrhRawAddress, PrhRawCompany } from "./types.js";

const baseAddress: PrhRawAddress = {
  type: 1,
  source: "1",
};

describe("parseAddress", () => {
  test("composes a Finnish street address from atoms", () => {
    const address = parseAddress({
      ...baseAddress,
      street: "Mannerheimintie",
      buildingNumber: "1",
      entrance: "A",
      apartmentNumber: "5",
      postCode: "00100",
      postOffices: [
        { city: "HELSINKI", languageCode: "1", municipalityCode: "091" },
        { city: "HELSINGFORS", languageCode: "2", municipalityCode: "091" },
      ],
    });
    expect(address.street).toBe("Mannerheimintie 1 A 5");
    expect(address.postalCode).toBe("00100");
    expect(address.city).toBe("HELSINKI");
    expect(address.textAddress).toContain("Mannerheimintie 1 A 5");
    expect(address.textAddress).toContain("00100 HELSINKI");
  });

  test("preserves apartment suffixes in Finnish street addresses", () => {
    const address = parseAddress({
      ...baseAddress,
      street: "Mannerheimintie",
      buildingNumber: "1",
      entrance: "A",
      apartmentNumber: "5",
      apartmentIdSuffix: "B",
    });
    expect(address.street).toBe("Mannerheimintie 1 A 5B");
  });

  test("uses PO box prefix when postOfficeBox is set", () => {
    const address = parseAddress({
      ...baseAddress,
      type: 2,
      postOfficeBox: "1000",
      postCode: "00101",
      postOffices: [
        { city: "HELSINKI", languageCode: "1", municipalityCode: "091" },
      ],
    });
    expect(address.street).toBe("PL 1000");
  });

  test("falls back to freeAddressLine for foreign addresses", () => {
    // PRH supplies foreign / opaque addresses via freeAddressLine
    // rather than structured atoms; the parser must surface it so
    // overseas entities are not rendered with a null street.
    const address = parseAddress({
      ...baseAddress,
      freeAddressLine: "Box 5066, Tortola, British Virgin Islands",
      country: "GB",
    });
    expect(address.street).toBe("Box 5066, Tortola, British Virgin Islands");
    expect(address.country).toBe("GB");
    expect(address.textAddress).toContain(
      "Box 5066, Tortola, British Virgin Islands",
    );
  });

  test("decodes PRH's underscore-encoded spaces in freeAddressLine", () => {
    // PRH v3 encodes the spaces inside freeAddressLine as underscores;
    // returning the value verbatim would surface "Norgårdsvägen_3" in
    // the UI. The parser must decode the encoding and collapse runs
    // of whitespace introduced by mixed underscore + space input.
    const address = parseAddress({
      ...baseAddress,
      freeAddressLine: "Norgårdsvägen_3 _ SE-451_75 Uddevalla",
      country: "SE",
    });
    expect(address.street).toBe("Norgårdsvägen 3 SE-451 75 Uddevalla");
  });

  test("returns nulls when no address fields are populated", () => {
    expect(parseAddress(baseAddress)).toEqual({
      street: null,
      postalCode: null,
      city: null,
      country: null,
      textAddress: null,
    });
  });

  test("preserves the c/o recipient on structured street addresses", () => {
    // PRH attaches the care-of recipient via `co`; dropping it loses
    // the only way to address registered mail for entities held under
    // an agent (common for foreign-owned Finnish branches).
    const address = parseAddress({
      ...baseAddress,
      co: "Asianajotoimisto Acme Oy",
      street: "Mannerheimintie",
      buildingNumber: "1",
    });
    expect(address.street).toBe(
      "c/o Asianajotoimisto Acme Oy, Mannerheimintie 1",
    );
  });

  test("preserves the c/o recipient with PO box addresses", () => {
    const address = parseAddress({
      ...baseAddress,
      type: 2,
      co: "Tilitoimisto Beta",
      postOfficeBox: "1000",
    });
    expect(address.street).toBe("c/o Tilitoimisto Beta, PL 1000");
  });

  test("does not double-prefix when PRH already includes c/o", () => {
    // PRH inconsistently ships `co` — the captured Supercell fixture
    // arrives with `"co": "c/o Supercell Oy"`. Re-prefixing would
    // render `c/o c/o Supercell Oy, …`; the parser must detect the
    // existing prefix in any case.
    expect(
      parseAddress({
        ...baseAddress,
        co: "c/o Supercell Oy",
        street: "Jätkäsaarenlaituri",
        buildingNumber: "1",
      }).street,
    ).toBe("c/o Supercell Oy, Jätkäsaarenlaituri 1");
    expect(
      parseAddress({
        ...baseAddress,
        co: "C/O Acme Oy",
        street: "Mannerheimintie",
        buildingNumber: "1",
      }).street,
    ).toBe("C/O Acme Oy, Mannerheimintie 1");
  });
});

describe("parseCompany / parseSearchEntry — defensive shape handling", () => {
  // PRH's v3 schema declares `names` as optional; minimal / foreign
  // records can omit it entirely. Both code paths must fall back to
  // the business ID rather than throw, so the dispatch layer cannot
  // surface a 500 for a valid upstream response.
  const minimal: PrhRawCompany = {
    businessId: { value: "0112038-9", source: "3" },
    status: "2",
  };

  test("parseCompany returns status `unknown` when PRH omits the field", () => {
    const { status, ...rest } = minimal;
    void status;
    expect(parseCompany(rest).status).toEqual({ type: "unknown" });
  });

  test("parseCompany returns status `unknown` for undocumented values", () => {
    expect(parseCompany({ ...minimal, status: "9" }).status).toEqual({
      type: "unknown",
    });
  });

  test("parseCompany still maps documented status codes", () => {
    expect(parseCompany({ ...minimal, status: "1" }).status).toEqual({
      type: "unregistered",
    });
    expect(parseCompany({ ...minimal, status: "2" }).status).toEqual({
      type: "registered",
    });
    expect(
      parseCompany({ ...minimal, status: "3", endDate: "2020-01-01" }).status,
    ).toEqual({ type: "ended", endedAt: "2020-01-01" });
  });

  test("parseCompany tolerates a missing names array", () => {
    const company = parseCompany(minimal);
    expect(company.name).toBe("0112038-9");
    expect(company.alternateNames).toEqual([]);
  });

  test("parseSearchEntry tolerates a missing names array", () => {
    const result = parseSearchEntry(minimal);
    expect(result.name).toBe("0112038-9");
    expect(result.businessId).toBe("0112038-9");
  });

  test("parseSearchEntry falls back to the postal address when type-1 is absent", () => {
    // PO-box-only / agent-mailing Finnish entities only file a type-2
    // address. The search path must mirror the lookup-side fallback or
    // their hits surface as `address: null` in chat / contact-form
    // results despite the payload carrying enough to render one.
    const result = parseSearchEntry({
      ...minimal,
      addresses: [
        {
          type: 2,
          postOfficeBox: "1000",
          postCode: "00101",
          postOffices: [
            { city: "HELSINKI", languageCode: "1", municipalityCode: "091" },
          ],
          source: "0",
        },
      ],
    });
    expect(result.address).toBe("PL 1000, 00101 HELSINKI");
  });

  test("parseCompany emits an AvoinData JSON URL as registryUrl", () => {
    // The YTJ web portal cannot be deep-linked by business ID, so the
    // registry URL points at the AvoinData REST endpoint for the same
    // record. Lock this in so a future refactor does not silently
    // regress the link to a non-resolving yavain URL.
    expect(parseCompany(minimal).registryUrl).toBe(
      "https://avoindata.prh.fi/opendata-ytj-api/v3/companies?businessId=0112038-9",
    );
  });
});
