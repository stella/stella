import { panic } from "better-result";

import { isCountryCode } from "@stll/country-codes";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";
import { stableStringify } from "@stll/stable-stringify";

import type { contacts } from "@/api/db/schema";
import type { SanctionsScreeningSubject } from "@/api/lib/lists/sanctions/screening-service";

export type SanctionsMonitoringContact = Pick<
  typeof contacts.$inferSelect,
  | "id"
  | "organizationId"
  | "type"
  | "displayName"
  | "organizationName"
  | "registrationNumber"
  | "taxId"
  | "dateOfBirthYear"
  | "dateOfBirthMonth"
  | "dateOfBirthDay"
  | "nationalityCodes"
  | "sanctionsMonitoringMode"
>;

export const monitoringSubject = (
  contact: SanctionsMonitoringContact,
): SanctionsScreeningSubject => {
  switch (contact.type) {
    case "organization":
      return {
        type: "organization",
        name: contact.organizationName ?? contact.displayName,
        identifiers: [contact.registrationNumber, contact.taxId].filter(
          (value) => value !== null,
        ),
      };
    case "person": {
      const nationalityCodes = contact.nationalityCodes.filter(isCountryCode);
      const {
        dateOfBirthYear: year,
        dateOfBirthMonth: month,
        dateOfBirthDay: day,
      } = contact;
      const birthDate = (() => {
        if (year === null) {
          return null;
        }
        if (month === null) {
          return { year };
        }
        if (day === null) {
          return { year, month };
        }
        return { year, month, day };
      })();
      return {
        type: "person",
        name: contact.displayName,
        birthDate,
        nationalityCodes: [...new Set(nationalityCodes)].toSorted(),
      };
    }
    default:
      contact.type satisfies never;
      return panic("Unhandled monitored contact type");
  }
};

export const monitoringFingerprint = (contact: SanctionsMonitoringContact) =>
  hashSha256Hex(
    stableStringify({
      subject: monitoringSubject(contact),
      mode: contact.sanctionsMonitoringMode,
    }),
  );
