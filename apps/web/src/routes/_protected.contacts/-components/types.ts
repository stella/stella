import type { ContactUpdateFields } from "@/lib/contacts/mutations";
import type { contactOptions } from "@/lib/contacts/queries";
import type { NonEmptyPatch } from "@/lib/mutation-command";

export type ContactData = NonNullable<
  Awaited<ReturnType<NonNullable<ReturnType<typeof contactOptions>["queryFn"]>>>
>;

export type ContactDataBox = {
  id: string;
  isPrimary: boolean;
  label?: string;
};

export type ContactCustomField = {
  id: string;
  label: string;
  value: string;
};

export type ContactMetadata = {
  dataBoxes?: ContactDataBox[];
  customFields?: ContactCustomField[];
};

export type ContactPatch = NonEmptyPatch<
  Pick<ContactUpdateFields, "emails" | "metadata" | "phones">
>;

export type PartyMatter = ContactData["partyMatters"][number];

// Fields that can be sent to the update endpoint
export type EditableField =
  | "prefix"
  | "firstName"
  | "middleName"
  | "lastName"
  | "suffix"
  | "organizationName"
  | "displayName"
  | "notes"
  | "registrationNumber"
  | "taxId"
  | "defaultHourlyRate"
  | "currency"
  | "paymentTermDays";
