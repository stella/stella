import type { ContactImportField, ContactType } from "@stll/api-contract";

import type {
  ContactAddress,
  ContactEmail,
  ContactPhone,
} from "@/api/db/schema-validators";
import { dateOfBirthFromColumns } from "@/api/handlers/contacts/person-details";

type PortableContactSource = {
  type: ContactType;
  displayName: string;
  prefix: string | null;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  suffix: string | null;
  organizationName: string | null;
  emails: ContactEmail[] | null;
  phones: ContactPhone[] | null;
  addresses: ContactAddress[] | null;
  notes: string | null;
  tags: string[] | null;
  registrationNumber: string | null;
  taxId: string | null;
  dateOfBirthYear?: number | null;
  dateOfBirthMonth?: number | null;
  dateOfBirthDay?: number | null;
  nationalityCodes?: string[];
};

const primary = <T extends { isPrimary?: boolean }>(
  items: T[] | null,
): T | undefined => items?.find(({ isPrimary }) => isPrimary) ?? items?.at(0);

/**
 * One contact as the import field set, so an export re-imports without a
 * mapping step: the header row is `CONTACT_IMPORT_FIELDS` in order.
 */
export const contactToPortableImport = (
  contact: PortableContactSource,
): Record<ContactImportField, string> => {
  const email = primary(contact.emails);
  const phone = primary(contact.phones);
  const address = primary(contact.addresses);

  return {
    type: contact.type,
    display_name: contact.displayName,
    prefix: contact.prefix ?? "",
    first_name: contact.firstName ?? "",
    middle_name: contact.middleName ?? "",
    last_name: contact.lastName ?? "",
    suffix: contact.suffix ?? "",
    organization_name: contact.organizationName ?? "",
    primary_email: email?.address ?? "",
    primary_phone: phone?.number ?? "",
    address_line_1: address?.line1 ?? "",
    address_line_2: address?.line2 ?? "",
    city: address?.city ?? "",
    state: address?.state ?? "",
    postal_code: address?.postalCode ?? "",
    country: address?.country ?? "",
    notes: contact.notes ?? "",
    tags: contact.tags ? JSON.stringify(contact.tags) : "",
    registration_number: contact.registrationNumber ?? "",
    tax_id: contact.taxId ?? "",
    date_of_birth: (() => {
      const date = dateOfBirthFromColumns({
        dateOfBirthYear: contact.dateOfBirthYear ?? null,
        dateOfBirthMonth: contact.dateOfBirthMonth ?? null,
        dateOfBirthDay: contact.dateOfBirthDay ?? null,
      });
      if (date === null) {
        return "";
      }
      const year = String(date.year).padStart(4, "0");
      if (date.precision === "year") {
        return year;
      }
      const month = String(date.month).padStart(2, "0");
      if (date.precision === "month") {
        return `${year}-${month}`;
      }
      return `${year}-${month}-${String(date.day).padStart(2, "0")}`;
    })(),
    nationality_codes:
      (contact.nationalityCodes?.length ?? 0) > 0
        ? JSON.stringify(contact.nationalityCodes)
        : "",
  };
};
