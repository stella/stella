import { expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  monitoringFingerprint,
  monitoringSubject,
} from "@/api/lib/lists/sanctions/monitoring-input";
import type { SanctionsMonitoringContact } from "@/api/lib/lists/sanctions/monitoring-input";

const person = {
  id: toSafeId<"contact">("00000000-0000-4000-8000-000000000001"),
  organizationId: toSafeId<"organization">("subject-matrix"),
  type: "person",
  displayName: "Čeněk Šťastný",
  organizationName: null,
  registrationNumber: null,
  taxId: null,
  dateOfBirthYear: null,
  dateOfBirthMonth: null,
  dateOfBirthDay: null,
  nationalityCodes: ["SK", "CZ"],
  sanctionsMonitoringMode: "included",
} satisfies SanctionsMonitoringContact;

test("monitoring subjects preserve birth precision diacritics and nationality fixed points", () => {
  const cases = [
    { contact: person, birthDate: null },
    {
      contact: { ...person, dateOfBirthYear: 1980 },
      birthDate: { year: 1980 },
    },
    {
      contact: { ...person, dateOfBirthYear: 1980, dateOfBirthMonth: 4 },
      birthDate: { year: 1980, month: 4 },
    },
    {
      contact: {
        ...person,
        dateOfBirthYear: 1980,
        dateOfBirthMonth: 4,
        dateOfBirthDay: 3,
      },
      birthDate: { year: 1980, month: 4, day: 3 },
    },
  ];
  const fingerprints = new Set<string>();
  for (const { contact, birthDate } of cases) {
    expect(monitoringSubject(contact)).toEqual({
      type: "person",
      name: "Čeněk Šťastný",
      birthDate,
      nationalityCodes: ["CZ", "SK"],
    });
    fingerprints.add(monitoringFingerprint(contact));
    const reordered = { ...contact, nationalityCodes: ["CZ", "SK", "CZ"] };
    expect(monitoringSubject(reordered)).toEqual(monitoringSubject(contact));
    expect(monitoringFingerprint(reordered)).toBe(
      monitoringFingerprint(contact),
    );
  }
  expect(fingerprints.size).toBe(cases.length);
  const full = {
    ...person,
    dateOfBirthYear: 1980,
    dateOfBirthMonth: 4,
    dateOfBirthDay: 3,
  };
  for (const change of [
    { dateOfBirthYear: 1981 },
    { dateOfBirthMonth: 5 },
    { dateOfBirthDay: 4 },
  ]) {
    expect(monitoringFingerprint({ ...full, ...change })).not.toBe(
      monitoringFingerprint(full),
    );
  }
  for (const change of [
    { displayName: "Cenek Stastny" },
    { nationalityCodes: ["CZ"] },
    { sanctionsMonitoringMode: "excluded" as const },
  ]) {
    expect(monitoringFingerprint({ ...person, ...change })).not.toBe(
      monitoringFingerprint(person),
    );
  }
});

test("organization subjects preserve the legal name and each independent identifier", () => {
  const organization = {
    ...person,
    type: "organization",
    organizationName: "Žďár Services",
    displayName: "Different display",
  } as const;
  const cases = [
    { registrationNumber: null, taxId: null, identifiers: [] },
    { registrationNumber: "REG-123", taxId: null, identifiers: ["REG-123"] },
    { registrationNumber: null, taxId: "TAX-456", identifiers: ["TAX-456"] },
    {
      registrationNumber: "REG-123",
      taxId: "TAX-456",
      identifiers: ["REG-123", "TAX-456"],
    },
  ];
  const fingerprints = new Set<string>();
  for (const { registrationNumber, taxId, identifiers } of cases) {
    const contact = { ...organization, registrationNumber, taxId };
    expect(monitoringSubject(contact)).toEqual({
      type: "organization",
      name: "Žďár Services",
      identifiers,
    });
    fingerprints.add(monitoringFingerprint(contact));
    expect(
      monitoringFingerprint({ ...contact, displayName: "Another display" }),
    ).toBe(monitoringFingerprint(contact));
    expect(
      monitoringFingerprint({
        ...contact,
        organizationName: "Other legal name",
      }),
    ).not.toBe(monitoringFingerprint(contact));
  }
  expect(fingerprints.size).toBe(cases.length);
  const identified = {
    ...organization,
    registrationNumber: "REG-123",
    taxId: "TAX-456",
  };
  for (const change of [
    { registrationNumber: "REG-789" },
    { taxId: "TAX-789" },
    { organizationName: "Zdar Services" },
  ]) {
    expect(monitoringFingerprint({ ...identified, ...change })).not.toBe(
      monitoringFingerprint(identified),
    );
  }
  expect(
    monitoringSubject({ ...organization, organizationName: null }),
  ).toEqual({
    type: "organization",
    name: "Different display",
    identifiers: [],
  });
});
