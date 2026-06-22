import { describe, expect, test } from "bun:test";

import {
  buildAutofillUpdates,
  extractRegistryFields,
  groupSupportsRegistryAutofill,
  type RegistryHit,
} from "./registry-autofill";

// Shaped after a real KRS OdpisAktualny lookup (CD Projekt S.A.).
const krsHit = {
  registry: "krs",
  id: "0000006865",
  name: "CD PROJEKT SPÓŁKA AKCYJNA",
  legalForm: "SPÓŁKA AKCYJNA",
  address: {
    line1: "JAGIELLOŃSKA 74",
    line2: null,
    postalCode: "03-301",
    city: "WARSZAWA",
    region: null,
    country: "POLSKA",
    textAddress: "JAGIELLOŃSKA 74, 03-301 WARSZAWA, POLSKA",
  },
  registryUrl:
    "https://api-krs.ms.gov.pl/api/krs/OdpisAktualny/0000006865?rejestr=P&format=json",
  details: {
    registry: "krs",
    entity: {
      krsNumber: "0000006865",
      register: "RejP",
      name: "CD PROJEKT SPÓŁKA AKCYJNA",
      legalForm: "SPÓŁKA AKCYJNA",
      identifiers: { nip: "7342867148", regon: "49270733300000" },
      shareCapital: { amount: "99910510,00", currency: "PLN" },
      address: {
        street: "JAGIELLOŃSKA 74",
        postalCode: "03-301",
        city: "WARSZAWA",
        country: "POLSKA",
        textAddress: "JAGIELLOŃSKA 74, 03-301 WARSZAWA, POLSKA",
      },
      registeredSeat: {
        country: "POLSKA",
        voivodeship: "MAZOWIECKIE",
        county: null,
        commune: null,
        locality: "WARSZAWA",
      },
      email: null,
      website: null,
      status: { type: "active" },
      registeredAt: "06.04.2001",
      lastEntryAt: null,
      registryUrl:
        "https://api-krs.ms.gov.pl/api/krs/OdpisAktualny/0000006865?rejestr=P&format=json",
    },
  },
} satisfies RegistryHit;

describe("extractRegistryFields", () => {
  test("maps a KRS hit onto canonical attributes incl. share capital", () => {
    expect(extractRegistryFields(krsHit)).toEqual({
      name: "CD PROJEKT SPÓŁKA AKCYJNA",
      legalForm: "SPÓŁKA AKCYJNA",
      registrationId: "0000006865",
      address: "JAGIELLOŃSKA 74, 03-301 WARSZAWA, POLSKA",
      taxId: "7342867148",
      statId: "49270733300000",
      shareCapital: "99910510,00 PLN",
    });
  });

  test("omits share capital when the register filed none", () => {
    const noCapital = {
      ...krsHit,
      details: {
        registry: "krs",
        entity: { ...krsHit.details.entity, shareCapital: null },
      },
    } satisfies RegistryHit;
    expect(extractRegistryFields(noCapital).shareCapital).toBeUndefined();
  });
});

describe("buildAutofillUpdates", () => {
  test("fills only the fields whose path suffix maps to a known attribute", () => {
    const groupFields = [
      { path: "tenant.name" },
      { path: "tenant.legal_form" },
      { path: "tenant.krs" },
      { path: "tenant.nip" },
      { path: "tenant.regon" },
      { path: "tenant.address" },
      { path: "tenant.share_capital" },
      { path: "tenant.signing_date" }, // unmapped — left untouched
    ];

    expect(buildAutofillUpdates(groupFields, krsHit)).toEqual([
      { path: "tenant.name", value: "CD PROJEKT SPÓŁKA AKCYJNA" },
      { path: "tenant.legal_form", value: "SPÓŁKA AKCYJNA" },
      { path: "tenant.krs", value: "0000006865" },
      { path: "tenant.nip", value: "7342867148" },
      { path: "tenant.regon", value: "49270733300000" },
      {
        path: "tenant.address",
        value: "JAGIELLOŃSKA 74, 03-301 WARSZAWA, POLSKA",
      },
      { path: "tenant.share_capital", value: "99910510,00 PLN" },
    ]);
  });
});

describe("groupSupportsRegistryAutofill", () => {
  test("true when any field is registry-mappable", () => {
    expect(
      groupSupportsRegistryAutofill([
        { path: "tenant.nip" },
        { path: "tenant.signing_date" },
      ]),
    ).toBe(true);
  });

  test("false when no field maps", () => {
    expect(
      groupSupportsRegistryAutofill([
        { path: "lease.start_date" },
        { path: "lease.rent_amount" },
      ]),
    ).toBe(false);
  });
});
