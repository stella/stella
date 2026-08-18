import * as v from "valibot";

import { CONTACT_TYPES } from "./workspace-contacts";

export const CONTACT_IMPORT_SCHEMA_VERSION = 1 as const;
export const CONTACT_IMPORT_MAX_COLUMNS = 100;
export const CONTACT_IMPORT_MAX_ROWS = 500;

export const CONTACT_IMPORT_FIELDS = [
  "type",
  "display_name",
  "prefix",
  "first_name",
  "middle_name",
  "last_name",
  "suffix",
  "organization_name",
  "primary_email",
  "primary_phone",
  "address_line_1",
  "address_line_2",
  "city",
  "state",
  "postal_code",
  "country",
  "notes",
  "tags",
  "registration_number",
  "tax_id",
] as const;

export type ContactImportField = (typeof CONTACT_IMPORT_FIELDS)[number];

export const CONTACT_IMPORT_IGNORE_DESTINATION = "ignore" as const;

/**
 * Destination for a column that has no first-class contact field: the cell
 * lands in `metadata.customFields` under the source column's own label.
 * Unlike a first-class field, several columns may target it in one mapping.
 */
export const CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION = "custom_field" as const;

/**
 * Which validator, if any, the batch's tax ids must satisfy. `br_cpf_cnpj`
 * checks CPF/CNPJ checksums, stores the bare digits, and derives (or
 * cross-checks) the contact type from the number's kind; `none` keeps the
 * value as given.
 */
export const CONTACT_IMPORT_TAX_ID_SCHEMES = ["none", "br_cpf_cnpj"] as const;

export type ContactImportTaxIdScheme =
  (typeof CONTACT_IMPORT_TAX_ID_SCHEMES)[number];

export const CONTACT_IMPORT_ISSUE_CODE = {
  ADDRESS_LINE_REQUIRED: "address_line_required",
  DISPLAY_NAME_REQUIRED: "display_name_required",
  INVALID_EMAIL: "invalid_email",
  INVALID_PHONE: "invalid_phone",
  INVALID_TAGS: "invalid_tags",
  INVALID_TAX_ID: "invalid_tax_id",
  INVALID_TYPE: "invalid_type",
  ROW_LENGTH_MISMATCH: "row_length_mismatch",
  TAX_ID_REQUIRED: "tax_id_required",
  TOO_LONG: "too_long",
  TOO_MANY_TAGS: "too_many_tags",
} as const;

export type ContactImportIssueCode =
  (typeof CONTACT_IMPORT_ISSUE_CODE)[keyof typeof CONTACT_IMPORT_ISSUE_CODE];

export const CONTACT_IMPORT_TARGET_FIELDS = [
  ...CONTACT_IMPORT_FIELDS,
  CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION,
  CONTACT_IMPORT_IGNORE_DESTINATION,
] as const;

export type ContactImportTargetField =
  (typeof CONTACT_IMPORT_TARGET_FIELDS)[number];

const contactImportColumnMappingSchema = v.strictObject({
  sourceIndex: v.pipe(v.number(), v.integer(), v.minValue(0)),
  targetField: v.picklist(CONTACT_IMPORT_TARGET_FIELDS),
});

const contactImportMappingSchema = v.pipe(
  v.strictObject({
    version: v.literal(CONTACT_IMPORT_SCHEMA_VERSION),
    defaultType: v.picklist(CONTACT_TYPES),
    generateDisplayName: v.boolean(),
    taxIdScheme: v.picklist(CONTACT_IMPORT_TAX_ID_SCHEMES),
    columns: v.pipe(
      v.array(contactImportColumnMappingSchema),
      v.maxLength(CONTACT_IMPORT_MAX_COLUMNS),
    ),
  }),
  v.check(
    ({ columns }) =>
      new Set(columns.map(({ sourceIndex }) => sourceIndex)).size ===
      columns.length,
    "Source column indexes must be unique",
  ),
);

export type ContactImportColumnMapping = v.InferOutput<
  typeof contactImportColumnMappingSchema
>;
export type ContactImportMapping = v.InferOutput<
  typeof contactImportMappingSchema
>;

export type ContactImportMappingParseResult =
  | {
      success: true;
      mapping: ContactImportMapping;
    }
  | {
      success: false;
      issues: readonly v.BaseIssue<unknown>[];
    };

export const parseContactImportMapping = (
  input: unknown,
): ContactImportMappingParseResult => {
  const result = v.safeParse(contactImportMappingSchema, input);
  if (!result.success) {
    return { success: false, issues: result.issues };
  }
  return { success: true, mapping: result.output };
};
