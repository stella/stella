import { t } from "elysia";

export const MAX_CONTACT_NATIONALITY_CODES = 250;

export const nationalityCodesSchema = t.Array(
  t.String({ pattern: "^[A-Z]{2}$" }),
  { maxItems: MAX_CONTACT_NATIONALITY_CODES, uniqueItems: true },
);
