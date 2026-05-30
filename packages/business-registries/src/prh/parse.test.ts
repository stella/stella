import { describe, expect, test } from "bun:test";

import { parseAddress } from "./parse.js";
import type { PrhRawAddress } from "./types.js";

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

  test("returns nulls when no address fields are populated", () => {
    expect(parseAddress(baseAddress)).toEqual({
      street: null,
      postalCode: null,
      city: null,
      country: null,
      textAddress: null,
    });
  });
});
