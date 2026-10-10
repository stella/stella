import { panic } from "better-result";

import { tryToMinorUnits } from "@stll/money";

import {
  majorUnitInput,
  normalizeMajorUnitInput,
} from "@/components/billing/amount-input.logic";
import type { ContactUpdate } from "@/lib/contacts/mutations";
import type { EditableField } from "@/routes/_protected.contacts/-components/types";

type EditableFieldPolicy =
  | { valueKind: "text"; maxLength: number | null }
  | { valueKind: "nonNegativeInteger"; maximum: number }
  | { valueKind: "money" };

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
  defaultHourlyRate: { valueKind: "money" },
  currency: { valueKind: "text", maxLength: 3 },
  paymentTermDays: { valueKind: "nonNegativeInteger", maximum: 365 },
} as const satisfies Record<EditableField, EditableFieldPolicy>;

type NumericEditableField = {
  [
    Field in EditableField
  ]: (typeof EDITABLE_FIELD_POLICY)[Field]["valueKind"] extends "nonNegativeInteger"
    ? Field
    : never;
}[EditableField];

type TextEditableField = {
  [
    Field in EditableField
  ]: (typeof EDITABLE_FIELD_POLICY)[Field]["valueKind"] extends "text"
    ? Field
    : never;
}[EditableField];

export const isNumericEditableField = (
  field: EditableField,
): field is NumericEditableField =>
  EDITABLE_FIELD_POLICY[field].valueKind === "nonNegativeInteger";

export const getEditableFieldInputAttributes = (field: EditableField) => {
  const { valueKind } = EDITABLE_FIELD_POLICY[field];
  switch (valueKind) {
    case "money":
      return { type: "text", inputMode: "decimal" } as const;
    case "nonNegativeInteger":
      return { type: "text", inputMode: "numeric" } as const;
    case "text":
      return { type: "text" } as const;
    default:
      valueKind satisfies never;
      return panic(`Unhandled input kind: ${String(valueKind)}`);
  }
};

type NumericContactPayload = { paymentTermDays: number | null };

type NumericContactPayloadResult =
  | { status: "valid"; payload: NumericContactPayload }
  | { status: "invalid" };

const NON_NEGATIVE_INTEGER_TOKEN = /^[0-9]+$/u;

const NUMERIC_PAYLOAD_BUILDERS = {
  paymentTermDays: (value) => ({ paymentTermDays: value }),
} as const satisfies Record<
  NumericEditableField,
  (value: number | null) => NumericContactPayload
>;

const buildNumericPayload = (
  field: NumericEditableField,
  value: number | null,
): NumericContactPayload => NUMERIC_PAYLOAD_BUILDERS[field](value);

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
  if (!Number.isSafeInteger(value) || value < 0 || value > policy.maximum) {
    return { status: "invalid" };
  }

  return {
    status: "valid",
    payload: buildNumericPayload(field, value),
  };
};

// Without a currency there is no unit scale for displaying or setting a rate.
export const contactRateInput = (
  amount: number | null,
  currency: string | null,
): string | null =>
  amount === null || !currency ? null : majorUnitInput(amount, currency);

type ContactRatePayloadOptions = {
  trimmedInput: string;
  currency: string | null;
  locale: string;
};

export const buildContactRatePayload = ({
  trimmedInput,
  currency,
  locale,
}: ContactRatePayloadOptions) => {
  if (trimmedInput === "") {
    return { status: "valid", payload: { defaultHourlyRate: null } } as const;
  }
  if (!currency || trimmedInput.startsWith("-")) {
    return { status: "invalid" } as const;
  }
  const canonicalInput = normalizeMajorUnitInput({
    input: trimmedInput,
    locale,
  });
  if (canonicalInput === null) {
    return { status: "invalid" } as const;
  }
  const amount = tryToMinorUnits({ amount: canonicalInput, currency });
  if (amount === null || amount < 0) {
    return { status: "invalid" } as const;
  }
  return { status: "valid", payload: { defaultHourlyRate: amount } } as const;
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
