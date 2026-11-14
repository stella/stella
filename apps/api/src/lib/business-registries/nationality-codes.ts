import * as v from "valibot";

import { MAX_CONTACT_NATIONALITY_CODES } from "@stll/api-contract/contact-write";

import { uniqueItems } from "@/api/lib/custom-schema";

export const nationalityCodesSchema = v.pipe(
  v.array(v.pipe(v.string(), v.regex(/^[A-Z]{2}$/u))),
  v.maxLength(MAX_CONTACT_NATIONALITY_CODES),
  uniqueItems(),
);
