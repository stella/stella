import { panic } from "better-result";

import type { ContactUpdate } from "@/lib/contacts/mutations";
import type { EditableField } from "@/routes/_protected.contacts/-components/types";

type EditableFieldPolicy =
  | { valueKind: "text"; maxLength: number | null }
  | { valueKind: "nonNegativeInteger"; maximum: number | null };

export const EDITABLE_FIELD_POLICY = {
  prefix: { valueKind: "text", maxLength: 32 },
  firstName: { valueKind: "text", maxLength: 256 },
  middleName: { valueKind: "text", maxLength: 256 },
  lastName: { valueKind: "text", maxLength: 256 },
  suffix: { valueKind: "text", maxLength: 32 },
  organizationName: { valueKind: "text", maxLength: 512 },
  displayName: { valueKind: "text", maxLength: 512 },
  notes: { valueKind: "text", maxLength: null },
  registrationNumber: { valueKind: "text", maxLength: 64 },
  taxId: { valueKind: "text", maxLength: 64 },
  defaultHourlyRate: { valueKind: "nonNegativeInteger", maximum: null },
  currency: { valueKind: "text", maxLength: 3 },
  paymentTermDays: { valueKind: "nonNegativeInteger", maximum: 365 },
} as const satisfies Record<EditableField, EditableFieldPolicy>;

type NumericEditableField = {
  [Field in EditableField]: (typeof EDITABLE_FIELD_POLICY)[Field]["valueKind"] extends "nonNegativeInteger"
    ? Field
    : never;
}[EditableField];

type TextEditableField = Exclude<EditableField, NumericEditableField>;

export const isNumericEditableField = (
  field: EditableField,
): field is NumericEditableField =>
  EDITABLE_FIELD_POLICY[field].valueKind === "nonNegativeInteger";

export const getEditableFieldInputAttributes = (field: EditableField) => {
  if (EDITABLE_FIELD_POLICY[field].valueKind === "nonNegativeInteger") {
    return { type: "text", inputMode: "numeric" } as const;
  }
  return { type: "text" } as const;
};

type NumericContactPayload =
  | { defaultHourlyRate: number | null }
  | { paymentTermDays: number | null };

type NumericContactPayloadResult =
  | { status: "valid"; payload: NumericContactPayload }
  | { status: "invalid" };

const NON_NEGATIVE_INTEGER_TOKEN = /^[0-9]+$/u;

const buildNumericPayload = (
  field: NumericEditableField,
  value: number | null,
): NumericContactPayload => {
  switch (field) {
    case "defaultHourlyRate":
      return { defaultHourlyRate: value };
    case "paymentTermDays":
      return { paymentTermDays: value };
    default:
      field satisfies never;
      return panic(`Unhandled field: ${String(field)}`);
  }
};

export const buildNumericContactPayload = (
  field: NumericEditableField,
  trimmedInput: string,
): NumericContactPayloadResult => {
  if (trimmedInput === "") {
    return {
      status: "valid",
      payload: buildNumericPayload(field, null),
    };
  }

  if (!NON_NEGATIVE_INTEGER_TOKEN.test(trimmedInput)) {
    return { status: "invalid" };
  }

  const value = Number(trimmedInput);
  const policy = EDITABLE_FIELD_POLICY[field];
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (policy.maximum !== null && value > policy.maximum)
  ) {
    return { status: "invalid" };
  }

  return {
    status: "valid",
    payload: buildNumericPayload(field, value),
  };
};

export const buildTextContactPayload = (
  field: TextEditableField,
  value: string,
): ContactUpdate => {
  switch (field) {
    case "currency":
      return { currency: value || null };
    case "displayName":
      return { displayName: value };
    case "firstName":
      return { firstName: value || null };
    case "lastName":
      return { lastName: value || null };
    case "middleName":
      return { middleName: value || null };
    case "notes":
      return { notes: value || null };
    case "organizationName":
      return { organizationName: value || null };
    case "prefix":
      return { prefix: value || null };
    case "registrationNumber":
      return { registrationNumber: value || null };
    case "suffix":
      return { suffix: value || null };
    case "taxId":
      return { taxId: value || null };
    default:
      field satisfies never;
      return panic(`Unhandled field: ${String(field)}`);
  }
};
