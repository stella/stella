import * as v from "valibot";

import {
  ORGANIZATION_NAME_MAX_LENGTH,
  ORGANIZATION_SLUG_MAX_LENGTH,
  ORGANIZATION_SLUG_PATTERN,
} from "@stll/api-contract/organization-create";

export const organizationCreateBodySchema = v.strictObject({
  name: v.pipe(
    v.string(),
    v.trim(),
    v.nonEmpty(),
    v.maxLength(ORGANIZATION_NAME_MAX_LENGTH),
    v.description("Name of the new organization."),
  ),
  slug: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.nonEmpty(),
      v.maxLength(ORGANIZATION_SLUG_MAX_LENGTH),
      v.regex(ORGANIZATION_SLUG_PATTERN),
      v.description(
        "Optional URL slug. Omit to generate an opaque organization address.",
      ),
    ),
  ),
});
