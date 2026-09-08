import { expect, test } from "bun:test";

import { getDefaultDesktopRegistry } from "./default-registry";

test("saved practice jurisdiction selects its enabled domestic registry, not the EU registry", () => {
  expect(
    getDefaultDesktopRegistry({
      registries: [
        { id: "vies", name: "VIES" },
        { id: "ares", name: "ARES" },
      ],
      practiceJurisdictions: [{ countryCode: "CZ", isPrimary: true }],
    }),
  ).toBe("ares");
});

test("multiple domestic registries require an explicit choice irrespective of order", () => {
  for (const registries of [
    [
      { id: "ares", name: "ARES" },
      { id: "orsr", name: "ORSR" },
    ],
    [
      { id: "orsr", name: "ORSR" },
      { id: "ares", name: "ARES" },
    ],
  ] as const) {
    expect(
      getDefaultDesktopRegistry({
        registries: [...registries],
        practiceJurisdictions: [
          { countryCode: "CZ", isPrimary: false },
          { countryCode: "SK", isPrimary: false },
        ],
      }),
    ).toBeNull();
  }
});

test("the saved primary practice jurisdiction takes precedence among domestic registries", () => {
  expect(
    getDefaultDesktopRegistry({
      registries: [
        { id: "ares", name: "ARES" },
        { id: "orsr", name: "ORSR" },
        { id: "vies", name: "VIES" },
      ],
      practiceJurisdictions: [
        { countryCode: "CZ", isPrimary: false },
        { countryCode: "SK", isPrimary: true },
      ],
    }),
  ).toBe("orsr");
});

test("conflicting primary jurisdictions still require an explicit choice", () => {
  expect(
    getDefaultDesktopRegistry({
      registries: [
        { id: "ares", name: "ARES" },
        { id: "orsr", name: "ORSR" },
      ],
      practiceJurisdictions: [
        { countryCode: "CZ", isPrimary: true },
        { countryCode: "SK", isPrimary: true },
      ],
    }),
  ).toBeNull();
});

test("absent or disabled domestic registry does not acquire a default", () => {
  expect(
    getDefaultDesktopRegistry({
      registries: [{ id: "vies", name: "VIES" }],
      practiceJurisdictions: [{ countryCode: "CZ", isPrimary: true }],
    }),
  ).toBeNull();
  expect(
    getDefaultDesktopRegistry({
      registries: [{ id: "ares", name: "ARES" }],
      practiceJurisdictions: [],
    }),
  ).toBeNull();
});

