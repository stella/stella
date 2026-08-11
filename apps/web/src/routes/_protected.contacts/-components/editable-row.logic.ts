import type { EditableField } from "@/routes/_protected.contacts/-components/types";

type EditableFieldPolicy =
  | { inputType: "text"; maxLength: number | null }
  | { inputType: "number"; maximum: number | null };

export const EDITABLE_FIELD_POLICY = {
  prefix: { inputType: "text", maxLength: 32 },
  firstName: { inputType: "text", maxLength: 256 },
  middleName: { inputType: "text", maxLength: 256 },
  lastName: { inputType: "text", maxLength: 256 },
  suffix: { inputType: "text", maxLength: 32 },
  organizationName: { inputType: "text", maxLength: 512 },
  displayName: { inputType: "text", maxLength: 512 },
  notes: { inputType: "text", maxLength: null },
  registrationNumber: { inputType: "text", maxLength: 64 },
  taxId: { inputType: "text", maxLength: 64 },
  defaultHourlyRate: { inputType: "number", maximum: null },
  currency: { inputType: "text", maxLength: 3 },
  paymentTermDays: { inputType: "number", maximum: 365 },
} as const satisfies Record<EditableField, EditableFieldPolicy>;

type NumericEditableField = {
  [Field in EditableField]: (typeof EDITABLE_FIELD_POLICY)[Field]["inputType"] extends "number"
    ? Field
    : never;
}[EditableField];

export const isNumericEditableField = (
  field: EditableField,
): field is NumericEditableField =>
  EDITABLE_FIELD_POLICY[field].inputType === "number";

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
      return field satisfies never;
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
