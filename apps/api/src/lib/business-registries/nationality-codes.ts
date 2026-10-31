import * as v from "valibot";

import { uniqueItems } from "@/api/lib/custom-schema";

export const MAX_CONTACT_NATIONALITY_CODES = 250;

export const nationalityCodesSchema = v.pipe(
  v.array(v.pipe(v.string(), v.regex(/^[A-Z]{2}$/u))),
  v.maxLength(MAX_CONTACT_NATIONALITY_CODES),
  uniqueItems(),
);
