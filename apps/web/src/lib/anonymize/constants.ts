/**
 * Default entity labels supported by the anonymization pipeline.
 * These are hardcoded here to avoid pulling in the heavy WASM
 * entry point just for constants.
 */
export const DEFAULT_ENTITY_LABELS = [
  "person",
  "organization",
  "phone number",
  "address",
  "email address",
  "date",
  "date of birth",
  "bank account number",
  "iban",
  "tax identification number",
  "identity card number",
  "registration number",
  "credit card number",
  "passport number",
  "monetary amount",
  "land parcel",
] as const;
