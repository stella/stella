import type {
  ContactAddress,
  ContactEmail,
  ContactPhone,
} from "@/api/db/schema-validators";

type ContactSearchableTextSource = {
  prefix: string | null | undefined;
  firstName: string | null | undefined;
  middleName: string | null | undefined;
  lastName: string | null | undefined;
  suffix: string | null | undefined;
  organizationName: string | null | undefined;
  notes: string | null | undefined;
  emails: readonly ContactEmail[] | null | undefined;
  phones: readonly ContactPhone[] | null | undefined;
  addresses: readonly ContactAddress[] | null | undefined;
  tags: readonly string[] | null | undefined;
  registrationNumber: string | null | undefined;
  taxId: string | null | undefined;
  currency: string | null | undefined;
};

const compact = (parts: readonly (string | null | undefined)[]): string =>
  parts
    .flatMap((part) => {
      const trimmed = part?.trim();
      return trimmed ? [trimmed] : [];
    })
    .join(" ");

/** Canonical text projection shared by synchronous and repair indexing. */
export const contactSearchableText = (
  contact: ContactSearchableTextSource,
): string =>
  compact([
    contact.prefix,
    contact.firstName,
    contact.middleName,
    contact.lastName,
    contact.suffix,
    contact.organizationName,
    contact.notes,
    contact.emails
      ? compact(
          contact.emails.flatMap(({ address, label }) => [address, label]),
        )
      : "",
    contact.phones
      ? compact(contact.phones.flatMap(({ number, label }) => [number, label]))
      : "",
    contact.addresses
      ? compact(
          contact.addresses.flatMap(
            ({ line1, line2, city, state, postalCode, country, label }) => [
              line1,
              line2,
              city,
              state,
              postalCode,
              country,
              label,
            ],
          ),
        )
      : "",
    contact.tags ? compact(contact.tags) : "",
    contact.registrationNumber,
    contact.taxId,
    contact.currency,
  ]);
