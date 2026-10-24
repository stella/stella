import {
  VAT_RATE_PRESET_COUNTRIES,
  type VatRatePresetCountry,
} from "@stll/api-contract";

export { VAT_RATE_PRESET_COUNTRIES, type VatRatePresetCountry };

export type VatRatePreset = {
  code: string;
  name: string;
  rateBps: number;
  validFrom: string;
  validTo: string | null;
};

/**
 * Statutory VAT periods. End dates are exclusive.
 *
 * SK: zákon č. 222/2004 Z. z. o dani z pridanej hodnoty, § 27 (slov-lex.sk);
 * standard 19 % until 2010, 20 % from 2011, and 23 % with reduced 19 % and
 * 5 % from 2025-01-01.
 * CZ: zákon č. 235/2004 Sb. o dani z přidané hodnoty, § 47 odst. 1
 * (e-Sbírka); 21 % / 15 % from 2013, a second reduced 10 % from 2015-01-01,
 * and 21 % / 12 % from 2024-01-01.
 */
export const VAT_RATE_PRESETS = {
  SK: [
    {
      code: "sk-standard",
      name: "Standard 19 %",
      rateBps: 1900,
      validFrom: "2004-05-01",
      validTo: "2011-01-01",
    },
    {
      code: "sk-standard",
      name: "Standard 20 %",
      rateBps: 2000,
      validFrom: "2011-01-01",
      validTo: "2025-01-01",
    },
    {
      code: "sk-reduced-10",
      name: "Reduced 10 %",
      rateBps: 1000,
      validFrom: "2007-01-01",
      validTo: "2025-01-01",
    },
    {
      code: "sk-reduced-5",
      name: "Reduced 5 %",
      rateBps: 500,
      validFrom: "2023-01-01",
      validTo: "2025-01-01",
    },
    {
      code: "sk-standard",
      name: "Standard 23 %",
      rateBps: 2300,
      validFrom: "2025-01-01",
      validTo: null,
    },
    {
      code: "sk-reduced-19",
      name: "Reduced 19 %",
      rateBps: 1900,
      validFrom: "2025-01-01",
      validTo: null,
    },
    {
      code: "sk-reduced-5",
      name: "Reduced 5 %",
      rateBps: 500,
      validFrom: "2025-01-01",
      validTo: null,
    },
  ],
  CZ: [
    {
      code: "cz-standard",
      name: "Standard 21 %",
      rateBps: 2100,
      validFrom: "2013-01-01",
      validTo: "2024-01-01",
    },
    {
      code: "cz-reduced-15",
      name: "Reduced 15 %",
      rateBps: 1500,
      validFrom: "2013-01-01",
      validTo: "2024-01-01",
    },
    {
      code: "cz-reduced-10",
      name: "Reduced 10 %",
      rateBps: 1000,
      validFrom: "2015-01-01",
      validTo: "2024-01-01",
    },
    {
      code: "cz-standard",
      name: "Standard 21 %",
      rateBps: 2100,
      validFrom: "2024-01-01",
      validTo: null,
    },
    {
      code: "cz-reduced-12",
      name: "Reduced 12 %",
      rateBps: 1200,
      validFrom: "2024-01-01",
      validTo: null,
    },
  ],
} as const satisfies Record<VatRatePresetCountry, readonly VatRatePreset[]>;

// Derived from the presets themselves, so a hand-entered code that merely
// shares a country prefix (`sk-office`) is never mistaken for a preset.
const PRESET_COUNTRY_BY_CODE: ReadonlyMap<string, VatRatePresetCountry> =
  new Map(
    VAT_RATE_PRESET_COUNTRIES.flatMap((country) =>
      VAT_RATE_PRESETS[country].map(({ code }) => [code, country] as const),
    ),
  );

/**
 * The rates that apply to a seller in `country`: rates entered by hand, plus
 * the presets of that country only. Another country's preset rates never
 * become a seller's standard rate.
 */
export const vatRatePeriodsForCountry = <Period extends { code: string }>(
  periods: readonly Period[],
  country: string,
): Period[] =>
  periods.filter(({ code }) => {
    const presetCountry = PRESET_COUNTRY_BY_CODE.get(code);
    return presetCountry === undefined || presetCountry === country;
  });
