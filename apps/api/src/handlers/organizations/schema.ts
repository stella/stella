import * as v from "valibot";

import { ORGANIZATION_NAME_MAX_LENGTH } from "@stll/api-contract/organization-create";
import { ORGANIZATION_SLUG_RULES } from "@stll/auth-model";

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
      v.maxLength(ORGANIZATION_SLUG_RULES.maxLength),
      v.regex(ORGANIZATION_SLUG_RULES.pattern),
      v.description(
        "Optional URL slug. Omit to generate an opaque organization address.",
      ),
    ),
  ),
});
