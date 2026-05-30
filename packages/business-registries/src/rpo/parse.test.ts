import { describe, expect, test } from "bun:test";

import { parseAddress, parseCompany, parseSearchEntry } from "./parse.js";
import type { RpoAddress, RpoRawEntity } from "./types.js";

const baseAddress: RpoAddress = {};

describe("parseAddress", () => {
  test("composes a Slovak street address from atoms", () => {
    const address = parseAddress({
      street: "Einsteinova",
      regNumber: 0,
      buildingNumber: "24",
      postalCodes: ["85101"],
      municipality: { value: "Bratislava" },
      country: { value: "Slovenská republika", code: "703" },
    });
    expect(address.street).toBe("Einsteinova 24");
    expect(address.postalCode).toBe("85101");
    expect(address.city).toBe("Bratislava");
    expect(address.country).toBe("Slovenská republika");
    expect(address.textAddress).toBe(
      "Einsteinova 24, 85101 Bratislava, Slovenská republika",
    );
  });

  test("renders the orientational number with regNumber/buildingNumber", () => {
    // RPO encodes the Czechoslovak-style descriptive/orientational
    // house number pair as `regNumber` (descriptive) and
    // `buildingNumber` (orientational, often suffixed with a letter).
    // When `regNumber` is non-zero, the canonical render is
    // `<reg>/<building>` (e.g. "1234/56A").
    const address = parseAddress({
      street: "Hlavná",
      regNumber: 1234,
      buildingNumber: "56A",
      postalCodes: ["91101"],
      municipality: { value: "Trenčín" },
    });
    expect(address.street).toBe("Hlavná 1234/56A");
  });

  test("returns nulls when no fields are populated", () => {
    expect(parseAddress(baseAddress)).toEqual({
      street: null,
      postalCode: null,
      city: null,
      country: null,
      textAddress: null,
    });
  });

  test("preserves a street with no building number", () => {
    expect(parseAddress({ street: "Karpatská" }).street).toBe("Karpatská");
  });
});

describe("parseCompany / parseSearchEntry — defensive shape handling", () => {
  const minimal: RpoRawEntity = {
    id: 1,
    identifiers: [{ value: "31333532", validFrom: "1992-09-17" }],
  };

  test("parseCompany defaults the name to the IČO when fullNames is missing", () => {
    const company = parseCompany(minimal);
    expect(company.name).toBe("31333532");
    expect(company.alternateNames).toEqual([]);
  });

  test("parseSearchEntry tolerates a missing fullNames array", () => {
    const result = parseSearchEntry(minimal);
    expect(result.name).toBe("31333532");
    expect(result.ico).toBe("31333532");
  });

  test("parseCompany returns status `registered` when termination is absent", () => {
    expect(parseCompany(minimal).status).toEqual({ type: "registered" });
  });

  test("parseCompany returns status `dissolved` when termination is set", () => {
    expect(
      parseCompany({ ...minimal, termination: "2024-08-23" }).status,
    ).toEqual({ type: "dissolved", dissolvedAt: "2024-08-23" });
  });

  test("parseCompany emits a deep-link to the RPO portal as registryUrl", () => {
    expect(parseCompany({ ...minimal, id: 937_053 }).registryUrl).toBe(
      "https://rpo.statistics.sk/rpo/v1/entity/937053",
    );
  });

  test("parseCompany drops the current primary name from alternateNames", () => {
    // RPO returns historical and current names in a single array;
    // surfacing the current name in both `name` and `alternateNames`
    // would duplicate the data on every consumer.
    const company = parseCompany({
      ...minimal,
      fullNames: [
        {
          value: "BTK unit s.r.o.",
          validFrom: "2004-08-04",
          validTo: "2005-10-31",
        },
        { value: "DOTYKY PRÍRODY s.r.o.", validFrom: "2021-07-15" },
      ],
    });
    expect(company.name).toBe("DOTYKY PRÍRODY s.r.o.");
    expect(company.alternateNames).toEqual([
      { name: "BTK unit s.r.o.", isCurrent: false },
    ]);
  });

  test("parseCompany surfaces statisticalCodes.mainActivity as the main activity", () => {
    const company = parseCompany({
      ...minimal,
      statisticalCodes: {
        mainActivity: { value: "Test activity", code: "1234" },
      },
    });
    expect(company.mainActivity).toEqual({
      code: "1234",
      description: "Test activity",
    });
  });

  test("parseCompany returns null mainActivity when the code is missing", () => {
    expect(parseCompany(minimal).mainActivity).toBeNull();
  });

  test("parseCompany surfaces court file from sourceRegister", () => {
    const company = parseCompany({
      ...minimal,
      sourceRegister: {
        registrationOffices: [
          { value: "Mestský súd Bratislava III", validFrom: "1992-09-17" },
        ],
        registrationNumbers: [{ value: "Sro/3586/B", validFrom: "1992-09-17" }],
      },
    });
    expect(company.courtFile).toEqual({
      court: "Mestský súd Bratislava III",
      fileNumber: "Sro/3586/B",
    });
  });

  test("parseCompany surfaces only currently-valid activities", () => {
    const company = parseCompany({
      ...minimal,
      activities: [
        {
          economicActivityDescription: "current",
          validFrom: "2020-01-01",
        },
        {
          economicActivityDescription: "superseded",
          validFrom: "2010-01-01",
          validTo: "2019-12-31",
        },
      ],
    });
    expect(company.activities).toEqual([
      { description: "current", registeredAt: "2020-01-01" },
    ]);
  });
});
