import * as v from "valibot";

import type {
  ContactCustomField,
  ContactData,
  ContactDataBox,
  ContactMetadata,
} from "@/routes/_protected.contacts/-components/types";

export const DATA_BOX_ID_PATTERN = /^[a-z0-9]{7}$/u;
export const EMAIL_SCHEMA = v.pipe(v.string(), v.trim(), v.email());

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isContactDataBox = (value: unknown): value is ContactDataBox =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  typeof value["isPrimary"] === "boolean" &&
  (value["label"] === undefined || typeof value["label"] === "string");

const isContactCustomField = (value: unknown): value is ContactCustomField =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  typeof value["label"] === "string" &&
  typeof value["value"] === "string";

export const getContactMetadata = (contact: ContactData): ContactMetadata => {
  const metadata = contact.metadata;

  if (!isRecord(metadata)) {
    return {};
  }

  const { customFields, dataBoxes } = metadata;

  return {
    dataBoxes: Array.isArray(dataBoxes)
      ? dataBoxes.filter(isContactDataBox)
      : [],
    customFields: Array.isArray(customFields)
      ? customFields.filter(isContactCustomField)
      : [],
  };
};
