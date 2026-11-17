import * as v from "valibot";

import { UUID_PATTERN } from "@stll/uuid-codec";

const canonicalizeCase = v.toLowerCase();

/** Runtime transformation that preserves the UUID wire schema when published. */
export const UUID_RUNTIME_ONLY_ACTIONS = [canonicalizeCase] as const;

/** A UUID in canonical lowercase form. Validation preserves the API's 36-character UUID wire shape. */
export const uuidSchema = v.pipe(
  v.string(),
  v.length(36),
  v.regex(new RegExp(UUID_PATTERN, "u")),
  canonicalizeCase,
);
